import { initializeDuckDB, closeDuckDB, executeSQLStatement, executeSQLQuery } from "../../infrastructure/duckdb-connection.ts";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface GoldEnricherConfig {
  inputDir?: string;   // Default: ./data/silver
  outputDir?: string;  // Default: ./data/gold
  maxMemory?: string;  // Default: 4GB
  threads?: number;    // Default: CPU cores
}

export interface GoldEnrichmentResult {
  currency: string;
  inputFile: string;
  outputFile: string;
  tradeCount: number;
  duration: number;
  error?: string;
}

/**
 * Gold Layer Enricher - Trading Metrics & Analytics
 *
 * Adds business logic and trading-focused metrics:
 * - strike_delta: Categorize options by delta (5Δ, 10Δ, 25Δ, 50Δ)
 * - days_to_expiry: DTE for strategy filtering (0DTE, 7DTE, 30DTE)
 * - vol_regime: IV percentile classification (low/mid/high)
 *
 * Gold = Silver + Trading Metrics (analysis-ready for backtesting)
 */
export class GoldEnricher {
  private inputDir: string;
  private outputDir: string;
  private maxMemory: string;
  private threads?: number;

  constructor(config: GoldEnricherConfig = {}) {
    this.inputDir = config.inputDir ?? "./data/silver";
    this.outputDir = config.outputDir ?? "./data/gold";
    this.maxMemory = config.maxMemory ?? "4GB";
    this.threads = config.threads;
  }

  /**
   * Initialize DuckDB with configuration
   */
  async initialize(): Promise<void> {
    await initializeDuckDB({
      maxMemory: this.maxMemory,
      threads: this.threads,
    });
  }

  /**
   * Enrich a currency's silver data with gold trading metrics
   */
  async enrichCurrency(currency: string): Promise<GoldEnrichmentResult> {
    console.log(`\n━━━ DuckDB Gold Enrichment: ${currency} ━━━\n`);

    const overallStart = Date.now();
    const inputFile = join(this.inputDir, `${currency}.parquet`);
    const outputFile = join(this.outputDir, `${currency}.parquet`);

    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    try {
      console.log(`Input:  ${inputFile}`);
      console.log(`Output: ${outputFile}\n`);

      // Check if input exists
      const checkQuery = `SELECT COUNT(*) as count FROM read_parquet('${inputFile}')`;
      const checkResult = await executeSQLQuery<{ count: bigint | number }>(checkQuery);
      const inputTradeCount = typeof checkResult[0]?.count === 'bigint'
        ? Number(checkResult[0].count)
        : (checkResult[0]?.count ?? 0);

      if (inputTradeCount === 0) {
        throw new Error(`No data found in ${inputFile}`);
      }

      console.log(`Found ${inputTradeCount.toLocaleString()} trades in silver layer`);
      console.log(`\nComputing trading metrics...`);

      // Generate and execute gold enrichment SQL
      const sql = this.generateGoldEnrichmentQuery(inputFile, outputFile);
      await executeSQLStatement(sql);

      // Verify output
      const outputCountQuery = `SELECT COUNT(*) as count FROM read_parquet('${outputFile}')`;
      const outputCount = await executeSQLQuery<{ count: bigint | number }>(outputCountQuery);
      const outputTradeCount = typeof outputCount[0]?.count === 'bigint'
        ? Number(outputCount[0].count)
        : (outputCount[0]?.count ?? 0);

      const duration = Date.now() - overallStart;
      const throughput = Math.round(outputTradeCount / (duration / 1000));

      console.log(`\n━━━ Gold Enrichment Complete ━━━`);
      console.log(`Output file: ${outputFile}`);
      console.log(`Total trades: ${outputTradeCount.toLocaleString()}`);
      console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
      console.log(`Throughput: ${throughput.toLocaleString()} trades/sec\n`);

      return {
        currency,
        inputFile,
        outputFile,
        tradeCount: outputTradeCount,
        duration,
      };
    } catch (error) {
      console.error(`Failed to enrich ${currency}:`, error);
      throw error;
    }
  }

  /**
   * Generate DuckDB SQL for gold layer enrichment
   */
  private generateGoldEnrichmentQuery(inputPath: string, outputPath: string): string {
    return `
COPY (
  WITH silver_data AS (
    SELECT * FROM read_parquet('${inputPath}')
  ),
  -- Compute IV percentiles within 30-day rolling window per currency
  iv_percentiles AS (
    SELECT *,
      PERCENT_RANK() OVER (
        PARTITION BY SUBSTRING(instrument_name, 1, 3)
        ORDER BY implied_volatility
        ROWS BETWEEN 720 PRECEDING AND CURRENT ROW  -- ~30 days of hourly trades
      ) as iv_percentile
    FROM silver_data
  )
  SELECT
    -- All silver layer fields (passthrough)
    instrument_name,
    trade_id,
    trade_seq,
    timestamp,
    price,
    amount,
    direction,
    tick_direction,
    index_price,
    mark_price,
    implied_volatility,
    strike,
    expiration_timestamp,
    option_type,
    time_to_expiry_years,
    futures_price,
    delta,
    gamma,
    vega,
    theta,
    is_valid,

    -- Gold layer: Trading metrics

    -- days_to_expiry: Integer days until expiration (for DTE filtering)
    CAST((expiration_timestamp - timestamp) / (1000.0 * 86400.0) AS INTEGER) as days_to_expiry,

    -- strike_delta: Categorize by delta buckets (common trading terminology)
    CASE
      WHEN delta IS NULL THEN NULL
      WHEN ABS(delta) <= 0.05 THEN '5-delta'
      WHEN ABS(delta) <= 0.10 THEN '10-delta'
      WHEN ABS(delta) <= 0.25 THEN '25-delta'
      WHEN ABS(delta) <= 0.50 THEN '50-delta'
      ELSE 'deep-itm'
    END as strike_delta,

    -- vol_regime: IV percentile classification (low/mid/high vol environment)
    CASE
      WHEN implied_volatility IS NULL OR iv_percentile IS NULL THEN NULL
      WHEN iv_percentile < 0.33 THEN 'low'
      WHEN iv_percentile < 0.67 THEN 'mid'
      ELSE 'high'
    END as vol_regime

  FROM iv_percentiles
) TO '${outputPath}' (FORMAT PARQUET);
`;
  }

  /**
   * Enrich - wrapper method for BunQueue compatibility
   */
  async enrich(
    currency: string,
    inputDir?: string,
    outputDir?: string,
    maxMemory?: string,
    threads?: number
  ): Promise<{ tradeCount: number; duration: number }> {
    // Update config if provided
    if (inputDir) this.inputDir = inputDir;
    if (outputDir) this.outputDir = outputDir;
    if (maxMemory) this.maxMemory = maxMemory;
    if (threads !== undefined) this.threads = threads;

    // Initialize DuckDB
    await this.initialize();

    // Enrich
    const result = await this.enrichCurrency(currency);

    // Cleanup
    await this.cleanup();

    return {
      tradeCount: result.tradeCount,
      duration: result.duration,
    };
  }

  /**
   * Cleanup DuckDB resources
   */
  async cleanup(): Promise<void> {
    await closeDuckDB();
  }
}
