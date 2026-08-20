# Data Model

Parquet storage formats, relationships, no SQLite database for trade metadata.

## Storage

1. **Parquet Raw** `data/parquet-raw/BTC/*.parquet` - Bronze layer (raw trades, one file per instrument)
2. **Parquet Deliveries** `data/parquet-raw/deliveries/*.parquet` - Delivery/settlement prices
3. **Parquet Volatility** `data/parquet-raw/volatility/*.parquet` - Historical volatility
4. **Parquet Enriched** `data/parquet-duckdb/BTC/*.parquet` - Silver/Gold layer (with Greeks)
5. **Queue** `data/queue.db` - BunQueue job queue (only SQLite database)

---

## Parquet Format (Raw)

**Structure:** `data/parquet-raw/{CURRENCY}/{INSTRUMENT}.parquet`

**Example:** `data/parquet-raw/BTC/BTC-25DEC24-60000-C.parquet`

**Fields:**
- `trade_seq` (integer) - Unique sequence number
- `timestamp` (bigint) - Unix ms
- `price` (double) - Trade price
- `index_price` (double) - Underlying index price
- `direction` (string) - "buy" or "sell"
- `amount` (double) - Trade size
- `iv` (double) - Implied volatility (percentage, e.g., 65 = 65%)

**⚠️ IV Format:** Deribit returns `iv:65` = 65% (use `iv/100` for Greeks calc)

**Metadata Embedded:** All instrument metadata extracted via `parseInstrumentName()` from filename
- `BTC-25DEC24-60000-C` → strike=60000, expiration=2024-12-25, option_type=call, currency=BTC

---

## Parquet Format (Enriched)

**Structure:** `data/parquet-duckdb/{CURRENCY}/{INSTRUMENT}.parquet`

**Fields (35):**
- **Trade:** trade_seq, timestamp, price, amount, direction, index_price, implied_volatility
- **Meta:** strike, expiration, option_type, time_to_expiry
- **Greeks:** delta, gamma, vega (per 1%), theta (per day), theoretical_price
- **Moneyness:** delivery_price, moneyness (ITM/ATM/OTM), intrinsic_value
- **Metrics:** annualized_yield, iv_rank_52w, expected_value, win_probability, sharpe_ratio

**Generation:** `enrich-with-duckdb BTC` (DuckDB SQL vectorized, 10-100x faster than TypeScript)

---

## Data Lifecycle

```
1. fetch-all BTC --kind option --min-expiration 3m
   ↓
   API getInstruments(expired=true) → filter by expiration
   ↓
   BunQueue: enqueue fetch-option jobs per instrument
   ↓
   For each instrument:
     - Check if Parquet exists → skip if yes (idempotent)
     - Fetch all trades [1, lastSeq] in memory
     - Write to Parquet → data/parquet-raw/BTC/{INSTRUMENT}.parquet

2. fetch-deliveries btc_usd
   ↓
   Write to data/parquet-raw/deliveries/btc_usd.parquet

3. fetch-volatility BTC
   ↓
   Write to data/parquet-raw/volatility/BTC.parquet

4. enrich-with-duckdb BTC
   ↓
   Read Parquet Raw → DuckDB SQL (Black-76 Greeks) → Parquet Enriched
   ↓
   Output: data/parquet-duckdb/BTC/{INSTRUMENT}.parquet
```

---

## Storage Sizes

**Typical:** Single expiry (100 options) ~10-50MB Parquet
**Large:** 4,640 expired options (3 months) ~500MB-2GB Parquet
**Queue:** `data/queue.db` ~1-10MB (job state only)

