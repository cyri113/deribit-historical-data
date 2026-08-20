import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import { JSONLStorage } from "../../src/infrastructure/jsonl-storage.ts";
import { ParquetWriter } from "../../src/infrastructure/parquet-writer.ts";
import type { DeribitTrade, DeliveryPrice } from "../../src/domain/models.ts";
import parquet from "parquetjs";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * ParquetWriter Integration Tests
 *
 * Tests the enrichment pipeline that reads trades and creates analytics Parquet files.
 *
 * Note: ParquetWriter currently reads from JSONL for backwards compatibility.
 * In the new hybrid architecture, raw Parquet files are created automatically during fetch,
 * and ParquetWriter is used for optional enrichment with Greeks.
 */
describe("ParquetWriter Integration Tests", () => {
  let db: Database;
  let storage: JSONLStorage;
  let writer: ParquetWriter;
  const testDbPath = ":memory:";
  const testJsonlDir = "./test-data/jsonl-test";
  const testParquetDir = "./test-data/parquet-test";

  beforeAll(async () => {
    db = new Database(testDbPath);
    storage = new JSONLStorage(testJsonlDir);
    writer = new ParquetWriter({
      database: db,
      jsonlStorage: storage,
      outputDir: testParquetDir,
    });

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    db.close();
    await storage.closeAll();

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  test("enrichInstrument creates Parquet file with correct schema", async () => {
    const instrumentName = "BTC-10AUG26-65000-C";

    // Setup: Create JSONL trades
    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "test-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 0.0024,
        mark_price: 0.00246,
        instrument_name: instrumentName,
        index_price: 65150,
        direction: "buy",
        amount: 0.5,
        iv: 19.06,
      },
      {
        trade_seq: 2,
        trade_id: "test-2",
        timestamp: 1723271000000,
        tick_direction: 2,
        price: 0.0025,
        mark_price: 0.00251,
        instrument_name: instrumentName,
        index_price: 65200,
        direction: "sell",
        amount: 1.0,
        iv: 18.5,
      },
    ];

    await storage.appendTrades(instrumentName, trades);

    // Setup: Add delivery price
    const deliveryPrice: DeliveryPrice = {
      indexName: "btc_usd",
      date: new Date("2026-08-10T00:00:00Z").getTime(),
      deliveryPrice: 65240.61,
    };
    db.insertDeliveryPrices([deliveryPrice]);

    // Setup: Register instrument
    db.upsertInstruments([
      {
        instrument_name: instrumentName,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-08-10T08:00:00Z").getTime(),
        strike: 65000,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Execute: Enrich instrument
    const result = await writer.enrichInstrument(instrumentName);

    // Verify: Enrichment result
    expect(result.instrumentName).toBe(instrumentName);
    expect(result.totalTrades).toBe(2);
    expect(result.enrichedTrades).toBe(2);

    // Verify: Parquet file exists
    const parquetPath = `${testParquetDir}/BTC/${instrumentName}.parquet`;
    expect(existsSync(parquetPath)).toBe(true);

    // Verify: Read Parquet file and check schema
    const reader = await parquet.ParquetReader.openFile(parquetPath);
    const cursor = reader.getCursor();

    const firstRow = await cursor.next();
    expect(firstRow).toBeDefined();

    // Verify: Trade data fields
    expect(firstRow.trade_id).toBe("test-1");
    expect(firstRow.trade_seq).toBe(1);
    expect(firstRow.instrument_name).toBe(instrumentName);
    expect(firstRow.price).toBe(0.0024);
    expect(firstRow.amount).toBe(0.5);
    expect(firstRow.direction).toBe("buy");

    // Verify: Instrument metadata fields
    expect(firstRow.strike).toBe(65000);
    expect(firstRow.option_type).toBe("call");
    expect(firstRow.expiration_timestamp).toBeDefined();

    // Verify: Greeks computed with realistic ranges
    expect(firstRow.delta).toBeDefined();
    expect(typeof firstRow.delta).toBe("number");
    expect(firstRow.delta).toBeGreaterThan(0); // Calls have positive delta
    expect(firstRow.delta).toBeLessThan(1); // Delta is between 0 and 1

    expect(firstRow.gamma).toBeDefined();
    expect(firstRow.gamma).toBeGreaterThan(0); // Gamma is always positive

    expect(firstRow.vega).toBeDefined();
    expect(firstRow.vega).toBeGreaterThan(0); // Vega is always positive

    expect(firstRow.theta).toBeDefined();
    expect(firstRow.theta).toBeLessThan(0); // Theta is negative (time decay)
    expect(firstRow.theta).toBeGreaterThan(-100); // Reasonable daily decay

    expect(firstRow.theoretical_price).toBeDefined();
    expect(firstRow.theoretical_price).toBeGreaterThan(0);
    // Theoretical price in BTC (2-year ATM option ~10% of underlying)
    expect(firstRow.theoretical_price).toBeGreaterThan(0.05); // > 5% of 1 BTC
    expect(firstRow.theoretical_price).toBeLessThan(0.20);   // < 20% of 1 BTC

    // Verify: Moneyness calculated
    expect(firstRow.delivery_price).toBe(65240.61);
    expect(firstRow.moneyness).toBe("ATM");
    expect(firstRow.intrinsic_value).toBeCloseTo(240.61, 1);
    expect(firstRow.moneyness_percentage).toBeDefined();

    // Verify: Trading Metrics calculated

    // 1. Annualized Premium Yield
    expect(firstRow.annualized_premium_yield).toBeDefined();
    expect(typeof firstRow.annualized_premium_yield).toBe("number");
    expect(firstRow.annualized_premium_yield).toBeGreaterThan(0); // Positive yield

    // 2. IV Rank (52-Week Percentile)
    // First trade has no history, so IV rank should be undefined
    expect(firstRow.iv_rank_52w).toBeUndefined();
    expect(firstRow.iv_52w_high).toBeUndefined();
    expect(firstRow.iv_52w_low).toBeUndefined();
    expect(firstRow.iv_52w_mean).toBeUndefined();
    expect(firstRow.iv_52w_stddev).toBeUndefined();

    // 3. Expected Value (Stress Scenarios)
    expect(firstRow.expected_value_btc).toBeDefined();
    expect(typeof firstRow.expected_value_btc).toBe("number");
    expect(firstRow.win_probability).toBeDefined();
    expect(firstRow.win_probability).toBeGreaterThan(0);
    expect(firstRow.win_probability).toBeLessThan(100);
    expect(firstRow.max_loss_btc).toBeDefined();
    expect(firstRow.max_loss_btc).toBeLessThan(0); // Can lose money
    expect(firstRow.max_gain_btc).toBeDefined();
    expect(firstRow.max_gain_btc).toBeGreaterThan(0);
    expect(firstRow.sharpe_ratio).toBeDefined();

    await reader.close();
  });

  test("enrichInstrument handles missing delivery price gracefully", async () => {
    const instrumentName = "BTC-15AUG26-70000-P";

    // Setup: Create JSONL trades (NO delivery price)
    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "test-3",
        timestamp: 1723900000000,
        tick_direction: 1,
        price: 0.0030,
        mark_price: 0.00305,
        instrument_name: instrumentName,
        index_price: 68000,
        direction: "buy",
        amount: 2.0,
        iv: 25.0,
      },
    ];

    await storage.appendTrades(instrumentName, trades);

    // Setup: Register instrument (but no delivery price)
    db.upsertInstruments([
      {
        instrument_name: instrumentName,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-08-15T08:00:00Z").getTime(),
        strike: 70000,
        option_type: "put",
        is_active: false,
      },
    ]);

    // Execute: Enrich instrument
    const result = await writer.enrichInstrument(instrumentName);

    expect(result.enrichedTrades).toBe(1);

    // Verify: Parquet file has null moneyness fields
    const parquetPath = `${testParquetDir}/BTC/${instrumentName}.parquet`;
    const reader = await parquet.ParquetReader.openFile(parquetPath);
    const cursor = reader.getCursor();
    const row = await cursor.next();

    // Greeks should still be computed
    expect(row.delta).toBeDefined();
    expect(row.gamma).toBeDefined();

    // Moneyness should be undefined (Parquet optional fields)
    expect(row.delivery_price).toBeUndefined();
    expect(row.moneyness).toBeUndefined();
    expect(row.intrinsic_value).toBeUndefined();
    expect(row.moneyness_percentage).toBeUndefined();

    await reader.close();
  });

  test("enrichInstrument handles trades without IV gracefully", async () => {
    const instrumentName = "BTC-20AUG26-75000-C";

    // Setup: Create JSONL trades WITHOUT implied volatility
    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "test-4",
        timestamp: 1724200000000,
        tick_direction: 1,
        price: 0.0010,
        instrument_name: instrumentName,
        index_price: 72000,
        direction: "buy",
        amount: 0.1,
        // No IV field
      },
    ];

    await storage.appendTrades(instrumentName, trades);

    // Setup: Register instrument
    db.upsertInstruments([
      {
        instrument_name: instrumentName,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-08-20T08:00:00Z").getTime(),
        strike: 75000,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Execute: Enrich instrument
    const result = await writer.enrichInstrument(instrumentName);

    expect(result.enrichedTrades).toBe(1);

    // Verify: Greeks are null when IV missing
    const parquetPath = `${testParquetDir}/BTC/${instrumentName}.parquet`;
    const reader = await parquet.ParquetReader.openFile(parquetPath);
    const cursor = reader.getCursor();
    const row = await cursor.next();

    expect(row.implied_volatility).toBeUndefined();
    expect(row.delta).toBeUndefined();
    expect(row.gamma).toBeUndefined();
    expect(row.vega).toBeUndefined();
    expect(row.theta).toBeUndefined();
    expect(row.theoretical_price).toBeUndefined();

    await reader.close();
  });

  test("enrichInstrument returns early for empty JSONL", async () => {
    const instrumentName = "BTC-25AUG26-80000-P";

    // Setup: Register instrument but no trades
    db.upsertInstruments([
      {
        instrument_name: instrumentName,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-08-25T08:00:00Z").getTime(),
        strike: 80000,
        option_type: "put",
        is_active: false,
      },
    ]);

    // Execute: Enrich instrument with no trades
    const result = await writer.enrichInstrument(instrumentName);

    // Verify: Returns zero trades
    expect(result.totalTrades).toBe(0);
    expect(result.enrichedTrades).toBe(0);

    // Verify: No Parquet file created
    const parquetPath = `${testParquetDir}/BTC/${instrumentName}.parquet`;
    expect(existsSync(parquetPath)).toBe(false);
  });

  test("enrichMultipleInstruments processes batch correctly", async () => {
    const instruments = [
      "BTC-30AUG26-60000-C",
      "BTC-30AUG26-65000-C",
      "BTC-30AUG26-70000-C",
    ];

    // Setup: Create trades for all instruments
    for (const instrumentName of instruments) {
      const trades: DeribitTrade[] = [
        {
          trade_seq: 1,
          trade_id: `${instrumentName}-1`,
          timestamp: 1724500000000,
          tick_direction: 1,
          price: 0.002,
          instrument_name: instrumentName,
          index_price: 65000,
          direction: "buy",
          amount: 1.0,
          iv: 20.0,
        },
      ];
      await storage.appendTrades(instrumentName, trades);

      const strike = parseInt(instrumentName.split("-")[2]!);
      db.upsertInstruments([
        {
          instrument_name: instrumentName,
          kind: "option",
          base_currency: "BTC",
          expiration_timestamp: new Date("2026-08-30T08:00:00Z").getTime(),
          strike,
          option_type: "call",
          is_active: false,
        },
      ]);
    }

    // Execute: Enrich multiple instruments
    const results = await writer.enrichMultipleInstruments(instruments);

    // Verify: All instruments processed
    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result.enrichedTrades).toBe(1);
    }

    // Verify: All Parquet files created
    for (const instrumentName of instruments) {
      const parquetPath = `${testParquetDir}/BTC/${instrumentName}.parquet`;
      expect(existsSync(parquetPath)).toBe(true);
    }
  });
});
