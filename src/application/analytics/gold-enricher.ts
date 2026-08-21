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
  -- Compute price returns for realized volatility
  price_returns AS (
    SELECT *,
      LN(futures_price / LAG(futures_price) OVER (
        PARTITION BY SUBSTRING(instrument_name, 1, 3)
        ORDER BY timestamp
        ROWS BETWEEN 168 PRECEDING AND CURRENT ROW  -- 7 days of hourly data
      )) as log_return
    FROM silver_data
    WHERE futures_price IS NOT NULL
  ),
  -- Compute 7-day realized volatility (annualized)
  realized_vols AS (
    SELECT *,
      STDDEV(log_return) OVER (
        PARTITION BY SUBSTRING(instrument_name, 1, 3)
        ORDER BY timestamp
        ROWS BETWEEN 168 PRECEDING AND CURRENT ROW  -- 7 days
      ) * SQRT(365 * 24) as realized_vol_7day  -- Annualize hourly vol
    FROM price_returns
  ),
  -- Compute IV percentiles within 90-day rolling window per currency
  iv_percentiles AS (
    SELECT *,
      PERCENT_RANK() OVER (
        PARTITION BY SUBSTRING(instrument_name, 1, 3)
        ORDER BY implied_volatility
        ROWS BETWEEN 2160 PRECEDING AND CURRENT ROW  -- ~90 days of hourly trades
      ) as iv_percentile_90day
    FROM realized_vols
  ),
  -- Compute execution quality metrics
  execution_metrics AS (
    SELECT *,
      -- Trade volume: 7-day rolling count
      COUNT(*) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN 168 PRECEDING AND CURRENT ROW
      ) as trade_volume_7day,

      -- Bid-ask spread estimate: infer from tick_direction clustering
      STDDEV(tick_direction) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN 20 PRECEDING AND CURRENT ROW
      ) * price * 0.01 as bid_ask_spread_estimate,

      -- Slippage: entry_price vs mark_price
      CASE
        WHEN mark_price IS NOT NULL AND mark_price > 0
        THEN (price - mark_price) / mark_price
        ELSE NULL
      END as slippage_per_contract,

      -- Expected premium: delta-weighted from Greeks at entry
      CASE
        WHEN delta IS NOT NULL AND price IS NOT NULL
        THEN ABS(delta) * price * amount
        ELSE NULL
      END as expected_premium,

      -- Actual premium collected: 7-day rolling sum
      SUM(price * amount) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN 168 PRECEDING AND CURRENT ROW
      ) as actual_premium_collected
    FROM iv_percentiles
  ),
  -- Compute premium collection ratio (requires expected_premium first)
  premium_metrics AS (
    SELECT *,
      -- Premium collection ratio: actual / expected
      CASE
        WHEN expected_premium IS NOT NULL AND expected_premium > 0
        THEN actual_premium_collected / expected_premium
        ELSE NULL
      END as premium_collection_ratio
    FROM execution_metrics
  ),
  -- Compute outcome metrics (forward-looking)
  outcome_metrics AS (
    SELECT *,
      -- days_to_expiry: Compute early for use in assignment logic
      CAST((epoch_ms(expiration_timestamp) - epoch_ms(timestamp)) / (1000.0 * 86400.0) AS INTEGER) as days_to_expiry,

      -- realized_move_7day: 7-day forward price return
      (LEAD(futures_price, 168) OVER (
        PARTITION BY SUBSTRING(instrument_name, 1, 3)
        ORDER BY timestamp
      ) - futures_price) / NULLIF(futures_price, 0) as realized_move_7day
    FROM premium_metrics
  ),
  -- Compute assignment inference (requires days_to_expiry)
  assignment_metrics AS (
    SELECT *,
      -- assignment_inferred: Infer assignment from ITM at expiry
      CASE
        WHEN days_to_expiry = 0 THEN
          CASE
            WHEN option_type = 'call' AND futures_price > strike THEN TRUE
            WHEN option_type = 'put' AND futures_price < strike THEN TRUE
            ELSE FALSE
          END
        ELSE NULL
      END as assignment_inferred
    FROM outcome_metrics
  ),
  -- Compute days_to_assignment (requires assignment_inferred)
  final_metrics AS (
    SELECT *,
      -- days_to_assignment: Days from entry to assignment (if assigned)
      CASE
        WHEN assignment_inferred = TRUE
        THEN days_to_expiry
        ELSE NULL
      END as days_to_assignment
    FROM assignment_metrics
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

    -- days_to_expiry: Integer days until expiration (already computed in CTE)
    days_to_expiry,

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
      WHEN implied_volatility IS NULL OR iv_percentile_90day IS NULL THEN NULL
      WHEN iv_percentile_90day < 0.33 THEN 'low'
      WHEN iv_percentile_90day < 0.67 THEN 'mid'
      ELSE 'high'
    END as vol_regime,

    -- Market condition metrics (at entry)

    -- realized_vol_7day: 7-day realized volatility (annualized, in percentage)
    realized_vol_7day,

    -- iv_percentile_90day: Current IV rank vs 90-day history (0-1)
    iv_percentile_90day,

    -- iv_minus_rv_gap: IV - RV spread (volatility risk premium indicator)
    (implied_volatility - realized_vol_7day) as iv_minus_rv_gap,

    -- Execution quality metrics

    -- trade_volume_7day: Count of trades in 7-day rolling window
    trade_volume_7day,

    -- bid_ask_spread_estimate: Inferred spread from tick_direction clustering
    bid_ask_spread_estimate,

    -- slippage_per_contract: Entry price vs mark price (execution quality)
    slippage_per_contract,

    -- expected_premium: Delta-weighted premium from Greeks at entry
    expected_premium,

    -- actual_premium_collected: Sum of filled premium in 7-day window
    actual_premium_collected,

    -- premium_collection_ratio: Actual / expected premium (efficiency metric)
    premium_collection_ratio,

    -- Outcome metrics (what happened)

    -- realized_move_7day: 7-day forward price return
    realized_move_7day,

    -- assignment_inferred: Binary flag for option assignment
    assignment_inferred,

    -- days_to_assignment: Holding period until assignment (if assigned)
    days_to_assignment

  FROM final_metrics
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
