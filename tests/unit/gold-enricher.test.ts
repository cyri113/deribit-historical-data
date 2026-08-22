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
          ('BTC-1JAN24-50000-P', 'u2', 2, TIMESTAMP '2023-12-28 00:00:00', 0.009, 1.0, 'sell', 1, 54800.0, 54700.0, 50.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'put', 0.009, 54800.0, -0.12, 0.0001, 6.0, -3.0, true)
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
});
