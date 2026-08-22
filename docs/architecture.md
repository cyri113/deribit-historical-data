# Architecture

**Pattern:** Medallion (bronze/silver/gold), layered (CLI → Application → Domain → Infrastructure)

## Directory Structure

```
src/
├── cli/index.ts              # Commands: bronze, silver, pipeline
├── application/
│   ├── fetchers/             # FutureFetcher, OptionFetcher, DeliveryFetcher
│   └── analytics/            # DuckDBEnricher (Greeks computation)
├── domain/                   # Pure functions: black76.ts, models.ts, parseInstrumentName()
└── infrastructure/
    ├── deribit-client.ts     # HTTP + rate limit (15 req/s)
    ├── parquet-storage.ts    # Read/write Parquet files
    ├── duckdb-connection.ts  # DuckDB WASM instance
    ├── duckdb-greeks.ts      # Black-76 SQL generators
    ├── queue.ts              # BunQueue manager
    └── rate-limiter.ts       # Token bucket

data/
├── bronze/instruments/{ASSET}/*.parquet  # Raw trades
├── bronze/futures/*.parquet              # Dated futures
├── silver/{ASSET}.parquet                # Enriched with Greeks
├── gold/{ASSET}.parquet                  # Analytics-ready with trading metrics
└── queue.db                              # BunQueue state
```

## Components

### CLI (`src/cli/index.ts`)
- `bronze <currency>` → Enqueues: fetch-instruments, fetch-trades, fetch-dated-futures
- `silver <currency>` → Enqueues: enrich-duckdb
- `gold <currency>` → Enqueues: enrich-gold
- `pipeline <currency>` → Runs bronze + silver + gold sequentially
- `queue-worker` → Processes jobs from queue.db

### Application Layer

**Fetchers:**
- Check if bronze/.../file.parquet exists → skip (idempotent)
- Fetch trades via seq-based pagination [1, lastSeq]
- Write atomically to Parquet

**Analytics:**
- `DuckDBEnricher` - Single SQL query processes ALL files → single output (silver layer)
- `GoldEnricher` - Adds trading metrics to silver data (gold layer)

### Domain Layer (Pure Functions)
- `parseInstrumentName(str)` - Extract strike, expiry, type from filename
- `black76.ts` - Pricing formulas (not used; Greeks computed in SQL)

### Infrastructure

