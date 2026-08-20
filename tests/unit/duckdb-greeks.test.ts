import { test, expect, describe } from "bun:test";
import {
  generateDeltaSQL,
  generateGammaSQL,
  generateVegaSQL,
  generateThetaSQL,
  generateGreeksEnrichmentQuery,
} from "../../src/infrastructure/duckdb-greeks.ts";

describe("DuckDB Greeks SQL Generation", () => {
  const testParams = {
    forwardPrice: "index_price",
    strike: "strike",
    timeToExpiry: "time_to_expiry_years",
    volatility: "implied_volatility / 100.0",
    optionType: "option_type",
  };

  test("generateDeltaSQL produces valid SQL", () => {
    const sql = generateDeltaSQL(testParams);

    // Should contain CASE statement
    expect(sql).toContain("CASE");
    expect(sql).toContain("WHEN");
    expect(sql).toContain("END");

    // Should reference input columns
    expect(sql).toContain("index_price");
    expect(sql).toContain("strike");
    expect(sql).toContain("time_to_expiry_years");
    expect(sql).toContain("implied_volatility");
    expect(sql).toContain("option_type");

    // Should handle option type (uses 'call' explicitly, 'put' is in ELSE branch)
    expect(sql).toContain("'call'");

    // Should handle time to expiry = 0
    expect(sql).toContain("<= 0");
  });

  test("generateGammaSQL produces valid SQL", () => {
    const sql = generateGammaSQL(testParams);

    // Should contain CASE statement
    expect(sql).toContain("CASE");
    expect(sql).toContain("WHEN");
    expect(sql).toContain("END");

    // Should reference input columns
    expect(sql).toContain("index_price");
    expect(sql).toContain("strike");
    expect(sql).toContain("time_to_expiry_years");
    expect(sql).toContain("implied_volatility");

    // Should handle time to expiry = 0
    expect(sql).toContain("<= 0");
    expect(sql).toContain("0.0");

    // Should use sqrt for time factor
    expect(sql).toContain("sqrt");
  });

  test("generateVegaSQL produces valid SQL", () => {
    const sql = generateVegaSQL(testParams);

    // Should contain CASE statement
    expect(sql).toContain("CASE");
    expect(sql).toContain("WHEN");
    expect(sql).toContain("END");

    // Should reference input columns
    expect(sql).toContain("index_price");
    expect(sql).toContain("strike");
    expect(sql).toContain("time_to_expiry_years");
    expect(sql).toContain("implied_volatility");

    // Should divide by 100 for 1% change
    expect(sql).toContain("/ 100.0");

    // Should use sqrt for time factor
    expect(sql).toContain("sqrt");
  });

  test("generateThetaSQL produces valid SQL", () => {
    const sql = generateThetaSQL(testParams);

    // Should contain CASE statement
    expect(sql).toContain("CASE");
    expect(sql).toContain("WHEN");
    expect(sql).toContain("END");

    // Should reference input columns
    expect(sql).toContain("index_price");
    expect(sql).toContain("strike");
    expect(sql).toContain("time_to_expiry_years");
    expect(sql).toContain("implied_volatility");

    // Should divide by 365 for per-day value
    expect(sql).toContain("/ (2.0 * sqrt");
    expect(sql).toContain("* 365.0)");

    // Should use negative sign
    expect(sql).toContain("-");
  });

  test("generateGreeksEnrichmentQuery produces complete SELECT", () => {
    const query = generateGreeksEnrichmentQuery({
      inputPath: "data/parquet-raw/BTC/BTC-27MAR26-70000-C.parquet",
    });

    // Should be a SELECT statement
    expect(query).toContain("SELECT");
    expect(query).toContain("FROM");

    // Should read from Parquet
    expect(query).toContain("read_parquet");
    expect(query).toContain("BTC-27MAR26-70000-C.parquet");

    // Should include all original trade columns
    expect(query).toContain("trade_id");
    expect(query).toContain("trade_seq");
    expect(query).toContain("instrument_name");
    expect(query).toContain("timestamp");
    expect(query).toContain("price");
    expect(query).toContain("amount");

    // Should include computed Greeks
    expect(query).toContain("as delta");
    expect(query).toContain("as gamma");
    expect(query).toContain("as vega");
    expect(query).toContain("as theta");

    // Should filter options only
    expect(query).toContain("WHERE option_type IS NOT NULL");

    // Should check for implied volatility
    expect(query).toContain("implied_volatility IS NOT NULL");
  });

  test("generateGreeksEnrichmentQuery with output path includes COPY", () => {
    const query = generateGreeksEnrichmentQuery({
      inputPath: "data/parquet-raw/BTC/input.parquet",
      outputPath: "data/parquet-enriched/BTC/output.parquet",
    });

    // Should use COPY statement
    expect(query).toContain("COPY (");
    expect(query).toContain(") TO");
    expect(query).toContain("output.parquet");

    // Should specify PARQUET format
    expect(query).toContain("FORMAT PARQUET");
    expect(query).toContain("COMPRESSION SNAPPY");
  });

  test("SQL handles division by zero protection", () => {
    const deltaSQL = generateDeltaSQL(testParams);

    // Should check time_to_expiry > 0 before computing
    expect(deltaSQL).toContain("time_to_expiry_years <= 0");
    expect(deltaSQL).toContain("WHEN time_to_expiry_years <= 0 THEN");
  });

  test("SQL normalizes IV from percentage to decimal", () => {
    const query = generateGreeksEnrichmentQuery({
      inputPath: "test.parquet",
    });

    // Should divide implied volatility by 100
    expect(query).toContain("implied_volatility / 100.0");
  });
});
