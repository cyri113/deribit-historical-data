# Data Model

Parquet storage schemas and data lifecycle. No SQLite for trade metadata (only BunQueue state).

## Storage Layers

```
data/
├── bronze/                          # Raw API data (medallion layer 1)
│   ├── instruments/BTC/*.parquet    # One file per instrument (BTC-29MAY26-70000-C.parquet)
│   ├── futures/*.parquet            # Dated futures for forward prices (BTC-29MAY26.parquet)
│   ├── deliveries/*.parquet         # Settlement prices (btc_usd.parquet)
│   └── volatility/*.parquet         # Historical volatility (BTC.parquet)
├── silver/                          # Enriched with Greeks (medallion layer 2)
│   └── BTC.parquet                  # Single file: all instruments + Greeks
├── gold/                            # Analytics-ready with trading metrics (medallion layer 3)
│   └── BTC.parquet                  # Single file: silver + trading metrics
└── queue.db                         # BunQueue job state (only SQLite)
```

---

## Bronze Schema (16 fields)

**File**: `bronze/instruments/BTC/BTC-29MAY26-70000-C.parquet`

| Field | Type | Description |
|-------|------|-------------|
| trade_id | string | Unique trade ID |
| trade_seq | bigint | Monotonic sequence (pagination key) |
| instrument_name | string | Full instrument name |
| timestamp | bigint | Unix milliseconds |
| price | double | Trade price |
| amount | double | Contract size |
| direction | string | "buy" or "sell" |
| tick_direction | int | Price movement direction |
| index_price | double | Spot index price |
| mark_price | double | Mark price |
| implied_volatility | double | **Percentage (65 = 65%, not 0.65)** |
| strike | double | Strike price |
| expiration_timestamp | bigint | Unix milliseconds |
| option_type | string | "call" or "put" |
| time_to_expiry_years | double | TTM in years (for Greeks) |

**⚠️ IV Format**: Deribit returns `implied_volatility: 65` = 65% → Use `iv/100` for Black-76 formula

**Metadata**: Extracted from filename via `parseInstrumentName()`
- `BTC-29MAY26-70000-C` → strike=70000, expiration=2026-05-29, type=call, currency=BTC

---

## Silver Schema (21 fields = Bronze + 5)

**File**: `silver/BTC.parquet` (all instruments in single file)

**Bronze fields (16) + Computed (5):**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| futures_price | double | ASOF join | Forward price from futures (NULL if no match) |
| delta | double | Black-76 | Option delta (NULL if no futures_price) |
| gamma | double | Black-76 | Option gamma (NULL if no futures_price) |
| vega | double | Black-76 | Vega per 1% vol change (NULL if no futures_price) |
| theta | double | Black-76 | Theta per day (NULL if no futures_price) |
| is_valid | boolean | Quality flag | TRUE = analytics-ready (has futures_price, IV>0, TTM>1day, valid Greeks) |

**Greeks Formula (Black-76)**:
- Inputs: F=futures_price, K=strike, T=time_to_expiry_years, σ=implied_volatility/100
- Computed via DuckDB vectorized SQL (no UDFs)
- **STRICT**: Greeks = NULL if no futures_price (no fallback to index_price)

**ASOF Join (Forward Prices)**:
```sql
LEFT JOIN futures
  ON regexp_extract(opt.instrument_name, '^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-', 1) = futures.instrument_name
  AND futures.timestamp <= opt.timestamp
QUALIFY ROW_NUMBER() OVER (PARTITION BY opt.trade_id ORDER BY futures.timestamp DESC) = 1
```
Each option trade matched to nearest prior futures trade by timestamp.

**Data Quality (`is_valid` flag)**:
- `TRUE` = Has futures_price, IV > 0, TTM > 1 day, valid Greeks (not NaN/Inf)
- `FALSE` = Missing futures, IV=0, very short-dated (<1 day), or invalid Greeks
- Recommendation: `WHERE is_valid = true` for analytics queries
- All data preserved for audit (spot price available in `index_price` column)

---

## Gold Schema (Silver + Trading Metrics + Execution Quality + Outcome Metrics)

**File**: `gold/BTC.parquet` (analytics-ready, all instruments in single file)