**DeribitClient:**
- Rate limit: 15 req/s (75% of Deribit's 20 req/s)
- Seq-based: `getTradesBySeq(instrument, startSeq, endSeq)`
- Loop detection: tracks previousSeq to prevent infinite loops
- Per-request retry: every endpoint method routes through a shared
  `withRetry` helper (3x, exponential backoff) that retries HTTP 429 / JSON-RPC
  error 10028 (rate limit) and any HTTP 5xx server error -- separate from
  BunQueue's job-level retry below (see design-decisions.md §5 note)

**ParquetStorage:**
- `getTradeFilePath(name)` → `data/bronze/instruments/{ASSET}/{name}.parquet`
- `getFuturesFilePath(name)` → `data/bronze/futures/{name}.parquet`
- Atomic writes, no append mode

**DuckDB:**
- WASM-based, in-process
- Greeks = pure SQL expressions (no UDFs)
- Vectorized execution: 20-50k trades/sec

**QueueManager (BunQueue):**
- SQLite-based job queue (data/queue.db)
- 3 concurrent jobs, retry 3x with exponential backoff
- Job types: fetch-instruments, fetch-trades, fetch-dated-futures, enrich-duckdb

## Data Flow

### Bronze Pipeline

```
bronze BTC --kind option --min-expiration 3m
  ↓
Job: fetch-instruments
  API getInstruments(BTC, option, expired=true)
  Filter: expiration_timestamp <= now AND >= 3m ago
  → Returns list of instruments
  ↓
Job: fetch-trades
  For each instrument:
    if exists(bronze/instruments/BTC/{name}.parquet) → skip
    else:
      lastSeq ← API getLastTradeSeq(instrument)
      trades ← API getAllTradesBySeq(instrument, 1, lastSeq)
      write bronze/instruments/BTC/{name}.parquet
  ↓
Job: fetch-dated-futures
  Extract unique expiries from option names via regex: ^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-
  For each expiry (e.g., BTC-29MAY26):
    if exists(bronze/futures/{expiry}.parquet) → skip
    else:
      fetch trades → write bronze/futures/{expiry}.parquet
```

### Silver Pipeline

```
silver BTC
  ↓
Job: enrich-duckdb
  DuckDB single SQL query:
    Read: bronze/instruments/BTC/*.parquet (one file per instrument)
    LEFT JOIN: bronze/futures/BTC-*.parquet (ASOF join on timestamp)
    Compute: delta, gamma, vega, theta via Black-76 SQL
    Compute: is_valid flag
    Write: silver/BTC.parquet (single file, all instruments)
  Reports is_valid coverage (%); throws if 0% valid (see design-decisions.md)
  ↓
Output: silver/BTC.parquet (21 fields; e.g. 4.58M trades / 14,267 instruments on a full 3-month BTC pull)
```

### Gold Pipeline

```
gold BTC
  ↓
Job: enrich-gold
  DuckDB single SQL query:
    Read: silver/BTC.parquet (single file, 21 fields)
    LEFT JOIN: bronze/deliveries/{index}.parquet on expiry date (real settlement prices)
    Compute: days_to_expiry, strike_delta, vol_regime, realized_vol_7day,
      iv_percentile_90day, execution-quality metrics (Roll spread, expected
      premium via Black-76, premium_collection_ratio), outcome_* metrics
      (forward-looking; see docs/data-model.md warning)
    Write: gold/BTC.parquet (single file, only rows with futures_price IS NOT NULL)
  ↓
Output: gold/BTC.parquet (38 fields; see docs/data-model.md for the full field list)
```

### ASOF Join (Forward Prices)

```sql
-- Extract expiry from instrument name, join to futures
LEFT JOIN (
  SELECT instrument_name, timestamp, price as futures_price
  FROM read_parquet('bronze/futures/*.parquet')
) futures
  ON regexp_extract(opt.instrument_name, '^([A-Z]+-[0-9]{1,2}[A-Z]{3}[0-9]{2})-', 1) = futures.instrument_name
  AND futures.timestamp <= opt.timestamp
QUALIFY ROW_NUMBER() OVER (PARTITION BY opt.trade_id ORDER BY futures.timestamp DESC) = 1
```

**Result:** Each option trade gets `futures_price` = nearest prior futures trade price

## Concurrency

- **BunQueue:** 3 parallel workers
- **Rate limit:** 15 req/s shared across all workers
- **Idempotency:** Re-run commands skip completed files

## Key Patterns

1. **Filesystem idempotency** - Check .parquet exists → skip (no DB tracking)
2. **Seq-based pagination** - Monotonic trade_seq, no gaps
3. **Metadata in filename** - Parse instrument name → no instrument table
4. **Single enrichment query** - Process ALL files in one SQL statement
5. **Strict forward pricing** - Greeks NULL if no futures_price (no fallback)
6. **ASOF join** - Match trades to forward prices by time

## Performance

- **Bronze:** 99% instruments complete in <10s (3 parallel)
- **Silver:** measured on a real 3-month BTC pull: 4.58M trades / 14,267
  instruments enriched in ~47s (~97k trades/sec)
- **Gold:** same dataset, 579,778 output rows (only trades with a matched
  futures_price) in ~5-15s
- **Bottleneck:** API rate limit (15 req/s) not computation

## Error Handling

- **API errors:** every `DeribitClient` endpoint retries 3x with exponential
  backoff on HTTP 429 / JSON-RPC 10028 / any HTTP 5xx (via `withRetry`),
  separate from BunQueue's job-level retry
- **Per-instrument fetch failures:** `fetch-trades` collects failed
  instrument names and throws (rather than silently reporting success) if
  any instrument failed after its own internal retries -- previously the job
  always resolved even with hundreds of silently-dropped instruments
- **Loop detection:** Track previousSeq, break if stuck
- **Job failures:** Visible in queue-dashboard
- **Crash recovery:** Re-run commands skip completed files; writes are
  atomic (temp path + rename), so an interrupted write can never leave a
  truncated file at the path the skip-check looks at
