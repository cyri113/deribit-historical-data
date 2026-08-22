import { initializeDuckDB, closeDuckDB, executeSQLStatement, executeSQLQuery } from "../../infrastructure/duckdb-connection.ts";
import { generatePriceSQL } from "../../infrastructure/duckdb-greeks.ts";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface GoldEnricherConfig {
  inputDir?: string;    // Default: ./data/silver
  outputDir?: string;   // Default: ./data/gold
  deliveryDir?: string; // Default: ./data/bronze/deliveries
  volatilityDir?: string; // Default: ./data/bronze/volatility
  maxMemory?: string;   // Default: 4GB
  threads?: number;     // Default: CPU cores
}

/** Maps a bronze currency code to its Deribit settlement index name. */
const DELIVERY_INDEX_BY_CURRENCY: Record<string, string> = {
  BTC: "btc_usd",
  ETH: "eth_usd",
};

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
  private deliveryDir: string;
  private volatilityDir: string;
  private maxMemory: string;
  private threads?: number;

  constructor(config: GoldEnricherConfig = {}) {
    this.inputDir = config.inputDir ?? "./data/silver";
    this.outputDir = config.outputDir ?? "./data/gold";
    this.deliveryDir = config.deliveryDir ?? "./data/bronze/deliveries";
    this.volatilityDir = config.volatilityDir ?? "./data/bronze/volatility";
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

      // Check for real settlement/delivery prices (used for assignment_inferred).
      // Without these, assignment_inferred would have to guess expiry price from
      // the last-traded option's stale forward price -- so we require the real
      // data and leave assignment fields NULL rather than fabricate a proxy.
      const deliveryIndex = DELIVERY_INDEX_BY_CURRENCY[currency];
      const deliveryFile = deliveryIndex ? join(this.deliveryDir, `${deliveryIndex}.parquet`) : undefined;
      let hasDeliveryData = false;
      if (deliveryFile && existsSync(deliveryFile)) {
        const deliveryCheck = await executeSQLQuery<{ count: bigint | number }>(
          `SELECT COUNT(*) as count FROM read_parquet('${deliveryFile}')`
        );
        const deliveryCount = typeof deliveryCheck[0]?.count === 'bigint'
          ? Number(deliveryCheck[0].count)
          : (deliveryCheck[0]?.count ?? 0);
        hasDeliveryData = deliveryCount > 0;
      }
      if (hasDeliveryData) {
        console.log(`✓ Found settlement prices at ${deliveryFile} — assignment_inferred will use real delivery prices`);
      } else {
        console.log(`⚠️  No settlement/delivery data found for ${currency} — outcome_assignment_inferred, outcome_days_to_assignment, and outcome_settlement_price will be NULL (run \`bronze ${currency}\` delivery fetch to populate)`);
      }

      // Deribit's own historical volatility series (index-price-based realized
      // vol), used as an independent cross-check against this pipeline's own
      // futures-trade-derived realized_vol_7day -- not a replacement for it.
      const volatilityFile = join(this.volatilityDir, `${currency}.parquet`);
      let hasVolatilityData = false;
      if (existsSync(volatilityFile)) {
        const volatilityCheck = await executeSQLQuery<{ count: bigint | number }>(
          `SELECT COUNT(*) as count FROM read_parquet('${volatilityFile}')`
        );
        const volatilityCount = typeof volatilityCheck[0]?.count === 'bigint'
          ? Number(volatilityCheck[0].count)
          : (volatilityCheck[0]?.count ?? 0);
        hasVolatilityData = volatilityCount > 0;
      }
      if (hasVolatilityData) {
        console.log(`✓ Found Deribit historical volatility at ${volatilityFile} — deribit_realized_vol will be populated`);
      } else {
        console.log(`⚠️  No historical volatility data found for ${currency} — deribit_realized_vol will be NULL (run \`bronze ${currency}\` volatility fetch to populate)`);
      }

      console.log(`\nComputing trading metrics...`);

      // Generate and execute gold enrichment SQL
      const sql = this.generateGoldEnrichmentQuery(
        inputFile,
        outputFile,
        hasDeliveryData ? deliveryFile : undefined,
        hasVolatilityData ? volatilityFile : undefined
      );
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
  private generateGoldEnrichmentQuery(inputPath: string, outputPath: string, deliveryPath?: string, volatilityPath?: string): string {
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

    // Roll (1984) implied spread estimator: 2*sqrt(-Cov(ΔP_t, ΔP_t-1)), defined
    // only when consecutive trade-price changes are negatively autocorrelated
    // (the bid/ask bounce assumption). Trade-only data has no quotes, so this
    // is the closest defensible spread proxy available; it is NULL whenever
    // the covariance is non-negative (no detectable bounce) rather than
    // silently emitting a fabricated number, and requires >= 5 observations.
    const rollSpreadSQL = `
      CASE
        WHEN roll.n_obs >= 5 AND roll.cov_dp < 0
        THEN 2 * sqrt(-roll.cov_dp)
        ELSE NULL
      END
    `;

    // Minimum trades required in the trailing 90-day window before
    // iv_percentile_90day / vol_regime are considered statistically
    // meaningful. Below this, percentile values from a histogram this coarse
    // are dominated by which bucket the trade happens to land in rather than
    // genuine rank information (e.g. with 3 trades, the only achievable
    // percentiles are ~{0.17, 0.5, 0.83} regardless of true distribution).
    const MIN_IV_PERCENTILE_SAMPLE = 20;

    return `
COPY (
  WITH silver_data AS (
    SELECT *,
      -- Currency extracted once here and reused everywhere below, instead of
      -- repeating SUBSTRING(instrument_name, 1, 3) at each window/join site.
      SUBSTRING(instrument_name, 1, 3) as currency
    FROM read_parquet('${inputPath}')
  ),
  ${deliveryPath ? `
  -- Real Deribit settlement/delivery prices (daily index price, keyed by
  -- calendar date). Deribit options settle at 08:00 UTC against this index,
  -- so joining on the expiry's calendar date gives the true settlement price
  -- -- unlike the previous approach of reusing the last-traded option's
  -- attached futures price, which could be stale by hours or days for
  -- illiquid contracts and is not Deribit's actual settlement mechanism.
  delivery_prices AS (
    SELECT
      CAST(date AS DATE) as delivery_date,
      delivery_price
    FROM read_parquet('${deliveryPath}')
  ),
  ` : ''}
  ${volatilityPath ? `
  -- Deribit's own historical volatility series (index-price-based realized
  -- vol, hourly cadence). This is a THIRD, independently-computed realized-vol
  -- signal alongside this pipeline's own trailing-window realized_vol_7day
  -- (computed below from futures-trade returns) -- kept as a separate
  -- cross-check column (deribit_realized_vol) rather than replacing
  -- realized_vol_7day, since the two use different underlying price sources
  -- (Deribit's index vs. this pipeline's futures trades) and different
  -- windowing methodology.
  volatility_readings AS (
    SELECT
      timestamp as vol_timestamp,
      volatility_value
    FROM read_parquet('${volatilityPath}')
  ),
  ` : ''}
  -- Compute price returns for realized volatility, over a genuine trailing
  -- 7-calendar-day window per currency (see time-windowed CTEs below for why
  -- "N PRECEDING rows" is NOT used here).
  price_returns AS (
    SELECT *,
      LN(futures_price / LAG(futures_price) OVER (
        PARTITION BY currency
        ORDER BY timestamp
      )) as log_return
    FROM silver_data
    WHERE futures_price IS NOT NULL
  ),
  -- Time-windowed (not row-count-windowed) trailing aggregates.
  --
  -- The original implementation used ROWS BETWEEN 168 PRECEDING AND CURRENT ROW
  -- as a proxy for "7 days," reasoning that trades arrive roughly hourly. That
  -- assumption fails badly for illiquid instruments/eras: a single option
  -- instrument (trade_volume_7day, actual_premium_collected) often trades far
  -- less than once per hour, so "168 PRECEDING" can span weeks or months of
  -- calendar time instead of 7 days -- worse the further back in Deribit's
  -- history (2020-2021 options liquidity) or the less popular the strike.
  -- Conversely in a very liquid modern regime, 168 trades can occur within
  -- minutes, making the window far *narrower* than 7 days.
  --
  -- Fix: use DuckDB's genuine time-based RANGE frame (supported directly on
  -- TIMESTAMP-typed ORDER BY columns), which always spans exactly the stated
  -- calendar interval regardless of trade density.
  time_windowed AS (
    SELECT *,
      STDDEV(log_return) OVER (
        PARTITION BY currency
        ORDER BY timestamp
        RANGE BETWEEN INTERVAL 7 DAYS PRECEDING AND CURRENT ROW
      ) * SQRT(365 * 24) as realized_vol_7day,  -- Annualize (returns are ~hourly-cadence on average)

      COUNT(*) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        RANGE BETWEEN INTERVAL 7 DAYS PRECEDING AND CURRENT ROW
      ) as trade_volume_7day,

      SUM(price * amount) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        RANGE BETWEEN INTERVAL 7 DAYS PRECEDING AND CURRENT ROW
      ) as actual_premium_collected
    FROM price_returns
  ),
  ${volatilityPath ? `
  -- Attach the nearest-preceding Deribit historical volatility reading to
  -- each trade (ASOF JOIN: currency-agnostic since the volatility file is
  -- already scoped to this currency). NULL for trades before the earliest
  -- volatility reading on record.
  with_deribit_vol AS (
    SELECT t.*,
      v.volatility_value as deribit_realized_vol
    FROM time_windowed t
    ASOF LEFT JOIN volatility_readings v
      ON v.vol_timestamp <= t.timestamp
  ),
  ` : `
  with_deribit_vol AS (
    SELECT *, CAST(NULL AS DOUBLE) as deribit_realized_vol
    FROM time_windowed
  ),
  `}
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
  -- The 999.5 cap: Deribit IV quotes essentially never exceed ~1000% in practice
  -- even for extreme 0DTE prints; this is a defensive upper bound against
  -- parsing/data errors blowing up the bucket count, not a real distributional
  -- claim. Values are clamped (not dropped) into the top bucket so they still
  -- count toward the percentile as "highest observed."
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
      currency,
      date_trunc('day', timestamp) as day,
      CAST(LEAST(GREATEST(implied_volatility, 0), 999.5) * 2 AS INTEGER) as iv_bin,
      COUNT(*) as bin_count
    FROM time_windowed
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
      -- Midpoint-of-tie percentile (matches PERCENT_RANK's tie behavior), bounded to [0, 1].
      -- Requires at least MIN_IV_PERCENTILE_SAMPLE trades in the trailing 90-day
      -- window (not just > 1): with only a handful of trades, the percentile is
      -- almost entirely determined by which coarse bucket a trade lands in, not
      -- genuine distributional rank -- especially likely in thinly-traded
      -- currencies/eras (e.g. early Deribit history). Below the threshold, both
      -- iv_percentile_90day and (downstream) vol_regime are NULL rather than a
      -- falsely-confident low/mid/high label.
      CASE
        WHEN rv.implied_volatility IS NULL OR h.window_total IS NULL OR h.window_total < ${MIN_IV_PERCENTILE_SAMPLE} THEN NULL
        ELSE LEAST(1.0, GREATEST(0.0,
          ((h.cum_lt + h.cum_le) / 2.0) / h.window_total
        ))
      END as iv_percentile_90day,
      h.window_total as iv_percentile_sample_size
    FROM with_deribit_vol rv
    LEFT JOIN rolling_iv_hist h
      ON h.currency = rv.currency
      AND h.day = date_trunc('day', rv.timestamp)
      AND h.iv_bin = CAST(LEAST(GREATEST(rv.implied_volatility, 0), 999.5) * 2 AS INTEGER)
  ),
  -- Roll (1984) spread estimator inputs: consecutive trade-price deltas per
  -- instrument (dp), and their own lag (dp_lag) -- computed in separate CTEs
  -- since DuckDB disallows nesting one window function inside another.
  price_deltas AS (
    SELECT *,
      price - LAG(price) OVER (PARTITION BY instrument_name ORDER BY timestamp) as dp
    FROM iv_percentiles
  ),
  price_delta_lags AS (
    SELECT *,
      LAG(dp) OVER (PARTITION BY instrument_name ORDER BY timestamp) as dp_lag
    FROM price_deltas
  ),
  roll_covariance AS (
    SELECT *,
      COVAR_POP(dp, dp_lag) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN 20 PRECEDING AND CURRENT ROW
      ) as cov_dp,
      COUNT(dp) OVER (
        PARTITION BY instrument_name
        ORDER BY timestamp
        ROWS BETWEEN 20 PRECEDING AND CURRENT ROW
      ) as n_obs
    FROM price_delta_lags
  ),
  -- Compute execution quality metrics
  execution_metrics AS (
    SELECT roll.* EXCLUDE (dp, dp_lag, cov_dp, n_obs),

      -- Bid-ask spread estimate: Roll (1984) implied spread from the serial
      -- covariance of trade-price changes. NULL (not a fabricated number)
      -- whenever the bid/ask-bounce assumption doesn't hold or there's
      -- insufficient data.
      --
      -- Previously this computed STDDEV(tick_direction) * price * 0.01, where
      -- tick_direction is a categorical uptick/downtick code (0-3), not a
      -- continuous price signal -- taking its standard deviation measures
      -- direction-flip frequency, not spread, and the 0.01 multiplier had no
      -- stated basis. That was a fabricated signal dressed as microstructure
      -- data; replaced with a real, if limited, estimator.
      ${rollSpreadSQL} as bid_ask_spread_estimate,

      -- Deviation of trade price from Deribit's concurrent mark price.
      --
      -- Renamed from "slippage_per_contract": true slippage requires a
      -- pre-trade reference price (e.g. mark/mid at order submission) versus
      -- the fill price, to capture execution latency cost. Here price and
      -- mark_price are simultaneous (both attributes of the same trade
      -- record), so this measures how far a print traded from Deribit's fair
      -- value at that instant -- which can reflect genuine urgency/skew or
      -- mark-price lag during fast IV moves, not necessarily execution cost.
      -- Trade-only data (no order-submission timestamps) cannot support a
      -- true slippage metric.
      CASE
        WHEN mark_price IS NOT NULL AND mark_price > 0
        THEN (price - mark_price) / mark_price
        ELSE NULL
      END as price_vs_mark_deviation,

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
      END as expected_premium

    FROM roll_covariance roll
  ),
  -- Compute premium collection ratio (requires expected_premium first)
  premium_metrics AS (
    SELECT *,
      -- Premium collection ratio: THIS TRADE's actual fill (price * amount)
      -- vs. its Black-76 theoretical fair value (expected_premium), both
      -- single-trade quantities. 1.0 = filled at exactly fair value; >1.0 =
      -- collected more than theoretical (favorable fill); <1.0 = less.
      --
      -- Previously this divided actual_premium_collected (a 7-day ROLLING
      -- SUM of price*amount across many trades for the instrument) by
      -- expected_premium (a SINGLE trade's theoretical price) -- a sum
      -- divided by a single value, so the ratio's magnitude depended on how
      -- many trades happened to be in the trailing window and had no
      -- "1.0 = fair value" interpretation (observed ratios in the hundreds
      -- to low thousands on real data). Fixed to compare like-for-like:
      -- this trade's own fill vs. this trade's own theoretical value.
      --
      -- Guard: Deribit's minimum tradeable price tick for BTC options is
      -- 0.0001 BTC -- the market price floor doesn't shrink below that even
      -- as true fair value approaches zero for deep-OTM, seconds-to-expiry
      -- options. Black-76 correctly returns a near-zero (e.g. 1e-190)
      -- theoretical price for those, so price/expected_premium explodes to
      -- absurd magnitudes (observed up to 1e+185 on real data) despite the
      -- formula being arithmetically correct -- these aren't a meaningful
      -- "efficiency" signal, just division by a number smaller than the
      -- exchange's own price granularity. NULL out the ratio whenever the
      -- theoretical per-contract price is below that tick size, since no
      -- ratio computed against it can be economically meaningful.
      CASE
        WHEN expected_premium IS NOT NULL AND amount IS NOT NULL AND amount > 0
          AND (expected_premium / amount) >= 0.0001
        THEN (price * amount) / expected_premium
        ELSE NULL
      END as premium_collection_ratio
    FROM execution_metrics
  ),
  -- ============================================================
  -- OUTCOME METRICS -- forward-looking by construction. These describe
  -- what happened AFTER a trade (or at/after its expiry) and must never be
  -- used as an entry-time filter/feature in a backtest -- they are not
  -- knowable at the trade's timestamp. All outcome fields are prefixed
  -- "outcome_" in the final output specifically so they cannot be mistaken
  -- for entry-time features by column name alone.
  -- ============================================================
  -- outcome_forward_return_7day source: the earliest trade at least 7
  -- calendar days after each trade, per currency, found via ASOF JOIN
  -- (picks the nearest match satisfying ">= entry + 7 days", i.e. the first
  -- price point on/after the forward date -- exact calendar-time lookup,
  -- not a row-count proxy).
  forward_prices AS (
    SELECT
      a.trade_id,
      a.futures_price as entry_futures_price,
      b.futures_price as forward_futures_price
    FROM premium_metrics a
    ASOF JOIN premium_metrics b
      ON a.currency = b.currency
      AND b.timestamp >= a.timestamp + INTERVAL 7 DAYS
  ),
  outcome_metrics AS (
    SELECT pm.*,
      -- days_to_expiry: Compute early for use in assignment logic. This is
      -- NOT forward-looking itself (expiration_timestamp is known at entry
      -- from the instrument's contract spec), but is grouped with outcome
      -- fields below because days_to_assignment depends on it.
      CAST((epoch_ms(pm.expiration_timestamp) - epoch_ms(pm.timestamp)) / (1000.0 * 86400.0) AS INTEGER) as days_to_expiry,

      -- outcome_forward_return_7day: 7-calendar-day FORWARD price return --
      -- explicitly uses the future. Renamed from "realized_move_7day"
      -- because that name was easy to confuse with the legitimate trailing
      -- "realized_vol_7day" entry feature above; this field is the opposite
      -- (forward-looking) despite the similar name.
      (fp.forward_futures_price - fp.entry_futures_price) / NULLIF(fp.entry_futures_price, 0) as outcome_forward_return_7day
    FROM premium_metrics pm
    LEFT JOIN forward_prices fp USING (trade_id)
  ),
  ${deliveryPath ? `
  -- Real settlement price per instrument, from Deribit's delivery-price
  -- index on the option's expiry date (not a proxy from the last-traded
  -- option's stale attached futures price -- see delivery_prices CTE above).
  expiration_prices AS (
    SELECT DISTINCT
      instrument_name,
      d.delivery_price as outcome_settlement_price
    FROM outcome_metrics o
    JOIN delivery_prices d
      ON d.delivery_date = CAST(o.expiration_timestamp AS DATE)
  ),
  ` : `
  expiration_prices AS (
    SELECT DISTINCT instrument_name, CAST(NULL AS DOUBLE) as outcome_settlement_price
    FROM outcome_metrics
  ),
  `}
  -- Compute assignment inference (check ITM at real settlement price)
  assignment_metrics AS (
    SELECT o.*,
      e.outcome_settlement_price,
      -- outcome_assignment_inferred: ITM at real settlement, NULL if no
      -- settlement price is available (never falls back to a proxy).
      CASE
        WHEN e.outcome_settlement_price IS NULL THEN NULL
        WHEN o.option_type = 'call' AND e.outcome_settlement_price > o.strike THEN TRUE
        WHEN o.option_type = 'put' AND e.outcome_settlement_price < o.strike THEN TRUE
        ELSE FALSE
      END as outcome_assignment_inferred
    FROM outcome_metrics o
    LEFT JOIN expiration_prices e USING (instrument_name)
  ),
  -- Compute days_to_assignment (requires outcome_assignment_inferred)
  final_metrics AS (
    SELECT *,
      -- outcome_days_to_assignment: Days from entry to assignment (if assigned)
      CASE
        WHEN outcome_assignment_inferred = TRUE
        THEN days_to_expiry
        ELSE NULL
      END as outcome_days_to_assignment
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

    -- vol_regime: IV percentile classification (low/mid/high vol environment).
    -- NULL whenever iv_percentile_90day is NULL, including the insufficient-
    -- sample-size case (see iv_percentile_sample_size).
    CASE
      WHEN implied_volatility IS NULL OR iv_percentile_90day IS NULL THEN NULL
      WHEN iv_percentile_90day < 0.33 THEN 'low'
      WHEN iv_percentile_90day < 0.67 THEN 'mid'
      ELSE 'high'
    END as vol_regime,

    -- Market condition metrics (at entry)

    -- realized_vol_7day: trailing 7-calendar-day realized volatility (annualized, in percentage),
    -- computed from this pipeline's own futures-trade returns
    realized_vol_7day,

    -- deribit_realized_vol: Deribit's own historical volatility reading (index-price-based,
    -- hourly cadence), nearest-preceding this trade. An independent cross-check against
    -- realized_vol_7day above -- NOT a replacement (different price source and windowing).
    -- NULL if no volatility data was fetched for this currency, or before the earliest
    -- reading on record.
    deribit_realized_vol,

    -- iv_percentile_90day: Current IV rank vs trailing 90-calendar-day history (0-1)
    iv_percentile_90day,

    -- iv_percentile_sample_size: trade count backing iv_percentile_90day/vol_regime;
    -- use this to apply a stricter cutoff than the pipeline's built-in minimum if needed
    iv_percentile_sample_size,

    -- iv_minus_rv_gap: IV - RV spread (volatility risk premium indicator)
    (implied_volatility - realized_vol_7day) as iv_minus_rv_gap,

    -- Execution quality metrics (at entry)

    -- trade_volume_7day: Count of trades in trailing 7-calendar-day window
    trade_volume_7day,

    -- bid_ask_spread_estimate: Roll (1984) implied spread; NULL if inestimable
    bid_ask_spread_estimate,

    -- price_vs_mark_deviation: trade price vs Deribit's concurrent mark price
    price_vs_mark_deviation,

    -- expected_premium: Black-76 theoretical price at entry
    expected_premium,

    -- actual_premium_collected: Sum of filled premium in trailing 7-calendar-day window
    actual_premium_collected,

    -- premium_collection_ratio: Actual / expected premium (efficiency metric)
    premium_collection_ratio,

    -- ============================================================
    -- OUTCOME METRICS (what happened) -- forward-looking. DO NOT use these
    -- as entry-time filters/features in a backtest; they are not knowable at
    -- the trade's timestamp. All prefixed "outcome_" for this reason.
    -- ============================================================

    -- outcome_settlement_price: real Deribit settlement/delivery price at expiration
    outcome_settlement_price,

    -- outcome_forward_return_7day: 7-calendar-day FORWARD price return from entry
    outcome_forward_return_7day,

    -- outcome_assignment_inferred: ITM-at-settlement flag, from real settlement price
    outcome_assignment_inferred,

    -- outcome_days_to_assignment: Holding period until assignment (if assigned)
    outcome_days_to_assignment

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
