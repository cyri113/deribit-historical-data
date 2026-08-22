/**
 * DuckDB Greeks Calculation using SQL Expressions
 *
 * Since DuckDB WASM doesn't support custom scalar UDFs, we implement
 * Black-76 Greeks using pure SQL expressions and built-in functions.
 *
 * This approach:
 * - Uses DuckDB's vectorized execution for performance
 * - Avoids row-by-row TypeScript iteration
 * - Processes millions of trades in parallel
 * - Direct Parquet → Parquet transformation
 */

/**
 * SQL expression for standard normal CDF using Abramowitz and Stegun approximation
 *
 * N(x) = 1 - phi(x) for x > 0
 * N(x) = phi(-x) for x < 0
 *
 * where phi(x) = (1/sqrt(2*pi)) * exp(-x²/2) * polynomial_approx
 */
const NORMAL_CDF_SQL = `
CASE
  WHEN {x} >= 0 THEN
    1 - (
      0.3989423 * exp(-(power({x}, 2)) / 2.0) *
      (1.0 / (1.0 + 0.2316419 * abs({x}))) *
      (
        0.3193815 +
        (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
          -0.3565638 +
          (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
            1.781478 +
            (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
              -1.821256 +
              (1.0 / (1.0 + 0.2316419 * abs({x}))) * 1.330274
            )
          )
        )
      )
    )
  ELSE
    0.3989423 * exp(-(power({x}, 2)) / 2.0) *
    (1.0 / (1.0 + 0.2316419 * abs({x}))) *
    (
      0.3193815 +
      (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
        -0.3565638 +
        (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
          1.781478 +
          (1.0 / (1.0 + 0.2316419 * abs({x}))) * (
            -1.821256 +
            (1.0 / (1.0 + 0.2316419 * abs({x}))) * 1.330274
          )
        )
      )
    )
END
`;

/**
 * SQL expression for standard normal PDF
 * PDF(x) = (1/sqrt(2*pi)) * exp(-x²/2)
 */
const NORMAL_PDF_SQL = `
(1.0 / sqrt(2.0 * pi())) * exp(-(power({x}, 2)) / 2.0)
`;

/**
 * SQL expression for d1 in Black-76 model
 * d1 = [ln(F/K) + (σ²/2)*T] / (σ*√T)
 */
const D1_SQL = `
(
  ln({forward_price} / {strike}) +
  (power({volatility}, 2) * {time_to_expiry} / 2.0)
) / ({volatility} * sqrt({time_to_expiry}))
`;

/**
 * SQL expression for d2 in Black-76 model
 * d2 = d1 - σ*√T
 */
const D2_SQL = `
({d1}) - ({volatility} * sqrt({time_to_expiry}))
`;

/**
 * Generate SQL for Delta calculation
 * Call Delta = N(d1)
 * Put Delta = -N(-d1)
 */
export function generateDeltaSQL(params: {
  forwardPrice: string;
  strike: string;
  timeToExpiry: string;
  volatility: string;
  optionType: string;
}): string {
  const d1 = D1_SQL
    .replace(/{forward_price}/g, params.forwardPrice)
    .replace(/{strike}/g, params.strike)
    .replace(/{time_to_expiry}/g, params.timeToExpiry)
    .replace(/{volatility}/g, params.volatility);

  const cdfD1 = NORMAL_CDF_SQL.replace(/{x}/g, `(${d1})`);
  const cdfMinusD1 = NORMAL_CDF_SQL.replace(/{x}/g, `-(${d1})`);

  return `
CASE
  WHEN ${params.timeToExpiry} <= 0 THEN
    CASE
      WHEN ${params.optionType} = 'call' THEN
        CASE WHEN ${params.forwardPrice} > ${params.strike} THEN 1.0 ELSE 0.0 END
      ELSE
        CASE WHEN ${params.forwardPrice} < ${params.strike} THEN -1.0 ELSE 0.0 END
    END
  WHEN ${params.optionType} = 'call' THEN
    ${cdfD1}
  ELSE
    -${cdfMinusD1}
END
`;
}

