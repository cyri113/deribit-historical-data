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
 * Generate bulk enrichment query for all instruments in a currency
 * Reads ALL Parquet files at once, computes Greeks in single vectorized pass
 *
 * NEW: Joins with dated futures to get forward prices for accurate Greeks
 */
export function generateBulkGreeksEnrichmentQuery(params: {
  inputPattern: string;       // e.g., 'data/parquet-raw/BTC/*.parquet'
  futuresPattern?: string;    // e.g., 'data/parquet-raw/futures/BTC-*.parquet'
  outputPath: string;         // e.g., 'data/parquet-duckdb/BTC.parquet'
}): string {
  const greeksParams = {
    // STRICT: Use futures forward price ONLY (no fallback to spot)
    // Without futures data, Greeks will be NULL (garbage in = garbage out)
    // This ensures Greeks are only calculated with correct Black-76 inputs
    forwardPrice: params.futuresPattern
      ? "futures_price"
      : "NULL",  // No futures data = no Greeks calculation
    strike: "strike",
    timeToExpiry: "time_to_expiry_years",
    volatility: "implied_volatility / 100.0", // Convert from percentage to decimal
    optionType: "option_type",
  };

  const deltaSQL = generateDeltaSQL(greeksParams);
  const gammaSQL = generateGammaSQL(greeksParams);
  const vegaSQL = generateVegaSQL(greeksParams);
  const thetaSQL = generateThetaSQL(greeksParams);

  // Build query with optional futures join
  const futuresJoin = params.futuresPattern ? `
    -- LEFT JOIN with futures to get forward prices
    LEFT JOIN (
      SELECT
        instrument_name as futures_instrument,
        timestamp as futures_timestamp,
        price as futures_price
      FROM read_parquet('${params.futuresPattern}')
    ) futures
    ON regexp_extract(opt.instrument_name, '^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-', 1) = futures.futures_instrument
    AND futures.futures_timestamp <= opt.timestamp
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY opt.trade_id
      ORDER BY futures.futures_timestamp DESC
    ) = 1
  ` : '';

  return `
COPY (
  SELECT
    -- Extract instrument name from filename
    regexp_extract(opt.filename, '/([^/]+)\\.parquet$', 1) as instrument_name,

    -- Original trade data
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
    ${params.futuresPattern ? 'futures.futures_price,' : ''}

    -- Computed Greeks (using forward price from futures when available)
    CASE
      WHEN opt.implied_volatility IS NOT NULL AND opt.time_to_expiry_years > 0
      THEN ${deltaSQL}
      ELSE NULL
    END as delta,

    CASE
      WHEN opt.implied_volatility IS NOT NULL AND opt.time_to_expiry_years > 0
      THEN ${gammaSQL}
      ELSE NULL
    END as gamma,

    CASE
      WHEN opt.implied_volatility IS NOT NULL AND opt.time_to_expiry_years > 0
      THEN ${vegaSQL}
      ELSE NULL
    END as vega,

    CASE
      WHEN opt.implied_volatility IS NOT NULL AND opt.time_to_expiry_years > 0
      THEN ${thetaSQL}
      ELSE NULL
    END as theta,

    -- Data quality flag for analytics filtering
    -- STRICT: Requires futures forward price for accurate Greeks
    -- TRUE = valid for backtesting/analysis (futures price, good IV, sufficient time, valid Greeks)
    -- FALSE = missing futures data, IV=0, very short-dated, or NaN Greeks
    (
      ${params.futuresPattern ? 'futures.futures_price IS NOT NULL AND' : 'false AND'}
      opt.implied_volatility > 0
      AND opt.time_to_expiry_years > 0.0027  -- > 1 day
      AND opt.implied_volatility IS NOT NULL
      AND opt.time_to_expiry_years > 0
      AND CASE
            WHEN opt.implied_volatility IS NOT NULL AND opt.time_to_expiry_years > 0
            THEN NOT (
              isnan(${deltaSQL}) OR isinf(${deltaSQL}) OR
              isnan(${gammaSQL}) OR isinf(${gammaSQL})
            )
            ELSE false
          END
    ) as is_valid

  FROM read_parquet('${params.inputPattern}', filename=true) opt
  ${futuresJoin}
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
