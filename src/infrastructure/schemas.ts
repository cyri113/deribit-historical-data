import parquet from "parquetjs";

/**
 * DELIVERY_PRICE_SCHEMA - Silver Layer (Ingestion: API → Parquet)
 *
 * Settlement/delivery prices from Deribit API.
 * Used for calculating moneyness at option expiry.
 */
export const DELIVERY_PRICE_SCHEMA = new parquet.ParquetSchema({
  index_name: { type: "UTF8" },
  date: { type: "UTF8" }, // YYYY-MM-DD format
  delivery_price: { type: "DOUBLE" },
  timestamp: { type: "TIMESTAMP_MILLIS" }, // Parsed from date (midnight UTC)
});

/**
 * HISTORICAL_VOLATILITY_SCHEMA - Silver Layer (Ingestion: API → Parquet)
 *
 * Historical volatility data from Deribit API.
 * Measures the degree of price variation over past periods.
 * Useful for risk assessment and option pricing analysis.
 */
export const HISTORICAL_VOLATILITY_SCHEMA = new parquet.ParquetSchema({
  currency: { type: "UTF8" },
  timestamp: { type: "TIMESTAMP_MILLIS" },
  volatility_value: { type: "DOUBLE" },
});

/**
 * INSTRUMENT_SCHEMA - Silver Layer (Ingestion: API → Parquet)
 *
 * Instrument metadata from Deribit API.
 * Contains static information about each tradable instrument.
 */
export const INSTRUMENT_SCHEMA = new parquet.ParquetSchema({
  instrument_name: { type: "UTF8" },
  kind: { type: "UTF8" }, // 'future', 'option', 'spot', etc.
  base_currency: { type: "UTF8" },
  expiration_timestamp: { type: "TIMESTAMP_MILLIS", optional: true },
  strike: { type: "DOUBLE", optional: true },
  option_type: { type: "UTF8", optional: true }, // 'call' or 'put'
  is_active: { type: "BOOLEAN", optional: true },
  settlement_period: { type: "UTF8", optional: true },
});

/**
 * FUTURES_TRADE_SCHEMA - Bronze Layer (Ingestion: API → Parquet)
 *
 * Dated futures trades (e.g., BTC-10AUG26) used to derive forward prices for options Greeks.
 * Stored separately from options trades for efficient joins in DuckDB.
 *
 * Purpose:
 * - Provide forward prices for Black-76 Greeks calculations
 * - One file per dated futures contract (e.g., BTC-10AUG26.parquet)
 * - Joined with options via ASOF join on timestamp + expiry match
 */
export const FUTURES_TRADE_SCHEMA = new parquet.ParquetSchema({
  // Trade identifiers
  trade_id: { type: "UTF8" },
  trade_seq: { type: "INT64" },
  instrument_name: { type: "UTF8" }, // e.g., "BTC-10AUG26"
  timestamp: { type: "TIMESTAMP_MILLIS" },

  // Trade data
  price: { type: "DOUBLE" }, // This is the forward price we need!
  amount: { type: "DOUBLE" },
  direction: { type: "UTF8" },
  tick_direction: { type: "INT32" },

  // Market data (from API)
  index_price: { type: "DOUBLE" }, // Spot price for reference
  mark_price: { type: "DOUBLE", optional: true },
});

/**
 * RAW_TRADE_SCHEMA - Bronze Layer (Ingestion: API → Parquet)
 *
 * Contains only raw trade data from Deribit API with basic instrument metadata.
 * No computed fields (Greeks, moneyness, trading metrics) - those are in Gold layer.
 *
 * Purpose:
 * - Typed, columnar storage format for efficient queries
 * - Baseline for enrichment pipeline
 * - No expensive computations yet
 */