/**
 * Generate SQL for Gamma calculation
 * Gamma = N'(d1) / (F * σ * √T)
 * Same for both calls and puts
 */
export function generateGammaSQL(params: {
  forwardPrice: string;
  strike: string;
  timeToExpiry: string;
  volatility: string;
}): string {
  const d1 = D1_SQL
    .replace(/{forward_price}/g, params.forwardPrice)
    .replace(/{strike}/g, params.strike)
    .replace(/{time_to_expiry}/g, params.timeToExpiry)
    .replace(/{volatility}/g, params.volatility);

  const pdfD1 = NORMAL_PDF_SQL.replace(/{x}/g, `(${d1})`);

  return `
CASE
  WHEN ${params.timeToExpiry} <= 0 THEN 0.0
  ELSE
    ${pdfD1} / (${params.forwardPrice} * ${params.volatility} * sqrt(${params.timeToExpiry}))
END
`;
}

/**
 * Generate SQL for Vega calculation
 * Vega = F * N'(d1) * √T / 100
 * Per 1% change in volatility, same for both calls and puts
 */
export function generateVegaSQL(params: {
  forwardPrice: string;
  strike: string;
  timeToExpiry: string;
  volatility: string;
}): string {
  const d1 = D1_SQL
    .replace(/{forward_price}/g, params.forwardPrice)
    .replace(/{strike}/g, params.strike)
    .replace(/{time_to_expiry}/g, params.timeToExpiry)
    .replace(/{volatility}/g, params.volatility);

  const pdfD1 = NORMAL_PDF_SQL.replace(/{x}/g, `(${d1})`);

  return `
CASE
  WHEN ${params.timeToExpiry} <= 0 THEN 0.0
  ELSE
    (${params.forwardPrice} * ${pdfD1} * sqrt(${params.timeToExpiry})) / 100.0
END
`;
}

/**
 * Generate SQL for Theta calculation
 * Theta = -[F*N'(d1)*σ / (2*√T)] / 365
 * Simplified for r=0 (crypto), per day
 */
export function generateThetaSQL(params: {
  forwardPrice: string;
  strike: string;
  timeToExpiry: string;
  volatility: string;
}): string {
  const d1 = D1_SQL
    .replace(/{forward_price}/g, params.forwardPrice)
    .replace(/{strike}/g, params.strike)
    .replace(/{time_to_expiry}/g, params.timeToExpiry)
    .replace(/{volatility}/g, params.volatility);

  const pdfD1 = NORMAL_PDF_SQL.replace(/{x}/g, `(${d1})`);

  return `
CASE
  WHEN ${params.timeToExpiry} <= 0 THEN 0.0
  ELSE
    -(${params.forwardPrice} * ${pdfD1} * ${params.volatility}) / (2.0 * sqrt(${params.timeToExpiry}) * 365.0)
END
`;
}

/**
 * Generate SQL for Black-76 theoretical option price, expressed as a fraction
 * of the forward price (i.e. in the same BTC-denominated units Deribit quotes
 * `price` in for inverse options: price_BTC = price_USD / F).
 *
 * Call = [F*N(d1) - K*N(d2)] / F
 * Put  = [K*N(-d2) - F*N(-d1)] / F
 */
