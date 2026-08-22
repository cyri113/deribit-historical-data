import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBulkGreeksEnrichmentQuery } from "../../src/infrastructure/duckdb-greeks.ts";
import { initializeDuckDB, executeSQLStatement, executeSQLQuery, closeDuckDB } from "../../src/infrastructure/duckdb-connection.ts";

// Regression coverage for the Silver-layer review's findings, executed
// against real DuckDB with synthetic fixtures (the same class of setup used
// in gold-enricher.test.ts).

describe("generateBulkGreeksEnrichmentQuery (executed against real DuckDB with synthetic fixtures)", () => {
  let workDir: string;
  let instrumentsDir: string;
  let futuresDir: string;
  let outputPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "bulk-greeks-test-"));
    instrumentsDir = join(workDir, "instruments", "BTC");
    futuresDir = join(workDir, "futures");
    outputPath = join(workDir, "silver-out.parquet");
    mkdirSync(instrumentsDir, { recursive: true });
    mkdirSync(futuresDir, { recursive: true });

    await initializeDuckDB();

    // One option instrument with several trades exercising different cases:
    // - t1: normal trade, futures match ~5 min prior (fresh) -> should be valid
    // - t2: IV = 0 -> Greeks should be NULL, not NaN/Inf
    // - t3: futures match exists but is 2 hours stale (beyond the 1h cap)
    //       -> futures_price should be NULL, Greeks NULL, is_valid false
    await executeSQLStatement(`
      COPY (
        SELECT * FROM (VALUES
          ('t1', 1, 'BTC-1JUL24-50000-C', TIMESTAMP '2024-06-01 00:10:00', 0.05, 1.0, 'buy', 0, 54000.0, 54100.0, 60.0, 50000.0, TIMESTAMP '2024-07-01 08:00:00', 'call', 0.08),
          ('t2', 2, 'BTC-1JUL24-50000-C', TIMESTAMP '2024-06-01 00:10:00', 0.05, 1.0, 'buy', 0, 54000.0, 54100.0, 0.0,  50000.0, TIMESTAMP '2024-07-01 08:00:00', 'call', 0.08),
          ('t3', 3, 'BTC-1JUL24-50000-C', TIMESTAMP '2024-06-01 03:00:00', 0.05, 1.0, 'buy', 0, 54000.0, 54100.0, 60.0, 50000.0, TIMESTAMP '2024-07-01 08:00:00', 'call', 0.08)
        ) AS t(
          trade_id, trade_seq, instrument_name, timestamp, price, amount, direction, tick_direction,
          index_price, mark_price, implied_volatility, strike, expiration_timestamp,
          option_type, time_to_expiry_years
        )
      ) TO '${join(instrumentsDir, "BTC-1JUL24-50000-C.parquet")}' (FORMAT PARQUET)
    `);

    // Futures trades: two at the EXACT same timestamp (tie -- t2's higher
    // trade_seq, 102, should win deterministically over trade_seq 101), plus
    // one at 00:05:00 (5 min before t1/t2's 00:10:00 -- fresh match) that is
    // the correct match for t1/t2. For t3 (03:00:00), the nearest prior
    // futures trade is still the 00:05:00 one -- ~2h55m stale, beyond the
    // 1-hour cap, so t3 should end up with NULL futures_price.
    await executeSQLStatement(`
      COPY (
        SELECT * FROM (VALUES
          ('f1', 100, 'BTC-1JUL24', TIMESTAMP '2024-06-01 00:05:00', 54050.0, 1.0, 'buy', 0, 54050.0, 54050.0),
          ('f2', 101, 'BTC-1JUL24', TIMESTAMP '2024-06-01 00:09:59', 54200.0, 1.0, 'buy', 0, 54200.0, 54200.0),
          ('f3', 102, 'BTC-1JUL24', TIMESTAMP '2024-06-01 00:09:59', 54999.0, 1.0, 'buy', 0, 54999.0, 54999.0)
        ) AS t(
          trade_id, trade_seq, instrument_name, timestamp, price, amount, direction, tick_direction,
          index_price, mark_price
        )
      ) TO '${join(futuresDir, "BTC-1JUL24.parquet")}' (FORMAT PARQUET)
    `);

    const sql = generateBulkGreeksEnrichmentQuery({
      inputPattern: join(instrumentsDir, "*.parquet"),
      futuresPattern: join(futuresDir, "*.parquet"),
      outputPath,
    });
    await executeSQLStatement(sql);
  });

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("IV = 0 produces NULL Greeks, not NaN/Inf", async () => {
    const rows = await executeSQLQuery<{
      delta: number | null;
      gamma: number | null;
      is_valid: boolean;
    }>(`SELECT delta, gamma, is_valid FROM read_parquet('${outputPath}') WHERE trade_id = 't2'`);

    expect(rows.length).toBe(1);
    expect(rows[0]!.delta).toBeNull();
    expect(rows[0]!.gamma).toBeNull();
    expect(rows[0]!.is_valid).toBe(false);
  });

  test("a futures match older than the staleness cap (1 hour) is treated as no match: futures_price NULL, Greeks NULL, is_valid false", async () => {
    const rows = await executeSQLQuery<{
      futures_price: number | null;
      delta: number | null;
      is_valid: boolean;
    }>(`SELECT futures_price, delta, is_valid FROM read_parquet('${outputPath}') WHERE trade_id = 't3'`);

    expect(rows.length).toBe(1);
    expect(rows[0]!.futures_price).toBeNull();
    expect(rows[0]!.delta).toBeNull();
    expect(rows[0]!.is_valid).toBe(false);
  });

  test("a fresh futures match (well within the staleness cap) produces valid, in-range Greeks", async () => {
    const rows = await executeSQLQuery<{
      futures_price: number;
      delta: number;
      gamma: number;
      vega: number;
      theta: number;
      is_valid: boolean;
    }>(`SELECT futures_price, delta, gamma, vega, theta, is_valid FROM read_parquet('${outputPath}') WHERE trade_id = 't1'`);

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.futures_price).not.toBeNull();
    expect(row.is_valid).toBe(true);
    // Call delta must be in [0, 1].
    expect(row.delta).toBeGreaterThanOrEqual(0);
    expect(row.delta).toBeLessThanOrEqual(1);
    expect(row.gamma).toBeGreaterThan(0);
    expect(row.vega).toBeGreaterThan(0);
    expect(row.theta).toBeLessThan(0);
  });

  test("tied-timestamp futures trades resolve deterministically to the higher trade_seq (not an arbitrary/undefined tiebreak)", async () => {
    // f2 (trade_seq 101, price 54200) and f3 (trade_seq 102, price 54999)
    // share the identical timestamp 00:09:59. t1 and t2's option trades are
    // at 00:10:00, so both f2 and f3 are equally "nearest prior" by
    // timestamp alone -- the tiebreak (highest trade_seq) must pick f3
    // (54999), not f2 (54200) or a non-deterministic choice.
    const rows = await executeSQLQuery<{ futures_price: number }>(
      `SELECT CAST(futures_price AS DOUBLE) as futures_price FROM read_parquet('${outputPath}') WHERE trade_id = 't1'`
    );
    expect(rows[0]!.futures_price).toBe(54999.0);
  });

  test("is_valid checks all four Greeks for NaN/Inf, not just delta/gamma", () => {
    const sql = generateBulkGreeksEnrichmentQuery({
      inputPattern: "x.parquet",
      futuresPattern: "y.parquet",
      outputPath: "z.parquet",
    });

    // The is_valid expression must reference isnan/isinf checks against
    // vega and theta expressions, not just delta and gamma. Slice from the
    // start of the "( forward_price IS NOT NULL" is_valid block (identified
    // by its distinctive leading condition) through "as is_valid" itself.
    const isValidStart = sql.indexOf("forward_price IS NOT NULL\n      AND implied_volatility");
    const isValidEnd = sql.indexOf("as is_valid");
    expect(isValidStart).toBeGreaterThan(-1);
    const isValidBlock = sql.slice(isValidStart, isValidEnd);
    const isnanCount = (isValidBlock.match(/isnan\(/g) || []).length;
    const isinfCount = (isValidBlock.match(/isinf\(/g) || []).length;

    // 4 Greeks x 2 checks (isnan + isinf) = 8 total.
    expect(isnanCount).toBe(4);
    expect(isinfCount).toBe(4);
  });

  test("uses native ASOF JOIN, not a manual LEFT JOIN + QUALIFY ROW_NUMBER() cross-product", () => {
    const sql = generateBulkGreeksEnrichmentQuery({
      inputPattern: "x.parquet",
      futuresPattern: "y.parquet",
      outputPath: "z.parquet",
    });

    expect(sql).toContain("ASOF LEFT JOIN");
  });

  test("d1 is computed once per row (single CTE column), not re-expanded per Greek", () => {
    const sql = generateBulkGreeksEnrichmentQuery({
      inputPattern: "x.parquet",
      futuresPattern: "y.parquet",
      outputPath: "z.parquet",
    });

    // Exactly one "as d1" column definition.
    const d1Definitions = (sql.match(/\) as d1/g) || []).length;
    expect(d1Definitions).toBe(1);

    // The full ln(...)/power(...) d1 expression should not appear multiple
    // times (a regression to per-Greek re-expansion would duplicate it).
    const lnOccurrences = (sql.match(/ln\(forward_price/g) || []).length;
    expect(lnOccurrences).toBe(1);
  });
});
