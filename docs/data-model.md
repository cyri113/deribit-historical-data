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
| futures_price | double | Always NULL in bronze (declared in `RAW_TRADE_SCHEMA` but never written by the option fetcher) — the real forward price is computed later in Silver via the ASOF join to `bronze/futures/`. Present here only as schema dead weight; ignore this column when reading bronze directly. |
| strike | double | Strike price |
| expiration_timestamp | bigint | Unix milliseconds |
| option_type | string | "call" or "put" |
| time_to_expiry_years | double | TTM in years (for Greeks) |

**⚠️ IV Format**: Deribit returns `implied_volatility: 65` = 65% → Use `iv/100` for Black-76 formula

**Metadata**: Extracted from filename via `parseInstrumentName()`
- `BTC-29MAY26-70000-C` → strike=70000, expiration=2026-05-29, type=call, currency=BTC

**`bronze/futures/{expiry}.parquet`** (dated futures, one file per expiry — e.g. `BTC-29MAY26.parquet`):

| Field | Type | Description |
|-------|------|-------------|
| trade_id | string | Unique trade ID |
| trade_seq | bigint | Monotonic sequence |
| instrument_name | string | e.g. "BTC-29MAY26" |
| timestamp | bigint | Unix milliseconds |
| price | double | Futures trade price — this is the forward price ASOF-joined into Silver's `futures_price` |
| amount | double | Contract size |
| direction | string | "buy" or "sell" |
| tick_direction | int | Price movement direction |
| index_price | double | Spot index price |
| mark_price | double | Mark price |

**`bronze/deliveries/{index}.parquet`** (settlement prices, one file per index — e.g. `btc_usd.parquet`):

| Field | Type | Description |
|-------|------|-------------|
| index_name | string | e.g. "btc_usd" |
| date | string | Settlement calendar date, `YYYY-MM-DD` |
| delivery_price | double | Official Deribit settlement/delivery index price for that date |
| timestamp | bigint | Unix milliseconds for `date` |

Used by Gold to compute `outcome_settlement_price` / `outcome_assignment_inferred` — joined by matching an option's `expiration_timestamp` calendar date to `date` here (Deribit options settle 08:00 UTC against this index).

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

## Gold Schema (38 fields = Silver 21 + Trading Metrics 7 + Execution Quality 6 + Outcome Metrics 4)

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
| premium_collection_ratio | double | Calculated | `(price * amount) / expected_premium` for this trade — both single-trade quantities, so 1.0 = filled at exactly the Black-76 fair value; >1.0 = collected more than theoretical, <1.0 = less. NULL if the theoretical per-contract price (`expected_premium / amount`) is below Deribit's minimum price tick (0.0001 BTC) — for deep-OTM, seconds-to-expiry options Black-76 can return a near-zero theoretical price (e.g. 1e-190) while the market still prices at the tick floor, producing an arithmetically-correct but economically meaningless ratio otherwise (observed up to ~1e+185 on real data before this guard). (Previously divided the 7-day rolling sum `actual_premium_collected` by a single trade's `expected_premium`, a scale mismatch that produced ratios in the hundreds-to-thousands with no "1.0 = fair value" interpretation — fixed to compare like-for-like.) |

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
   ↓
   Job: fetch-deliveries (runs by default; skip with --skip-deliveries)
     - API getAllDeliveryPrices(btc_usd / eth_usd index)
     - write bronze/deliveries/{index}.parquet (date, delivery_price)
     - Required for gold's outcome_settlement_price / outcome_assignment_inferred;
       without it those fields are NULL (see Gold Schema warning above)
   ↓
   Job: fetch-volatility (runs by default; skip with --skip-volatility)
     - API getHistoricalVolatility(currency)
     - write bronze/volatility/{currency}.parquet (not currently joined into
       silver/gold -- available for ad hoc analysis)

2. silver BTC
   ↓
   Job: enrich-duckdb
     - Single DuckDB SQL query:
       Read: bronze/instruments/BTC/*.parquet (all files)
       LEFT JOIN: bronze/futures/BTC-*.parquet (ASOF join on timestamp)
       Compute: delta, gamma, vega, theta via Black-76 SQL
       Compute: is_valid flag
       Write: silver/BTC.parquet (single file)
     - Reports is_valid coverage (%) after writing; throws if 0% valid
       (almost always means futures data is missing/incomplete for this
       currency -- see is_valid section above)
   ↓
   Output: silver/BTC.parquet (all instruments, all trades, 21 fields)

3. gold BTC
   ↓
   Job: enrich-gold
     - Single DuckDB SQL query:
       Read: silver/BTC.parquet (single file)
       LEFT JOIN: bronze/deliveries/{index}.parquet on expiry date (if present)
       Compute: days_to_expiry, strike_delta, vol_regime, realized_vol_7day,
         iv_percentile_90day, execution-quality metrics, outcome_* metrics
       Write: gold/BTC.parquet (single file)
   ↓
   Output: gold/BTC.parquet (only trades with a matched futures_price --
     see Silver's ASOF join -- with entry-time + outcome fields; see Gold
     Schema above for the full field list)

4. pipeline BTC
   ↓
   bronze BTC → silver BTC → gold BTC (sequential)
```

---

## Storage Sizes

Measured on a real BTC pull (14,267 expired instruments, 4,580,450 trades):

| Data | Size | Example |
|------|------|---------|
| Bronze (all instruments) | ~2.2 GB across 14,267 files | bronze/instruments/BTC/ |
| Silver (all trades, 21 fields) | 196 MB, single file | silver/BTC.parquet |
| Gold (only trades with a matched futures_price -- ~13% of silver, 38 fields) | 72 MB, single file | gold/BTC.parquet |
| Queue state | 1-10 MB | queue.db |

Gold is smaller than Silver despite having more columns because it only
keeps rows where Silver's ASOF join found a forward price (`futures_price
IS NOT NULL`) -- required for the volatility/premium window calculations.
On this dataset that kept 579,778 of 4,580,450 Silver rows (~13%).

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