export function generatePriceSQL(params: {
  forwardPrice: string;
  strike: string;
  timeToExpiry: string;
  volatility: string;
  optionType: string;
}): string {
  const d1 = D1_SQL
    .replace(/{forward_price}/g, params.forwardPrice)
    .replace(/{strike}/g, params.strike)
    .replace(/{time_to_expiry}/g, params.timeToExpiry)
    .replace(/{volatility}/g, params.volatility);

  const d2 = D2_SQL
    .replace(/{d1}/g, `(${d1})`)
    .replace(/{volatility}/g, params.volatility)
    .replace(/{time_to_expiry}/g, params.timeToExpiry);

  const cdfD1 = NORMAL_CDF_SQL.replace(/{x}/g, `(${d1})`);
  const cdfD2 = NORMAL_CDF_SQL.replace(/{x}/g, `(${d2})`);
  const cdfMinusD1 = NORMAL_CDF_SQL.replace(/{x}/g, `-(${d1})`);
  const cdfMinusD2 = NORMAL_CDF_SQL.replace(/{x}/g, `-(${d2})`);

  return `
CASE
  WHEN ${params.timeToExpiry} <= 0 THEN
    CASE
      WHEN ${params.optionType} = 'call' THEN
        greatest(${params.forwardPrice} - ${params.strike}, 0.0) / ${params.forwardPrice}
      ELSE
        greatest(${params.strike} - ${params.forwardPrice}, 0.0) / ${params.forwardPrice}
    END
  WHEN ${params.optionType} = 'call' THEN
    (${params.forwardPrice} * ${cdfD1} - ${params.strike} * ${cdfD2}) / ${params.forwardPrice}
  ELSE
    (${params.strike} * ${cdfMinusD2} - ${params.forwardPrice} * ${cdfMinusD1}) / ${params.forwardPrice}
END
`;
}

/**
 * Maximum age (in hours) a matched futures trade may be relative to the
 * option trade it's being used as a forward price for. The ASOF join always
 * finds the nearest futures trade AT OR BEFORE the option trade -- for an
 * illiquid dated-futures contract that "nearest prior" trade can genuinely
 * be very old (observed up to ~1.42 days on real production data, with a
 * p90 of ~2 hours). A stale forward price silently degrades every Greek fed
 * from it while still being labeled `is_valid = true`, since staleness was
 * previously unchecked. 1 hour was chosen to cut off the long tail (which
 * starts past the p90) while keeping the bulk of matches (median gap in
 * practice is ~4 minutes).
 */
const MAX_FUTURES_STALENESS_HOURS = 1;

/**
 * Generate bulk enrichment query for all instruments in a currency
 * Reads ALL Parquet files at once, computes Greeks in single vectorized pass
 *
 * Joins with dated futures to get forward prices for accurate Greeks.
 *
 * Design notes (see also design-decisions.md and data-model.md):
 *
 * - ASOF JOIN, not a manual LEFT JOIN + QUALIFY ROW_NUMBER(): the latter
 *   forces DuckDB's planner to materialize the full (option, futures)
 *   inequality cross-product per shared expiry before filtering it down --
 *   confirmed via EXPLAIN ANALYZE on real data to produce over 1 BILLION
 *   intermediate rows from 4.58M options x 673K futures, accounting for the
 *   large majority of the query's wall-clock time. ASOF JOIN is a genuine
 *   sort-merge built for exactly this "nearest match at-or-before" pattern
 *   and is dramatically faster for identical semantics (~15x faster in a
 *   direct comparison on this dataset: ~18s -> ~1.2s for the join alone).
 *
 * - The futures side is deduplicated to one row per (instrument, timestamp)
 *   before the ASOF join, keeping the highest trade_seq on ties. This is
 *   necessary, not cosmetic: ~12.5% of (instrument, timestamp) pairs in the
 *   real futures dataset have multiple trades at the exact same recorded
 *   timestamp (same-microsecond fills). The previous manual join's
 *   `ORDER BY futures_timestamp DESC` had no secondary sort key, so its
 *   tie-break was DuckDB-implementation-defined and undocumented; DuckDB's
 *   native ASOF JOIN operator also has no documented tie-break behavior and
 *   (per DuckDB's own ASOF-join grammar) supports only a single inequality
 *   predicate, so it cannot express a secondary sort key itself. Resolving
 *   ties deterministically via trade_seq (the highest, i.e. most recently
 *   executed, trade at that timestamp) BEFORE the join is the documented
 *   DuckDB-idiomatic pattern for this and makes the choice explicit rather
 *   than accidental.
 *
 * - A staleness cap (MAX_FUTURES_STALENESS_HOURS) is applied as a filter
 *   AFTER the ASOF join, not as part of the join's ON clause: DuckDB's ASOF
 *   JOIN implementation only accepts one inequality condition in the ON
 *   clause (a second inequality there triggers an internal DuckDB error,
 *   confirmed directly), so a staleness bound has to be expressed as a
 *   post-join filter instead.
 */
