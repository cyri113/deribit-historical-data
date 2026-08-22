import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBEnricher } from "../../src/application/analytics/duckdb-enricher.ts";
import { initializeDuckDB, executeSQLStatement, closeDuckDB } from "../../src/infrastructure/duckdb-connection.ts";

describe("DuckDBEnricher.enrichCurrency without futures data (regression: silent all-invalid output)", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("throws instead of silently writing a 100%-invalid silver file when futures data is entirely missing", async () => {
    workDir = mkdtempSync(join(tmpdir(), "duckdb-enricher-test-"));
    const bronzeDir = join(workDir, "bronze");
    const silverDir = join(workDir, "silver");
    const instrumentsDir = join(bronzeDir, "instruments", "BTC");
    mkdirSync(instrumentsDir, { recursive: true });

    await initializeDuckDB();
    await executeSQLStatement(`
      COPY (
        SELECT * FROM (VALUES
          ('t1', 1, TIMESTAMP '2023-12-25 00:00:00', 0.05, 1.0, 'buy', 0, 54000.0, 54100.0, 60.0, 50000.0, TIMESTAMP '2024-01-01 08:00:00', 'call', 0.02)
        ) AS t(
          trade_id, trade_seq, timestamp, price, amount, direction, tick_direction,
          index_price, mark_price, implied_volatility, strike, expiration_timestamp, option_type,
          time_to_expiry_years
        )
      ) TO '${join(instrumentsDir, "BTC-1JAN24-50000-C.parquet")}' (FORMAT PARQUET)
    `);
    await closeDuckDB();
    // Deliberately do not create bronzeDir/futures at all.

    const enricher = new DuckDBEnricher({ inputDir: bronzeDir, outputDir: silverDir });
    await enricher.initialize();

    await expect(enricher.enrichCurrency("BTC")).rejects.toThrow(/0 valid trades/);

    await enricher.cleanup();
  });
});