export const RAW_TRADE_SCHEMA = new parquet.ParquetSchema({
  // Trade identifiers
  trade_id: { type: "UTF8" },
  trade_seq: { type: "INT64" },
  instrument_name: { type: "UTF8" },
  timestamp: { type: "TIMESTAMP_MILLIS" },

  // Trade data
  price: { type: "DOUBLE" },
  amount: { type: "DOUBLE" },
  direction: { type: "UTF8" },
  tick_direction: { type: "INT32" },

  // Market data (from API)
  index_price: { type: "DOUBLE" },
  mark_price: { type: "DOUBLE", optional: true },
  implied_volatility: { type: "DOUBLE", optional: true },
  futures_price: { type: "DOUBLE", optional: true }, // Forward price from dated futures contract

  // Instrument metadata (parsed from name)
  // Note: These are optional to support futures/perpetuals (which don't have strike/option_type)
  strike: { type: "DOUBLE", optional: true },
  expiration_timestamp: { type: "TIMESTAMP_MILLIS", optional: true },
  option_type: { type: "UTF8", optional: true }, // 'call' or 'put' (null for futures/perpetuals)
  time_to_expiry_years: { type: "DOUBLE", optional: true },
});

/**
 * ENRICHED_TRADE_SCHEMA - Gold Layer (Stage 1: Silver → Gold)
 *
 * Extends raw trade data with computed metrics using DuckDB for memory efficiency:
 * - Greeks (Black-76 model)
 * - Moneyness classification
 * - Delivery price at expiry
 * - Trading metrics (annualized yield, IV rank, expected value)
 *
 * This is the final output for analysis and machine learning.
 */
export const ENRICHED_TRADE_SCHEMA = new parquet.ParquetSchema({
  // ===== RAW TRADE DATA (from silver layer) =====

  // Trade identifiers
  trade_id: { type: "UTF8" },
  trade_seq: { type: "INT64" },
  instrument_name: { type: "UTF8" },
  timestamp: { type: "TIMESTAMP_MILLIS" },

  // Trade data
  price: { type: "DOUBLE" },
  amount: { type: "DOUBLE" },
  direction: { type: "UTF8" },
  tick_direction: { type: "INT32" },

  // Market data
  index_price: { type: "DOUBLE" },
  mark_price: { type: "DOUBLE", optional: true },
  implied_volatility: { type: "DOUBLE", optional: true },

  // Instrument metadata
  strike: { type: "DOUBLE" },
  expiration_timestamp: { type: "TIMESTAMP_MILLIS" },
  option_type: { type: "UTF8" }, // 'call' or 'put'
  time_to_expiry_years: { type: "DOUBLE" },

  // ===== COMPUTED FIELDS (enrichment) =====

  // Greeks (Black-76 model)
  delta: { type: "DOUBLE", optional: true },
  gamma: { type: "DOUBLE", optional: true },
  vega: { type: "DOUBLE", optional: true },
  theta: { type: "DOUBLE", optional: true },
  theoretical_price: { type: "DOUBLE", optional: true },

  // Moneyness (at expiry)
  delivery_price: { type: "DOUBLE", optional: true },
  moneyness: { type: "UTF8", optional: true }, // 'ITM', 'ATM', 'OTM'
  intrinsic_value: { type: "DOUBLE", optional: true },
  moneyness_percentage: { type: "DOUBLE", optional: true },

  // Trading Metrics

  // 1. Annualized Premium Yield
  annualized_premium_yield: { type: "DOUBLE", optional: true },

  // 2. IV Rank (52-Week Percentile) - cross-instrument
  iv_rank_52w: { type: "DOUBLE", optional: true }, // Percentile (0-100)
  iv_52w_high: { type: "DOUBLE", optional: true },
  iv_52w_low: { type: "DOUBLE", optional: true },
  iv_52w_mean: { type: "DOUBLE", optional: true },
  iv_52w_stddev: { type: "DOUBLE", optional: true },

  // 3. Expected Value (Stress Scenarios)
  expected_value_btc: { type: "DOUBLE", optional: true },
  win_probability: { type: "DOUBLE", optional: true }, // Percentage (0-100)
  max_loss_btc: { type: "DOUBLE", optional: true },
  max_gain_btc: { type: "DOUBLE", optional: true },
  sharpe_ratio: { type: "DOUBLE", optional: true },
});