export function generateBulkGreeksEnrichmentQuery(params: {
  inputPattern: string;       // e.g., 'data/parquet-raw/BTC/*.parquet'
  futuresPattern?: string;    // e.g., 'data/parquet-raw/futures/BTC-*.parquet'
  outputPath: string;         // e.g., 'data/parquet-duckdb/BTC.parquet'
}): string {
  // d1 and the four normal-distribution values every Greek needs (N(d1),
  // N(-d1), N'(d1)) are computed ONCE per row here, then referenced by name
  // in the Greek formulas below -- rather than each Greek independently
  // re-expanding D1_SQL/NORMAL_CDF_SQL/NORMAL_PDF_SQL inline (as
  // generateDeltaSQL/generateGammaSQL/generateVegaSQL/generateThetaSQL do
  // when used standalone). At 4.58M rows, redundantly evaluating ln/exp/sqrt
  // 4-6x per row instead of once is real, measurable waste; DuckDB does not
  // perform common-subexpression elimination across these syntactically
  // separate (if textually identical) CASE expressions.
  //
  // The formulas themselves are unchanged from generateDeltaSQL etc. -- see
  // those functions' doc comments for the Black-76 spec each implements.
  //
  // `forward_price` below is the CTE's own staleness-gated column (NULL
  // when the matched futures trade is older than MAX_FUTURES_STALENESS_HOURS
  // -- see the `joined` CTE), not the raw joined futures.futures_price, so
  // `d1` (and every Greek derived from it) never gets computed against a
  // stale forward price in the first place.
  const forwardPrice = "forward_price";
  const strike = "strike";
  const timeToExpiry = "time_to_expiry_years";
  const volatility = "implied_volatility / 100.0";

  const d1Expr = D1_SQL
    .replace(/{forward_price}/g, forwardPrice)
    .replace(/{strike}/g, strike)
    .replace(/{time_to_expiry}/g, timeToExpiry)
    .replace(/{volatility}/g, volatility);

  // Precomputed-column references used by the Greek formulas below, once
  // `d1` has been materialized as its own CTE column.
  const cdfD1 = NORMAL_CDF_SQL.replace(/{x}/g, "d1");
  const cdfMinusD1 = NORMAL_CDF_SQL.replace(/{x}/g, "-d1");
  const pdfD1 = NORMAL_PDF_SQL.replace(/{x}/g, "d1");

  const deltaFromD1 = `
    CASE
      WHEN ${timeToExpiry} <= 0 THEN
        CASE
          WHEN option_type = 'call' THEN
            CASE WHEN ${forwardPrice} > ${strike} THEN 1.0 ELSE 0.0 END
          ELSE
            CASE WHEN ${forwardPrice} < ${strike} THEN -1.0 ELSE 0.0 END
        END
      WHEN option_type = 'call' THEN (${cdfD1})
      ELSE -(${cdfMinusD1})
    END
  `;

  const gammaFromD1 = `
    CASE
      WHEN ${timeToExpiry} <= 0 THEN 0.0
      ELSE (${pdfD1}) / (${forwardPrice} * ${volatility} * sqrt(${timeToExpiry}))
    END
  `;

  const vegaFromD1 = `
    CASE
      WHEN ${timeToExpiry} <= 0 THEN 0.0
      ELSE (${forwardPrice} * (${pdfD1}) * sqrt(${timeToExpiry})) / 100.0
    END
  `;

  const thetaFromD1 = `
    CASE
      WHEN ${timeToExpiry} <= 0 THEN 0.0
      ELSE -(${forwardPrice} * (${pdfD1}) * ${volatility}) / (2.0 * sqrt(${timeToExpiry}) * 365.0)
    END
  `;

  // Build query with optional futures join
  const futuresJoin = params.futuresPattern ? `
    ASOF LEFT JOIN (
      -- Deduplicate to one row per (instrument, timestamp): see the
      -- function-level doc comment above for why this is required before
      -- an ASOF JOIN, not merely a performance nicety.
      SELECT instrument_name as futures_instrument, timestamp as futures_timestamp, price as futures_price
      FROM read_parquet('${params.futuresPattern}')
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY instrument_name, timestamp
        ORDER BY trade_seq DESC
      ) = 1
    ) futures
    ON regexp_extract(opt.instrument_name, '^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-', 1) = futures.futures_instrument
    AND opt.timestamp >= futures.futures_timestamp
  ` : '';

  return `
COPY (
  WITH raw_join AS (
    -- Stage 1: attach the raw ASOF-matched futures trade (if any) and
    -- whether it's within the staleness cap. No Greek math happens here.
    SELECT
      regexp_extract(opt.filename, '/([^/]+)\\.parquet$', 1) as instrument_name,
      opt.trade_id,
      opt.trade_seq,
      opt.timestamp,
      opt.price,
      opt.amount,
      opt.direction,
      opt.tick_direction,
      opt.index_price,
      opt.mark_price,
      opt.implied_volatility,
      opt.strike,
      opt.expiration_timestamp,
      opt.option_type,
      opt.time_to_expiry_years,
      ${params.futuresPattern ? `
      futures.futures_price as raw_futures_price,
      (futures.futures_price IS NOT NULL
        AND opt.timestamp - futures.futures_timestamp <= INTERVAL '${MAX_FUTURES_STALENESS_HOURS} hours'
      ) as futures_price_fresh
      ` : 'CAST(NULL AS DOUBLE) as raw_futures_price, false as futures_price_fresh'}
    FROM read_parquet('${params.inputPattern}', filename=true) opt
    ${futuresJoin}
  ),
  with_forward_price AS (
    -- Stage 2: resolve the single forward_price every downstream formula
    -- uses. Stale/missing matches collapse to NULL here, so nothing later
    -- (d1, any Greek, is_valid) needs its own separate staleness check --
    -- an over-stale match behaves exactly like "no futures match at all."
    SELECT *,
      CASE WHEN futures_price_fresh THEN raw_futures_price ELSE NULL END as forward_price
    FROM raw_join
  ),
  with_d1 AS (
    -- Stage 3: d1 computed exactly once per row from the resolved
    -- forward_price. Every Greek below (and the is_valid NaN/Inf check)
    -- reuses this column instead of each independently re-deriving
    -- ln/power/sqrt -- at 4.58M rows, evaluating those transcendental
    -- functions 4-6x per row instead of once is real, measurable waste
    -- that DuckDB does not eliminate on its own across separate CASE
    -- expressions.
    SELECT *, (${d1Expr}) as d1
    FROM with_forward_price
  )
  SELECT
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
    forward_price as futures_price,

    -- Computed Greeks. Gated on implied_volatility > 0 (not just IS NOT
    -- NULL): IV = 0 makes volatility = 0, which sends d1's denominator
    -- (volatility * sqrt(T)) to zero and produces NaN/Inf. Previously the
    -- gate only checked IS NOT NULL, so an IV=0 row still had NaN/Inf
    -- values stored in these columns (correctly excluded from is_valid via
    -- a separate check, but inconsistent with the documented "NULL if no
    -- futures_price" contract for these fields). Gating here means the
    -- stored value is NULL, matching that contract, for every reason a
    -- Greek can't be computed (no futures match, stale futures match, IV
    -- missing or zero) -- at/past expiry is still handled inside each CASE
    -- below since Greeks are well-defined (not NaN) at expiry.
    CASE
      WHEN implied_volatility IS NOT NULL AND implied_volatility > 0 AND forward_price IS NOT NULL
      THEN ${deltaFromD1}
      ELSE NULL
    END as delta,

    CASE
      WHEN implied_volatility IS NOT NULL AND implied_volatility > 0 AND forward_price IS NOT NULL
      THEN ${gammaFromD1}
      ELSE NULL
    END as gamma,

    CASE
      WHEN implied_volatility IS NOT NULL AND implied_volatility > 0 AND forward_price IS NOT NULL
      THEN ${vegaFromD1}
      ELSE NULL
    END as vega,

    CASE
      WHEN implied_volatility IS NOT NULL AND implied_volatility > 0 AND forward_price IS NOT NULL
      THEN ${thetaFromD1}
      ELSE NULL
    END as theta,

    -- Data quality flag for analytics filtering
    -- STRICT: Requires a futures forward price no older than
    -- MAX_FUTURES_STALENESS_HOURS for accurate Greeks
    -- TRUE = valid for backtesting/analysis (fresh futures price, IV>0,
    --        sufficient time to expiry, all four Greeks finite)
    -- FALSE = missing/stale futures data, IV<=0, very short-dated, or
    --         any Greek is NaN/Inf
    (
      forward_price IS NOT NULL
      AND implied_volatility > 0
      AND time_to_expiry_years > 0.0027  -- > 1 day
      AND NOT (
        isnan(${deltaFromD1}) OR isinf(${deltaFromD1}) OR
        isnan(${gammaFromD1}) OR isinf(${gammaFromD1}) OR
        isnan(${vegaFromD1}) OR isinf(${vegaFromD1}) OR
        isnan(${thetaFromD1}) OR isinf(${thetaFromD1})
      )
    ) as is_valid

  FROM with_d1
) TO '${params.outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
`;
}

