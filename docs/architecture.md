# Architecture

Layered: CLI → Application → Domain → Infrastructure

**Design:** Seq-based pagination, dual fetch (futures=concurrent chunks, options=streaming)

## Layers

```
┌──────────────────────────────────────┐
│  CLI (src/cli/index.ts)              │  Command parsing, progress display, queue management
└───────────────┬──────────────────────┘
                ↓
┌──────────────────────────────────────┐
│  Application (src/application/)      │
│  • Fetchers (Future, Option, Delivery, Volatility)
│  • Analytics (ParquetMerger, DuckDBEnricher)
│  • Filters (RiskFilters)
└───────────────┬──────────────────────┘
                ↓
┌──────────────────────────────────────┐
│  Domain (src/domain/)                │  Pure functions, no I/O
│  • black76.ts, moneyness.ts, models.ts
└───────────────┬──────────────────────┘
                ↓
┌──────────────────────────────────────┐
│  Infrastructure (src/infrastructure/)│
│  • deribit-client.ts (HTTP + rate limiting)
│  • queue.ts (BunQueue job queue)
│  • parquet-storage.ts (Parquet I/O)
│  • parquet-writer.ts (enriched Parquet with Greeks)
│  • duckdb-connection.ts, duckdb-greeks.ts
│  • rate-limiter.ts (token bucket)
└──────────────────────────────────────┘
```

## Components

### Fetchers
**FutureFetcher:** Check Parquet exists → fetch all trades [1, lastSeq] → write Parquet (idempotent via filesystem)
**OptionFetcher:** Check Parquet exists → fetch all trades [1, lastSeq] → write Parquet (idempotent via filesystem)
**DeliveryFetcher:** Paginated fetch → write Parquet
**VolatilityFetcher:** Single-fetch → write Parquet

### Analytics
**ParquetMerger:** TypeScript row-by-row ~1-2k/sec (legacy)
**DuckDBEnricher:** SQL vectorized ~20-50k/sec, 10-100x faster (recommended)
  - Black-76 as pure SQL (no UDF)
  - All CPU cores, streaming memory

### Domain (Pure Functions)
**black76.ts:** Pricing (call/put), Greeks (delta, gamma, vega, theta)
**moneyness.ts:** ITM/OTM classification
**models.ts:** Types, Zod schemas

### Infrastructure
**DeribitClient:** HTTP, rate limit (15 req/s), auto-retry, Zod validation
**QueueManager:** BunQueue (SQLite job queue, retry logic, concurrency control)
**ParquetStorage:** Direct Parquet I/O (read/write trades, instruments, deliveries, volatility)
**ParquetWriter:** Row-by-row Greeks, join delivery prices
**DuckDB:** WASM, Black-76 pure SQL, vectorized

## Storage Architecture

**Filesystem-based medallion architecture:**
1. `data/parquet-raw/BTC/*.parquet` - **Bronze**: Raw trades (one file per instrument)
2. `data/parquet-raw/deliveries/*.parquet` - Delivery/settlement prices
3. `data/parquet-raw/volatility/*.parquet` - Historical volatility
4. `data/parquet-duckdb/BTC.parquet` - **Silver/Gold**: Enriched with Greeks (single file per currency, DuckDBEnricher)
5. `data/queue.db` - BunQueue job queue (only SQLite database)

**No instrument metadata database** - All metadata embedded in Parquet files via `parseInstrumentName()`

## Data Flow

### Fetch
```
fetch-all BTC --kind option --min-expiration 3m --max-expiration 2026-08-21
  ↓
BunQueue: enqueue fetch-instruments + fetch-trades jobs
  ↓
fetch-instruments: API getInstruments(expired=true) → filter by expiration → return instruments
fetch-trades: For each instrument → enqueue fetch-option/fetch-future jobs
  ↓
fetch-option/future:
  1. Check if Parquet exists → skip if yes (idempotent)
  2. API getLastTradeSeq → get total count
  3. Fetch all trades [1, lastSeq] in memory
  4. Write to Parquet
  ↓
DeribitClient: shared rate limiter (15 req/s) → API → Zod validate
```

### Enrich (DuckDB)
```
enrich-with-duckdb BTC
  ↓
Read Parquet → Generate Black-76 SQL (CDF/PDF, d1/d2, Greeks) → DuckDB vectorized → Parquet
  ↓
~20-50k/sec, all cores
```

## Concurrency

**BunQueue:** 3 concurrent jobs (configurable)
**Rate Limiting:** Shared 15 req/s limiter across all workers (75% of Deribit's 20 req/s limit)
**Idempotency:** Re-run commands skip completed instruments via Parquet file existence checks

## Stack

**Runtime:** Bun (TypeScript, SQLite, test, bundler built-in)
**Language:** TypeScript (strict, no `any`)
**Storage:** Parquet (columnar analytics), SQLite (BunQueue jobs only)
**Validation:** Zod
**Queue:** BunQueue (embedded SQLite, retry logic, concurrency control)
**Analytics:** DuckDB WASM (vectorized SQL)
**Testing:** Bun test (90 tests passing)

## Directory Structure

```
deribit-historical-data/
├── src/
│   ├── cli/index.ts
│   ├── application/
│   │   ├── fetchers/       # Future, Option, Delivery fetchers
│   │   ├── analytics/      # ParquetMerger, DuckDBEnricher
│   │   └── filters/        # RiskFilters
│   ├── domain/             # black76, moneyness, models
│   └── infrastructure/     # deribit-client, database, queue, storage, duckdb
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── data/
│   ├── parquet-raw/
│   │   ├── BTC/            # Bronze: Raw trades per instrument
│   │   ├── deliveries/     # Delivery/settlement prices
│   │   └── volatility/     # Historical volatility
│   ├── parquet-duckdb/     # Silver/Gold: Enriched with Greeks
│   └── queue.db            # BunQueue job queue (only SQLite)
└── docs/
```

## Patterns

**Dependency Injection:** Explicit constructor deps (client, parquetStorage)
**Strategy:** Filesystem-based idempotency (check Parquet exists before fetch)
**Queue-based Pipeline:** BunQueue orchestrates instrument discovery → trade fetching
**Shared Rate Limiting:** Single DeribitClient instance with token bucket limiter
