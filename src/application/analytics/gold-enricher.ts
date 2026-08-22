import { initializeDuckDB, closeDuckDB, executeSQLStatement, executeSQLQuery } from "../../infrastructure/duckdb-connection.ts";
import { generatePriceSQL } from "../../infrastructure/duckdb-greeks.ts";
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
    // Black-76 theoretical price for expected_premium, using the same inputs
    // Silver used for Greeks (futures_price as forward, IV/100 as decimal vol).
    // Output is a fraction of the forward price, matching Deribit's inverse-option
    // `price` quote convention (BTC-denominated), so it's directly comparable to
    // `price` and to actual_premium_collected (both price*amount-scaled).
    const expectedPremiumPriceSQL = generatePriceSQL({
      forwardPrice: "futures_price",
      strike: "strike",
      timeToExpiry: "time_to_expiry_years",
      volatility: "implied_volatility / 100.0",
      optionType: "option_type",
    });

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
  -- Compute IV percentiles within a genuine trailing-90-calendar-day window per currency.
  --
  -- A plain PERCENT_RANK() OVER (ORDER BY implied_volatility ROWS BETWEEN N PRECEDING ...)
  -- cannot express this: DuckDB ties the window FRAME to the same ORDER BY used for
  -- ranking, so ordering by implied_volatility (to rank by value) makes the "N PRECEDING"
  -- frame a value-sorted neighborhood instead of a time window -- it can include trades
  -- from anywhere in the dataset's time range, including the future relative to the row
  -- being labeled. That was the original look-ahead bias bug here.
  --
  -- Fix: approximate the trailing-90-day IV percentile via a per-day histogram (0.5-wide
  -- IV buckets), rolled up over the trailing 90 calendar days per currency, then joined
  -- back to each trade by (currency, day, bucket). This keeps the self-join small (one
  -- row per currency/day/bucket, not per trade) so it stays tractable at full data
  -- volume, at the cost of resolution being bucketed to 0.5 IV points -- negligible for
  -- a low/mid/high tercile classification.
  --
  -- KNOWN LIMITATION: the window is inclusive of the trade's own calendar day
  -- (b.day <= a.day below), and daily buckets don't distinguish trades within
  -- the same day by time of day. So a trade at 02:00 on day D is still ranked
  -- against every trade on day D up to 23:59, including ones that happened
  -- after it. This is a same-day (at most ~24h) residual look-ahead window --
  -- far smaller than the original bug (which could reach anywhere across the
  -- full dataset), but not zero. Closing it exactly would require an
  -- additional intra-day ranking pass; not implemented here as the residual
  -- leak is small relative to the 90-day window and immaterial to a tercile
  -- (low/mid/high) classification.
  daily_iv_hist AS (
    SELECT
      SUBSTRING(instrument_name, 1, 3) as currency,
      date_trunc('day', timestamp) as day,
      CAST(LEAST(GREATEST(implied_volatility, 0), 999.5) * 2 AS INTEGER) as iv_bin,
      COUNT(*) as bin_count
    FROM realized_vols
    WHERE implied_volatility IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  rolling_iv_hist AS (
    SELECT
      a.currency, a.day, a.iv_bin,
      SUM(b.bin_count) FILTER (WHERE b.iv_bin < a.iv_bin) as cum_lt,
      SUM(b.bin_count) FILTER (WHERE b.iv_bin <= a.iv_bin) as cum_le,
      SUM(b.bin_count) as window_total
    FROM daily_iv_hist a
    JOIN daily_iv_hist b
      ON b.currency = a.currency
      AND b.day <= a.day
      AND b.day > a.day - INTERVAL 90 DAY
    GROUP BY a.currency, a.day, a.iv_bin
  ),
  iv_percentiles AS (
    SELECT rv.*,
      -- Midpoint-of-tie percentile (matches PERCENT_RANK's tie behavior), bounded to [0, 1]
      CASE
        WHEN rv.implied_volatility IS NULL OR h.window_total IS NULL OR h.window_total <= 1 THEN NULL
        ELSE LEAST(1.0, GREATEST(0.0,
          ((h.cum_lt + h.cum_le) / 2.0) / h.window_total
        ))
      END as iv_percentile_90day
    FROM realized_vols rv
    LEFT JOIN rolling_iv_hist h
      ON h.currency = SUBSTRING(rv.instrument_name, 1, 3)
      AND h.day = date_trunc('day', rv.timestamp)
      AND h.iv_bin = CAST(LEAST(GREATEST(rv.implied_volatility, 0), 999.5) * 2 AS INTEGER)
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

      -- Expected premium: Black-76 theoretical price at entry, in the same
      -- BTC-denominated units as \`price\` (Deribit inverse-option convention:
      -- price_BTC = price_USD / futures_price), scaled by contract amount to
      -- match actual_premium_collected's price*amount convention.
      --
      -- Previously this was ABS(delta) * price * amount, which (a) is not a
      -- recognized fair-value formula -- delta is a hedge ratio, not a price
      -- discount factor -- and (b) never converted between price's BTC units
      -- and strike/futures_price's USD units, producing values off by
      -- ~10^4-10^5x for ITM options (theoretical price below intrinsic value).
      CASE
        WHEN futures_price IS NOT NULL AND implied_volatility IS NOT NULL
          AND time_to_expiry_years > 0 AND amount IS NOT NULL
        THEN ${expectedPremiumPriceSQL} * amount
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
  -- Get futures price at expiration for each instrument
  expiration_prices AS (
    SELECT
      instrument_name,
      LAST(futures_price) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      ) as futures_price_at_expiry
    FROM outcome_metrics
  ),
  -- Compute assignment inference (check ITM at expiration for all trades)
  assignment_metrics AS (
    SELECT o.*,
      e.futures_price_at_expiry,
      -- assignment_inferred: Check if ITM at expiration (for all trades)
      CASE
        WHEN e.futures_price_at_expiry IS NOT NULL THEN
          CASE
            WHEN o.option_type = 'call' AND e.futures_price_at_expiry > o.strike THEN TRUE
            WHEN o.option_type = 'put' AND e.futures_price_at_expiry < o.strike THEN TRUE
            ELSE FALSE
          END
        ELSE NULL
      END as assignment_inferred
    FROM outcome_metrics o
    LEFT JOIN expiration_prices e USING (instrument_name)
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

    -- futures_price_at_expiry: Underlying price at expiration
    futures_price_at_expiry,

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