/**
 * Generate complete SELECT statement for Greeks enrichment (single file)
 * DEPRECATED: Use generateBulkGreeksEnrichmentQuery for better performance
 */
export function generateGreeksEnrichmentQuery(params: {
  inputPath: string;
  outputPath?: string;
}): string {
  const greeksParams = {
    forwardPrice: "index_price",
    strike: "strike",
    timeToExpiry: "time_to_expiry_years",
    volatility: "implied_volatility / 100.0", // Convert from percentage to decimal
    optionType: "option_type",
  };

  const deltaSQL = generateDeltaSQL(greeksParams);
  const gammaSQL = generateGammaSQL(greeksParams);
  const vegaSQL = generateVegaSQL(greeksParams);
  const thetaSQL = generateThetaSQL(greeksParams);

  const selectClause = `
SELECT
  -- Original trade data
  trade_id,
  trade_seq,
  instrument_name,
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

  -- Computed Greeks
  CASE
    WHEN implied_volatility IS NOT NULL AND time_to_expiry_years > 0
    THEN ${deltaSQL}
    ELSE NULL
  END as delta,

  CASE
    WHEN implied_volatility IS NOT NULL AND time_to_expiry_years > 0
    THEN ${gammaSQL}
    ELSE NULL
  END as gamma,

  CASE
    WHEN implied_volatility IS NOT NULL AND time_to_expiry_years > 0
    THEN ${vegaSQL}
    ELSE NULL
  END as vega,

  CASE
    WHEN implied_volatility IS NOT NULL AND time_to_expiry_years > 0
    THEN ${thetaSQL}
    ELSE NULL
  END as theta

FROM read_parquet('${params.inputPath}')
WHERE option_type IS NOT NULL  -- Only options, not futures
`;

  if (params.outputPath) {
    return `
COPY (
  ${selectClause}
) TO '${params.outputPath}' (FORMAT PARQUET, COMPRESSION SNAPPY);
`;
  }

  return selectClause;
}
