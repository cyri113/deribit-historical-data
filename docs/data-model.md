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

## Gold Schema (24 fields = Silver + 3)

**File**: `gold/BTC.parquet` (analytics-ready, all instruments in single file)

**Silver fields (21) + Trading Metrics (3):**

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| days_to_expiry | integer | Calculated | Days until expiration at trade time (for DTE filtering: 0DTE, 7DTE, 30DTE) |
| strike_delta | string | Delta buckets | Categorization: "5-delta", "10-delta", "25-delta", "50-delta", "deep-itm" |
| vol_regime | string | IV percentile | Volatility environment: "low" (<33%), "mid" (33-67%), "high" (>67%) |

**Trading Metrics Formulas**:
- `days_to_expiry` = (expiration_timestamp - timestamp) / 86400000 (milliseconds to days)
- `strike_delta` = CASE buckets based on ABS(delta): ≤0.05, ≤0.10, ≤0.25, ≤0.50, else deep-itm
- `vol_regime` = PERCENT_RANK over 720-row window (~30 days), then tertile classification

**Use Case**:
- Strategy backtesting (filter by DTE, delta buckets, vol regimes)
- Research analysis (regime-based studies)
- Portfolio analytics (exposure by delta/DTE/regime)

**Recommendation**:
```sql
-- Use gold layer for backtesting
SELECT * FROM 'data/gold/BTC.parquet'
WHERE is_valid = true
  AND strike_delta = '25-delta'
  AND days_to_expiry BETWEEN 7 AND 30
  AND vol_regime IN ('mid', 'high')
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