**⚠️ Entry-time features vs. outcome fields — DO NOT mix them in a backtest entry filter.**
Every field below is grouped as either an **entry-time feature** (knowable at the
trade's own timestamp — safe to use as a signal/filter) or an **outcome field**
(only knowable after the trade, at or after expiry — describes what happened,
never what was known). All outcome fields are prefixed `outcome_` for exactly
this reason: a naive `WHERE vol_regime = 'high' AND outcome_assignment_inferred = false`
looks like a single entry-time filter but silently uses information from the
future. Building a backtest entry signal from any `outcome_*` field is look-ahead
bias.

**Entry-time trading metrics:**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| days_to_expiry | integer | Calculated | Days until expiration at trade time (for DTE filtering: 0DTE, 7DTE, 30DTE) |
| strike_delta | string | Delta buckets | Categorization: "5-delta", "10-delta", "25-delta", "50-delta", "deep-itm" |
| vol_regime | string | IV percentile | Volatility environment: "low" (<33%), "mid" (33-67%), "high" (>67%) based on `iv_percentile_90day`; NULL if `iv_percentile_90day` is NULL |
| realized_vol_7day | double | Calculated | Trailing 7-calendar-day realized volatility (annualized, percentage, from futures price returns) |
| iv_percentile_90day | double | Calculated | Current IV percentile rank vs trailing 90-calendar-day history (0-1 scale); NULL if the window has fewer than 20 trades (see `iv_percentile_sample_size`) |
| iv_percentile_sample_size | integer | Calculated | Trade count backing `iv_percentile_90day`/`vol_regime` — use to apply a stricter cutoff than the pipeline's built-in 20-trade minimum if needed |
| iv_minus_rv_gap | double | Calculated | IV - RV spread (volatility risk premium indicator, positive = IV > RV) |

**Entry-time execution quality metrics:**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| trade_volume_7day | integer | Calculated | Count of trades for this instrument in the trailing 7-calendar-day window |
| bid_ask_spread_estimate | double | Roll (1984) estimator | Implied spread from serial covariance of consecutive trade-price changes; NULL when the bid/ask-bounce assumption doesn't hold (covariance ≥ 0) or fewer than 5 observations — trade-only data has no real quotes, so this is a proxy, not a measured spread |
| price_vs_mark_deviation | double | Calculated | `(price - mark_price) / mark_price` at the trade's own timestamp — NOT execution slippage (both values are concurrent; there is no pre-trade reference price in trade-only data). Measures deviation from Deribit's fair-value mark, which can reflect genuine urgency/skew or mark-price lag in fast IV moves |
| expected_premium | double | Black-76 | Theoretical price at entry via `generatePriceSQL` — F=futures_price, K=strike, T=time_to_expiry_years, σ=implied_volatility/100 — converted to BTC-denominated units (÷ futures_price, matching Deribit's inverse-option `price` convention) and scaled by `amount`; NULL if futures_price, implied_volatility, or amount missing, or time_to_expiry_years ≤ 0 |
| actual_premium_collected | double | Calculated | Sum of `price * amount` for this instrument in the trailing 7-calendar-day window |
| premium_collection_ratio | double | Calculated | `actual_premium_collected / expected_premium` — note the numerator is a 7-day rolling sum across many trades while the denominator is a single trade's theoretical price, so this ratio's absolute scale is not "1.0 = fair value" and is only meaningful for relative/directional comparison |

**Outcome metrics (forward-looking — see warning above):**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| outcome_settlement_price | double | Real Deribit delivery data (`bronze/deliveries/{index}.parquet`) | The actual settlement/delivery index price on the option's expiration date; NULL if delivery data wasn't fetched for that currency/date — never falls back to a proxy |
| outcome_forward_return_7day | double | Calculated | 7-calendar-day *forward* price return from entry, found via ASOF join to the next available trade ≥7 days later; explicitly uses future data, hence the `outcome_` prefix (previously named `realized_move_7day`, which was easy to confuse with the trailing, entry-safe `realized_vol_7day`) |
| outcome_assignment_inferred | boolean | Calculated | Whether the option was ITM at real settlement (`outcome_settlement_price` vs. `strike`); NULL if no settlement price is available |
| outcome_days_to_assignment | integer | Calculated | `days_to_expiry` if `outcome_assignment_inferred` is true, else NULL |

**Trading Metrics Formulas**:
- `days_to_expiry` = (expiration_timestamp - timestamp) / 86400000 (milliseconds to days)
- `strike_delta` = CASE buckets based on ABS(delta): ≤0.05, ≤0.10, ≤0.25, ≤0.50, else deep-itm
- `vol_regime` = tercile classification (low <33%, mid 33-67%, high >67%) of `iv_percentile_90day` — NOT a separate `PERCENT_RANK`; see `iv_percentile_90day` below for the underlying methodology
- `realized_vol_7day` = STDDEV(log_returns) over a genuine trailing 7-calendar-day `RANGE` window (not a row-count proxy — see note below) × √(365×24), annualized
- `iv_percentile_90day` = trailing 90-calendar-day IV percentile (0 = lowest IV in 90 days, 1 = highest), computed via a per-currency/per-day 0.5-wide IV histogram rolled up over the trailing 90 days and joined back to each trade — not a plain `PERCENT_RANK() OVER (ORDER BY implied_volatility ROWS BETWEEN N PRECEDING)`, which ties its window frame to the value-ordering and can look ahead in time (see `gold-enricher.ts` for details). NULL when the trailing window has fewer than 20 trades.
- `expected_premium` = Black-76 theoretical price (via `generatePriceSQL`) at entry — F=futures_price, K=strike, T=time_to_expiry_years, σ=implied_volatility/100 — converted to BTC-denominated units (÷ futures_price, matching Deribit's inverse-option `price` convention) and scaled by `amount`; NULL if futures_price, implied_volatility, or amount missing, or time_to_expiry_years ≤ 0
- `iv_minus_rv_gap` = implied_volatility - realized_vol_7day (NULL if no RV data)

**Note on "7-day" windows**: `realized_vol_7day`, `trade_volume_7day`, and
`actual_premium_collected` use a genuine calendar-time `RANGE BETWEEN INTERVAL
7 DAYS PRECEDING AND CURRENT ROW` window, not a row-count window (e.g. "168
PRECEDING rows"). A row-count proxy assumes roughly-hourly trade density,
which fails for illiquid instruments/eras — 168 trades for a single option
instrument can span weeks or months in thin markets, or minutes in a very
liquid one — so the calendar-time window is used to keep the stated duration
accurate regardless of trade density.

**Use Case**:
- Strategy backtesting (filter by DTE, delta buckets, vol regimes) — entry-time fields only
- Outcome analysis / P&L attribution — using `outcome_*` fields to evaluate what a strategy would have done, never as an entry condition
- Research analysis (regime-based studies)
- Portfolio analytics (exposure by delta/DTE/regime)

**Recommendation**:
```sql
-- Use gold layer for backtesting with market condition filters (entry-time only)
SELECT * FROM 'data/gold/BTC.parquet'
WHERE is_valid = true
  AND strike_delta = '25-delta'
  AND days_to_expiry BETWEEN 7 AND 30
  AND vol_regime = 'high'
  AND iv_minus_rv_gap > 5  -- IV at least 5% above RV (vol premium)
  AND realized_vol_7day IS NOT NULL  -- Has sufficient price history

-- Evaluate outcomes for that same entry cohort separately, never as part of the entry filter
SELECT strike_delta, vol_regime,
  AVG(CAST(outcome_assignment_inferred AS INT)) as assignment_rate,
  AVG(outcome_forward_return_7day) as avg_forward_return
FROM 'data/gold/BTC.parquet'
WHERE is_valid = true AND strike_delta = '25-delta' AND vol_regime = 'high'
GROUP BY 1, 2
```

---

## Data Lifecycle

```
1. bronze BTC --kind option --min-expiration 3m
   ↓
   Job: fetch-instruments
     - API getInstruments(BTC, option, expired=true)
     - Filter: expiration_timestamp <= now AND >= 3m ago
     - Returns list of instruments
   ↓
   Job: fetch-trades
     - For each instrument:
       if exists(bronze/instruments/BTC/{name}.parquet) → skip
       else:
         lastSeq ← API getLastTradeSeq(instrument)
         trades ← getAllTradesBySeq(instrument, 1, lastSeq)
         write bronze/instruments/BTC/{name}.parquet
   ↓
   Job: fetch-dated-futures
     - Extract expiries from option names: ^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-
     - For each expiry (e.g., BTC-29MAY26):
       if exists(bronze/futures/{expiry}.parquet) → skip
       else:
         fetch trades → write bronze/futures/{expiry}.parquet

2. silver BTC
   ↓
   Job: enrich-duckdb
     - Single DuckDB SQL query:
       Read: bronze/instruments/BTC/*.parquet (all files)
       LEFT JOIN: bronze/futures/BTC-*.parquet (ASOF join on timestamp)
       Compute: delta, gamma, vega, theta via Black-76 SQL
       Compute: is_valid flag
       Write: silver/BTC.parquet (single file)
   ↓
   Output: silver/BTC.parquet (all instruments, all trades, 21 fields)

3. gold BTC
   ↓
   Job: enrich-gold
     - Single DuckDB SQL query:
       Read: silver/BTC.parquet (single file)
       Compute: days_to_expiry, strike_delta, vol_regime
       Write: gold/BTC.parquet (single file)
   ↓
   Output: gold/BTC.parquet (all instruments, all trades, 24 fields)

4. pipeline BTC
   ↓
   bronze BTC → silver BTC → gold BTC (sequential)
```

---

## Storage Sizes

| Data | Typical Size | Example |
|------|--------------|---------|
| Single expiry (100 options) | 10-50 MB | bronze/instruments/BTC/ |
| 3 months expired (3,478 options) | 500 MB - 2 GB | bronze/instruments/BTC/ |
| Enriched (all instruments) | ~same as bronze | silver/BTC.parquet |
| Queue state | 1-10 MB | queue.db |

---

## Usage Examples

```sql
-- Analytics (recommended: filter for quality)
SELECT * FROM 'data/silver/BTC.parquet'
WHERE is_valid = true
  AND delta > 0.3

-- Research (include edge cases)
SELECT * FROM 'data/silver/BTC.parquet'

-- Quality audit
SELECT
  is_valid,
  COUNT(*) as count,
  COUNT(futures_price) as has_futures,
  COUNT(delta) as has_greeks
FROM 'data/silver/BTC.parquet'
GROUP BY is_valid
```
