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

## Gold Schema (27 fields = Silver + 6)

**File**: `gold/BTC.parquet` (analytics-ready, all instruments in single file)

**Silver fields (21) + Trading Metrics (3) + Market Conditions (3):**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| days_to_expiry | integer | Calculated | Days until expiration at trade time (for DTE filtering: 0DTE, 7DTE, 30DTE) |
| strike_delta | string | Delta buckets | Categorization: "5-delta", "10-delta", "25-delta", "50-delta", "deep-itm" |
| vol_regime | string | IV percentile | Volatility environment: "low" (<33%), "mid" (33-67%), "high" (>67%) based on 90-day window |
| realized_vol_7day | double | Calculated | 7-day realized volatility (annualized, percentage, from futures price returns) |
| iv_percentile_90day | double | Calculated | Current IV percentile rank vs 90-day history (0-1 scale) |
| iv_minus_rv_gap | double | Calculated | IV - RV spread (volatility risk premium indicator, positive = IV > RV) |

**Trading Metrics Formulas**:
- `days_to_expiry` = (expiration_timestamp - timestamp) / 86400000 (milliseconds to days)
- `strike_delta` = CASE buckets based on ABS(delta): ≤0.05, ≤0.10, ≤0.25, ≤0.50, else deep-itm
- `vol_regime` = PERCENT_RANK over 2160-row window (~90 days of hourly trades), then tertile classification
- `realized_vol_7day` = STDDEV(log_returns) over 168-hour window × √(365×24) - annualized percentage
- `iv_percentile_90day` = trailing 90-calendar-day IV percentile (0 = lowest IV in 90 days, 1 = highest), computed via a per-currency/per-day 0.5-wide IV histogram rolled up over the trailing 90 days and joined back to each trade — not a plain `PERCENT_RANK() OVER (ORDER BY implied_volatility ROWS BETWEEN N PRECEDING)`, which ties its window frame to the value-ordering and can look ahead in time (see `gold-enricher.ts` for details)
- `expected_premium` = Black-76 theoretical price (via `generatePriceSQL`) at entry — F=futures_price, K=strike, T=time_to_expiry_years, σ=implied_volatility/100 — converted to BTC-denominated units (÷ futures_price, matching Deribit's inverse-option `price` convention) and scaled by `amount`; NULL if futures_price, implied_volatility, or amount missing, or time_to_expiry_years ≤ 0
- `iv_minus_rv_gap` = implied_volatility - realized_vol_7day (NULL if no RV data)

**Use Case**:
- Strategy backtesting (filter by DTE, delta buckets, vol regimes)
- Research analysis (regime-based studies)
- Portfolio analytics (exposure by delta/DTE/regime)

**Recommendation**:
```sql
-- Use gold layer for backtesting with market condition filters
SELECT * FROM 'data/gold/BTC.parquet'
WHERE is_valid = true
  AND strike_delta = '25-delta'
  AND days_to_expiry BETWEEN 7 AND 30
  AND vol_regime = 'high'
  AND iv_minus_rv_gap > 5  -- IV at least 5% above RV (vol premium)
  AND realized_vol_7day IS NOT NULL  -- Has sufficient price history
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
