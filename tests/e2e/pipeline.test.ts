import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import { GreeksCalculator } from "../../src/application/analytics/greeks-calculator.ts";
import { RiskFilters, PresetFilters } from "../../src/application/filters/risk-filters.ts";
import type { Trade } from "../../src/domain/models.ts";

/**
 * E2E Pipeline Test
 *
 * This test demonstrates the full pipeline without requiring live API access:
 * 1. Insert mock trade data
 * 2. Calculate greeks from trades
 * 3. Apply risk filters
 *
 * Note: For a true E2E test with live data, run:
 * bun src/cli/index.ts fetch-trades <instrument> <months>
 */
describe("E2E Pipeline Test", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("Full pipeline: Trades → Greeks → Filters", async () => {
    // Step 1: Insert mock trade data
    const instrumentName = "BTC-29MAR24-50000-C";
    const expiration = new Date(Date.UTC(2024, 2, 29, 8, 0, 0)).getTime();
    const baseTime = expiration - 7 * 24 * 60 * 60 * 1000; // 7 days before expiry

    const mockTrades: Trade[] = Array.from({ length: 100 }, (_, i) => ({
      id: `trade-${i}`,
      instrumentName,
      price: 2000 + i * 10, // Increasing option price
      amount: 0.5,
      direction: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
      timestamp: baseTime + i * 3600000, // 1 hour apart
      indexPrice: 51000 + i * 10, // Increasing underlying price
      markPrice: 2000 + i * 10,
      impliedVolatility: 0.75 + i * 0.001, // Slightly increasing IV
    }));

    console.log(`\n📊 Step 1: Inserting ${mockTrades.length} mock trades...`);
    db.insertTrades(mockTrades);

    const insertedCount = db.getTradeCount(instrumentName);
    expect(insertedCount).toBe(100);
    console.log(`✓ Inserted ${insertedCount} trades`);

    // Step 2: Calculate greeks from trades
    console.log(`\n🧮 Step 2: Computing greeks...`);
    const calculator = new GreeksCalculator({ database: db });

    const progress = await calculator.calculateForInstrument(instrumentName);

    expect(progress.totalCalculated).toBe(100);
    console.log(`✓ Calculated greeks for ${progress.totalCalculated} trades`);

    const greeksSummary = calculator.getGreeksSummary(instrumentName);
    expect(greeksSummary).not.toBeNull();
    console.log(`\nGreeks Summary:`);
    console.log(`  Delta range: ${greeksSummary!.delta.min.toFixed(4)} to ${greeksSummary!.delta.max.toFixed(4)}`);
    console.log(`  Gamma range: ${greeksSummary!.gamma.min.toFixed(6)} to ${greeksSummary!.gamma.max.toFixed(6)}`);
    console.log(`  Vega range: ${greeksSummary!.vega.min.toFixed(2)} to ${greeksSummary!.vega.max.toFixed(2)}`);
    console.log(`  Theta range: ${greeksSummary!.theta.min.toFixed(2)} to ${greeksSummary!.theta.max.toFixed(2)}`);

    // Verify greeks are reasonable
    expect(greeksSummary!.delta.min).toBeGreaterThan(0); // Call delta is positive
    expect(greeksSummary!.delta.max).toBeLessThan(1); // Delta can't exceed 1
    expect(greeksSummary!.gamma.min).toBeGreaterThan(0); // Gamma is always positive
    expect(greeksSummary!.theta.max).toBeLessThan(0); // Theta is negative for long options

    // Step 3: Apply risk filters
    console.log(`\n🔍 Step 3: Applying risk filters...`);
    const riskFilters = new RiskFilters({ database: db });

    // Test conservative filter
    const conservativeStats = riskFilters.getFilterStats(
      instrumentName,
      PresetFilters.btcConservative
    );

    console.log(`\nConservative Filter Results:`);
    console.log(`  Total: ${conservativeStats.total}`);
    console.log(`  Passed: ${conservativeStats.passed}`);
    console.log(`  Failed: ${conservativeStats.failed}`);
    console.log(`  Pass rate: ${(conservativeStats.passRate * 100).toFixed(1)}%`);

    expect(conservativeStats.total).toBe(100);
    // Conservative filter may be very restrictive, so check it ran
    expect(conservativeStats.passed + conservativeStats.failed).toBe(100);

    // Test high delta filter
    const highDeltaStats = riskFilters.getFilterStats(
      instrumentName,
      PresetFilters.highDeltaCalls
    );

    console.log(`\nHigh Delta Calls Filter Results:`);
    console.log(`  Total: ${highDeltaStats.total}`);
    console.log(`  Passed: ${highDeltaStats.passed}`);
    console.log(`  Pass rate: ${(highDeltaStats.passRate * 100).toFixed(1)}%`);

    // Some trades should have high delta (as underlying price increases)
    expect(highDeltaStats.passed).toBeGreaterThan(0);

    // Get actual passing greeks
    const passingGreeks = riskFilters.getPassingGreeks(
      instrumentName,
      PresetFilters.highDeltaCalls
    );

    console.log(`\n✓ Pipeline completed successfully!`);
    console.log(`  ${passingGreeks.length} greeks passed high delta filter`);

    // Verify all passing greeks meet criteria
    for (const greeks of passingGreeks) {
      expect(greeks.delta).toBeGreaterThanOrEqual(0.6);
      expect(greeks.delta).toBeLessThanOrEqual(1.0);
    }
  });

  test("Filter with moneyness (simulated)", () => {
    const instrumentName = "BTC-29MAR24-50000-C";
    const strike = 50000;
    const deliveryPrice = 55000; // Expired ITM

    // Insert mock greeks
    const mockGreeks = Array.from({ length: 50 }, (_, i) => ({
      instrumentName,
      timestamp: Date.now() + i * 1000,
      delta: 0.3 + i * 0.01,
      gamma: 0.0001,
      vega: 30,
      theta: -10,
      price: 1500 + i * 10,
      underlyingPrice: 52000,
      impliedVolatility: 0.8,
    }));

    db.insertGreeks(mockGreeks);

    const riskFilters = new RiskFilters({ database: db });

    // Apply ITM-only filter with delivery price
    const results = riskFilters.filterInstrument(
      instrumentName,
      PresetFilters.itmOnly,
      deliveryPrice
    );

    // All should pass since delivery > strike for a call
    const passed = results.filter((r) => r.passed);
    expect(passed.length).toBe(50);

    console.log(`\n✓ Moneyness filter test passed: ${passed.length}/50 ITM`);
  });

  test("Performance: Large dataset", () => {
    console.log(`\n⚡ Performance test with large dataset...`);

    const instrumentName = "BTC-PERPETUAL";

    // Insert 10k trades
    const largeBatch: Trade[] = Array.from({ length: 10000 }, (_, i) => ({
      id: `perf-trade-${i}`,
      instrumentName,
      price: 50000 + i,
      amount: 1.0,
      direction: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
      timestamp: Date.now() + i * 1000,
      indexPrice: 50000,
    }));

    const insertStart = performance.now();
    db.insertTrades(largeBatch);
    const insertDuration = performance.now() - insertStart;

    console.log(`  Insert 10k trades: ${insertDuration.toFixed(2)}ms`);
    expect(insertDuration).toBeLessThan(1000); // Should be < 1 second

    // Query performance
    const queryStart = performance.now();
    const trades = db.getTrades(instrumentName);
    const queryDuration = performance.now() - queryStart;

    console.log(`  Query 10k trades: ${queryDuration.toFixed(2)}ms`);
    expect(trades).toHaveLength(10000);
    expect(queryDuration).toBeLessThan(100); // Should be < 100ms

    console.log(`✓ Performance test passed`);
  });
});
