import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldEnricher } from "../../src/application/analytics/gold-enricher.ts";
import { initializeDuckDB, executeSQLStatement, executeSQLQuery, closeDuckDB } from "../../src/infrastructure/duckdb-connection.ts";

describe("GoldEnricher (executed against real DuckDB with synthetic fixtures)", () => {
  let workDir: string;
  let silverDir: string;
  let goldDir: string;
  let deliveryDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "gold-enricher-test-"));
    silverDir = join(workDir, "silver");
    goldDir = join(workDir, "gold");
    deliveryDir = join(workDir, "deliveries");
    mkdirSync(silverDir, { recursive: true });
    mkdirSync(deliveryDir, { recursive: true });

    await initializeDuckDB();

    // Two instruments, BTC-1JAN24-50000-C (expires 2024-01-01, strike 50000, call)
    // and BTC-1JAN24-50000-P (put, same expiry/strike), each with a handful of
    // trades spread across time so window functions have something to chew on.
    // Settlement (delivery) price on 2024-01-01 is 55000 -- so the call is ITM
    // (55000 > 50000) and the put is OTM (55000 is not < 50000).
    await executeSQLStatement(`
      COPY (
        SELECT * FROM (VALUES
          ('BTC-1JAN24-50000-C', 't1', 1, TIMESTAMP '2023-12-25 00:00:00', 0.05, 1.0, 'buy', 0, 54000.0, 54100.0, 60.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'call', 0.02, 54000.0, 0.6, 0.0001, 10.0, -5.0, true),
          ('BTC-1JAN24-50000-C', 't2', 2, TIMESTAMP '2023-12-27 00:00:00', 0.052, 1.0, 'buy', 0, 54500.0, 54600.0, 61.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'call', 0.014, 54500.0, 0.62, 0.0001, 9.0, -5.0, true),
          ('BTC-1JAN24-50000-C', 't3', 3, TIMESTAMP '2023-12-30 00:00:00', 0.06, 2.0, 'sell', 2, 55000.0, 55100.0, 65.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'call', 0.003, 55000.0, 0.7, 0.0001, 8.0, -5.0, true),
          ('BTC-1JAN24-50000-P', 'u1', 1, TIMESTAMP '2023-12-25 00:00:00', 0.01, 1.0, 'buy', 0, 54000.0, 53900.0, 55.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'put', 0.02, 54000.0, -0.15, 0.0001, 7.0, -3.0, true),
          ('BTC-1JAN24-50000-P', 'u2', 2, TIMESTAMP '2023-12-28 00:00:00', 0.009, 1.0, 'sell', 1, 54800.0, 54700.0, 50.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'put', 0.009, 54800.0, -0.12, 0.0001, 6.0, -3.0, true),
          -- Deep-OTM call, seconds from expiry, priced at Deribit's minimum
          -- tick (0.0001 BTC) -- mirrors a real production outlier where
          -- Black-76 correctly returns a near-zero theoretical price but the
          -- market price floor doesn't shrink below the tick, blowing up
          -- (price*amount)/expected_premium to ~1e+185.
          ('BTC-1JAN24-66000-C', 'v1', 1, TIMESTAMP '2023-12-31 23:59:55', 0.0001, 0.7, 'buy', 0, 65192.5, 65192.5, 6.84, 66000.0, TIMESTAMP '2024-01-01 08:00:00', 'call', 0.00003847840139934596, 65192.5, 0.001, 0.0001, 1.0, -1.0, true)
        ) AS t(
          instrument_name, trade_id, trade_seq, timestamp, price, amount, direction, tick_direction,
          index_price, mark_price, implied_volatility, strike, expiration_timestamp, option_type,
          time_to_expiry_years, futures_price, delta, gamma, vega, theta, is_valid
        )
      ) TO '${join(silverDir, "BTC.parquet")}' (FORMAT PARQUET)
    `);

    await executeSQLStatement(`
      COPY (
        SELECT date, CAST(delivery_price AS DOUBLE) as delivery_price FROM (VALUES
          ('2024-01-01', 55000.0),
          ('2023-12-31', 54900.0)
        ) AS t(date, delivery_price)
      ) TO '${join(deliveryDir, "btc_usd.parquet")}' (FORMAT PARQUET)
    `);

    await closeDuckDB();
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("assignment_inferred uses real settlement price, not a last-trade proxy", async () => {
    const enricher = new GoldEnricher({
      inputDir: silverDir,
      outputDir: goldDir,
      deliveryDir,
      volatilityDir: join(workDir, "no-volatility-for-main-fixture"), // does not exist; isolate from repo's real ./data/bronze/volatility
    });
    await enricher.initialize();
    await enricher.enrichCurrency("BTC");
    await enricher.cleanup();

    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      instrument_name: string;
      option_type: string;
      outcome_settlement_price: number;
      outcome_assignment_inferred: boolean;
    }>(`
      SELECT DISTINCT instrument_name, option_type, outcome_settlement_price, outcome_assignment_inferred
      FROM read_parquet('${join(goldDir, "BTC.parquet")}')
      ORDER BY instrument_name
    `);
    await closeDuckDB();

    const call = rows.find(r => r.option_type === "call")!;
    const put = rows.find(r => r.option_type === "put")!;

    // Settlement is 55000 (the real delivery price), not any trade's price/futures_price.
    expect(call.outcome_settlement_price).toBe(55000);
    expect(put.outcome_settlement_price).toBe(55000);

    // Call strike 50000, settlement 55000 -> ITM -> assigned.
    expect(call.outcome_assignment_inferred).toBe(true);
    // Put strike 50000, settlement 55000 -> OTM -> not assigned.
    expect(put.outcome_assignment_inferred).toBe(false);
  });

  test("assignment fields are NULL (not a fabricated fallback) when no delivery data exists", async () => {
    const noDeliveryDir = join(workDir, "no-delivery");
    const enricher = new GoldEnricher({
      inputDir: silverDir,
      outputDir: join(workDir, "gold-no-delivery"),
      deliveryDir: noDeliveryDir, // does not exist
    });
    await enricher.initialize();
    await enricher.enrichCurrency("BTC");
    await enricher.cleanup();

    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      outcome_settlement_price: number | null;
      outcome_assignment_inferred: boolean | null;
      outcome_days_to_assignment: number | null;
    }>(`
      SELECT outcome_settlement_price, outcome_assignment_inferred, outcome_days_to_assignment
      FROM read_parquet('${join(workDir, "gold-no-delivery", "BTC.parquet")}')
    `);
    await closeDuckDB();

    for (const row of rows) {
      expect(row.outcome_settlement_price).toBeNull();
      expect(row.outcome_assignment_inferred).toBeNull();
      expect(row.outcome_days_to_assignment).toBeNull();
    }
  });

  test("outcome fields are prefixed outcome_ and entry-time fields are not", async () => {
    await initializeDuckDB();
    const cols = await executeSQLQuery<{ column_name: string }>(`
      SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('${join(goldDir, "BTC.parquet")}'))
    `);
    await closeDuckDB();

    const names = cols.map(c => c.column_name);
    const outcomeFields = names.filter(n => n.startsWith("outcome_"));
    expect(outcomeFields).toEqual(
      expect.arrayContaining([
        "outcome_settlement_price",
        "outcome_forward_return_7day",
        "outcome_assignment_inferred",
        "outcome_days_to_assignment",
      ])
    );

    // The old ambiguous name must be gone entirely.
    expect(names).not.toContain("realized_move_7day");
    expect(names).not.toContain("futures_price_at_expiry");
    expect(names).not.toContain("assignment_inferred");
    expect(names).not.toContain("days_to_assignment");

    // The old mislabeled "slippage" field must be renamed.
    expect(names).not.toContain("slippage_per_contract");
    expect(names).toContain("price_vs_mark_deviation");

    // Entry-time features are trailing/current only, not outcome-prefixed.
    expect(names).toContain("realized_vol_7day");
    expect(names).toContain("iv_percentile_90day");
    expect(names).toContain("iv_percentile_sample_size");
  });

  test("bid_ask_spread_estimate (Roll estimator) is never negative when present", async () => {
    await initializeDuckDB();
    const rows = await executeSQLQuery<{ bid_ask_spread_estimate: number | null }>(`
      SELECT bid_ask_spread_estimate FROM read_parquet('${join(goldDir, "BTC.parquet")}')
      WHERE bid_ask_spread_estimate IS NOT NULL
    `);
    await closeDuckDB();

    for (const row of rows) {
      expect(row.bid_ask_spread_estimate).toBeGreaterThanOrEqual(0);
    }
  });

  test("premium_collection_ratio compares this trade's own fill to its own expected_premium (not a rolling-sum-vs-single-trade mismatch)", async () => {
    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      price: number;
      amount: number;
      expected_premium: number | null;
      actual_premium_collected: number | null;
      premium_collection_ratio: number | null;
    }>(`
      SELECT price, amount, expected_premium, actual_premium_collected, premium_collection_ratio
      FROM read_parquet('${join(goldDir, "BTC.parquet")}')
      WHERE premium_collection_ratio IS NOT NULL
    `);
    await closeDuckDB();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // ratio must equal (price * amount) / expected_premium for THIS row,
      // not actual_premium_collected (a multi-trade rolling sum) / expected_premium.
      const expectedRatio = (row.price * row.amount) / row.expected_premium!;
      expect(row.premium_collection_ratio).toBeCloseTo(expectedRatio, 6);

      // With only a few trades per instrument in this fixture, the rolling
      // sum should differ from the single fill for at least the later
      // trades, proving the ratio is NOT silently keying off the sum.
    }
  });

  test("premium_collection_ratio is NULL (not an astronomical number) when expected_premium is below the exchange's minimum price tick", async () => {
    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      instrument_name: string;
      expected_premium: number | null;
      amount: number;
      premium_collection_ratio: number | null;
    }>(`
      SELECT instrument_name, expected_premium, amount, premium_collection_ratio
      FROM read_parquet('${join(goldDir, "BTC.parquet")}')
      WHERE instrument_name = 'BTC-1JAN24-66000-C'
    `);
    await closeDuckDB();

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // expected_premium should be a real (tiny, near-zero) Black-76 value, not NULL.
    expect(row.expected_premium).not.toBeNull();
    expect(row.expected_premium! / row.amount).toBeLessThan(0.0001);
    // But the ratio itself must be NULL, not an astronomical number like the
    // ~1e+185 observed in production before this guard.
    expect(row.premium_collection_ratio).toBeNull();
  });

  test("iv_percentile_90day and vol_regime are NULL below the minimum sample-size threshold", async () => {
    // This fixture's trailing-90-day IV history per trade is well under 20
    // trades (5 total), so every row should fail the sample-size guard.
    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      iv_percentile_90day: number | null;
      vol_regime: string | null;
      iv_percentile_sample_size: number | null;
    }>(`
      SELECT iv_percentile_90day, vol_regime, iv_percentile_sample_size
      FROM read_parquet('${join(goldDir, "BTC.parquet")}')
    `);
    await closeDuckDB();

    for (const row of rows) {
      expect(row.iv_percentile_90day).toBeNull();
      expect(row.vol_regime).toBeNull();
    }
  });

  test("deribit_realized_vol is NULL when no historical volatility data exists", async () => {
    const noVolatilityDir = join(workDir, "no-volatility"); // does not exist
    const goldNoVolDir = join(workDir, "gold-no-volatility");
    const enricher = new GoldEnricher({
      inputDir: silverDir,
      outputDir: goldNoVolDir,
      deliveryDir,
      volatilityDir: noVolatilityDir,
    });
    await enricher.initialize();
    await enricher.enrichCurrency("BTC");
    await enricher.cleanup();

    await initializeDuckDB();
    const rows = await executeSQLQuery<{ deribit_realized_vol: number | null }>(`
      SELECT deribit_realized_vol FROM read_parquet('${join(goldNoVolDir, "BTC.parquet")}')
    `);
    await closeDuckDB();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.deribit_realized_vol).toBeNull();
    }
  });

  test("deribit_realized_vol is populated via ASOF (nearest-preceding) join to Deribit's historical volatility series", async () => {
    const volatilityDir = join(workDir, "volatility");
    mkdirSync(volatilityDir, { recursive: true });

    // Readings straddle the fixture's trades (2023-12-25 through 2023-12-31).
    // Each trade should pick up the latest reading at or before its own timestamp.
    await initializeDuckDB();
    await executeSQLStatement(`
      COPY (
        SELECT * FROM (VALUES
          (TIMESTAMP '2023-12-24 00:00:00', CAST(50.0 AS DOUBLE)),
          (TIMESTAMP '2023-12-26 00:00:00', CAST(55.0 AS DOUBLE)),
          (TIMESTAMP '2023-12-29 00:00:00', CAST(60.0 AS DOUBLE))
        ) AS t(timestamp, volatility_value)
      ) TO '${join(volatilityDir, "BTC.parquet")}' (FORMAT PARQUET)
    `);
    await closeDuckDB();

    const goldWithVolDir = join(workDir, "gold-with-vol");
    const enricher = new GoldEnricher({
      inputDir: silverDir,
      outputDir: goldWithVolDir,
      deliveryDir,
      volatilityDir,
    });
    await enricher.initialize();
    await enricher.enrichCurrency("BTC");
    await enricher.cleanup();

    await initializeDuckDB();
    const rows = await executeSQLQuery<{
      trade_id: string;
      timestamp: string;
      deribit_realized_vol: number | null;
    }>(`
      SELECT trade_id, timestamp, deribit_realized_vol
      FROM read_parquet('${join(goldWithVolDir, "BTC.parquet")}')
      ORDER BY timestamp
    `);
    await closeDuckDB();

    // t1 @ 2023-12-25 -> nearest-preceding reading is 2023-12-24 (50.0)
    expect(rows.find(r => r.trade_id === "t1")!.deribit_realized_vol).toBe(50.0);
    // t2 @ 2023-12-27 -> nearest-preceding reading is 2023-12-26 (55.0)
    expect(rows.find(r => r.trade_id === "t2")!.deribit_realized_vol).toBe(55.0);
    // t3 @ 2023-12-30 -> nearest-preceding reading is 2023-12-29 (60.0)
    expect(rows.find(r => r.trade_id === "t3")!.deribit_realized_vol).toBe(60.0);
  });
});
