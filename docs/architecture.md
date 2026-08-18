# System Architecture

## Overview

The Deribit Historical Data Pipeline follows a layered architecture with clear separation of concerns. The system is designed around sequence-based pagination and dual-strategy fetching for optimal performance across different instrument types.

## Architectural Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     Presentation Layer                      │
│                  src/cli/index.ts                           │
│  • Command parsing                                          │
│  • User interaction                                         │
│  • Progress reporting                                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
│              src/application/                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Fetchers                                           │   │
│  │  • FutureFetcher    (chunk-based, concurrent)       │   │
│  │  • OptionFetcher    (streaming, lazy)               │   │
│  │  • DeliveryFetcher  (paginated)                     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Analytics                                          │   │
│  │  • GreeksCalculator (deprecated - SQLite-based)     │   │
│  │  • ParquetMerger    (JSONL → Parquet pipeline)     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Filters                                            │   │
│  │  • RiskFilters (Greek-based filtering)              │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Domain Layer                             │
│                  src/domain/                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Business Logic (Pure Functions)                    │   │
│  │  • black76.ts      (pricing formulas)               │   │
│  │  • moneyness.ts    (ITM/OTM calculations)           │   │
│  │  • models.ts       (types & parsers)                │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 Infrastructure Layer                        │
│               src/infrastructure/                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  External I/O                                       │   │
│  │  • deribit-client.ts  (HTTP + rate limiting)        │   │
│  │  • database.ts        (SQLite operations)           │   │
│  │  • jsonl-storage.ts   (JSONL file I/O)              │   │
│  │  • parquet-writer.ts  (Parquet enrichment)          │   │
│  │  • rate-limiter.ts    (token bucket)                │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 Storage (Two-Layer)                         │
│  • data/jsonl/BTC/*.jsonl    (source: crash-safe trades)    │
│  • data/parquet/BTC/*.parquet (analytics: enriched data)    │
│  • deribit-data.db           (metadata + checkpoints)       │
└─────────────────────────────────────────────────────────────┘
```

## Layer Responsibilities

### 1. Presentation Layer (CLI)
**Purpose:** User interface and command orchestration

**Key Files:**
- `src/cli/index.ts` - Main CLI entry point

**Responsibilities:**
- Parse command-line arguments
- Validate user input
- Instantiate and coordinate application services
- Display progress and results
- Handle errors and provide user feedback

**Design Principles:**
- Thin layer - minimal business logic
- Delegates to application layer
- Focused on UX and formatting

### 2. Application Layer
**Purpose:** Orchestration of business workflows

**Key Components:**

#### Fetchers (`src/application/fetchers/`)
- **FutureFetcher:** Handles perpetual and dated futures
  - Pre-allocates chunks (e.g., seq 1-10000, 10001-20000)
  - Fetches chunks concurrently (default: 3-5 parallel)
  - Updates `future_chunks` table for resumability

- **OptionFetcher:** Handles options contracts
  - Streams trades starting from `last_no + 1`
  - Lazy chunk enqueue (fetches next chunk only after success)
  - Updates `option_progress` table

- **DeliveryFetcher:** Fetches settlement prices
  - Paginated API calls (offset-based)
  - Stores in `delivery_prices` table

#### Analytics (`src/application/analytics/`)
- **ParquetMerger:** Orchestrates JSONL → Parquet pipeline
  - Coordinates ParquetWriter with database/storage
  - Batch processing with date filtering
  - Progress tracking and error handling

- **GreeksCalculator (deprecated):** Legacy SQLite-based Greeks
  - Previously computed Greeks to SQLite
  - Replaced by on-the-fly computation during Parquet merge

#### Filters (`src/application/filters/`)
- **RiskFilters:** Greek-based filtering
  - Configurable thresholds (delta, gamma, vega, theta)
  - Moneyness filters (ITM/OTM)
  - Preset filter configurations

**Design Principles:**
- Dependency injection (services passed via constructors)
- Separation of futures vs options strategies
- Progress tracking and logging
- Error handling and retry logic

### 3. Domain Layer
**Purpose:** Pure business logic (no I/O)

**Key Components:**
- **black76.ts:** Black-76 pricing model
  - Option pricing (call/put)
  - Greeks calculation (delta, gamma, vega, theta)
  - Pure mathematical functions

- **moneyness.ts:** ITM/OTM classification
  - Compares strike vs delivery price
  - Handles call/put logic

- **models.ts:** Type definitions
  - Domain types (Trade, Greeks, Instrument)
  - Zod schemas for API validation
  - Parser utilities (e.g., `parseInstrumentName`)

**Design Principles:**
- Pure functions (deterministic, no side effects)
- No dependencies on infrastructure
- Fully testable without mocks
- Mathematical correctness

### 4. Infrastructure Layer
**Purpose:** External system integration

**Key Components:**

#### DeribitClient (`deribit-client.ts`)
- HTTP client for Deribit API
- Rate limiting (15 req/s token bucket)
- Automatic retries with exponential backoff
- Zod validation of responses
- Supports both main and history APIs

#### Database (`database.ts`)
- SQLite wrapper with prepared statements
- Schema management (auto-initialization)
- Batch inserts for performance
- Checkpoint/progress tracking
- WAL mode for concurrency

#### JSONLStorage (`jsonl-storage.ts`)
- Append-only file writes
- Per-instrument JSONL files
- Crash-safe flush operations
- File handle management

#### ParquetWriter (`parquet-writer.ts`)
- Reads trades from JSONL
- Computes Greeks on-the-fly (Black-76)
- Joins with delivery prices
- Calculates moneyness (ITM/ATM/OTM)
- Writes enriched Parquet files
- ~10x compression vs JSONL

#### RateLimiter (`rate-limiter.ts`)
- Token bucket algorithm
- Configurable rate (default: 15 req/s)
- Async queue management

**Design Principles:**
- Single responsibility per module
- Interface-based design (injectable)
- Error handling and logging
- Performance optimization (batching, caching)

## Data Flow

### Fetch Workflow (Seq-Based)

```
┌──────────────┐
│   CLI        │ fetch-trades BTC
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  Application Layer                                   │
│                                                      │
│  For each instrument in instruments table:          │
│                                                      │
│  IF kind == "future":                               │
│    ┌─────────────────────────────────────┐          │
│    │ FutureFetcher                       │          │
│    │ 1. Get last_seq from API            │          │
│    │ 2. Create chunks (1-10k, 10k-20k...)│          │
│    │ 3. Fetch chunks in parallel         │          │
│    │ 4. For each chunk:                  │          │
│    │    • Fetch trades (API)             │──────────┼──┐
│    │    • Write JSONL (flush)            │          │  │
│    │    • Mark chunk done (DB)           │          │  │
│    └─────────────────────────────────────┘          │  │
│                                                      │  │
│  ELSE IF kind == "option":                          │  │
│    ┌─────────────────────────────────────┐          │  │
│    │ OptionFetcher                       │          │  │
│    │ 1. Get last_no from DB              │          │  │
│    │ 2. Stream from last_no + 1          │          │  │
│    │ 3. While has_more:                  │          │  │
│    │    • Fetch chunk (API)              │──────────┼──┤
│    │    • Write JSONL (flush)            │          │  │
│    │    • Update last_no (MAX guard)     │          │  │
│    │ 4. Mark complete                    │          │  │
│    └─────────────────────────────────────┘          │  │
└──────────────────────────────────────────────────────┘  │
                                                          │
┌─────────────────────────────────────────────────────────┤
│  Infrastructure Layer                                   │
│                                                          │
│  DeribitClient:                                         │
│  • acquire() rate limiter token                         │
│  • POST /get_last_trades_by_instrument                  │
│    params: { start_seq, end_seq, count }                │
│  • Validate response with Zod                           │
│  • Return trades                                        │
│                                                          │
│  JSONLStorage:                                          │
│  • getSink(instrument_name)                             │
│  • write JSON line-by-line                              │
│  • flush() to ensure disk persistence                   │
│                                                          │
│  Database:                                              │
│  • updateOptionProgress(instrument, last_no, count)     │
│  • markFutureChunkDone(instrument, chunk, count)        │
└─────────────────────────────────────────────────────────┘
```

### Greeks Calculation Workflow

```
┌──────────────┐
│   CLI        │ compute-greeks BTC-27DEC24-60000-C
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  Application Layer: GreeksCalculator                 │
│  1. Read trades from JSONL                           │──┐
│  2. For each trade:                                  │  │
│     • Extract: price, IV, timestamp, index_price     │  │
│     • Parse instrument → get strike, expiration      │  │
│     • Calculate time_to_expiry                       │  │
│     • Call domain functions ────────────────────┐    │  │
│  3. Store Greeks in DB                          │    │  │
└─────────────────────────────────────────────────┼────┘  │
                                                  │       │
┌─────────────────────────────────────────────────┼───────┤
│  Domain Layer: black76.ts                       │       │
│  calculateGreeks(F, K, T, σ, type):             │       │
│    • delta  = e^(-rT) * N(d1)                   │       │
│    • gamma  = e^(-rT) * N'(d1) / (F*σ*√T)       │       │
│    • vega   = e^(-rT) * F * N'(d1) * √T / 100   │       │
│    • theta  = ... (time decay)                  │       │
│  Return { delta, gamma, vega, theta }           │       │
└─────────────────────────────────────────────────┘       │
                                                           │
┌──────────────────────────────────────────────────────────┤
│  Infrastructure Layer: JSONLStorage                      │
│  readTrades(instrument_name):                            │
│    • Read file line-by-line                              │
│    • Parse JSON                                          │
│    • Return DeribitTrade[]                               │
└──────────────────────────────────────────────────────────┘
```

## Concurrency Model

### Futures: Concurrent Chunk Fetching
```
Instrument: BTC-PERPETUAL (last_seq = 300,000,000)
Chunks: 30,000 chunks of 10k trades each

┌────────────┐   ┌────────────┐   ┌────────────┐
│ Chunk 1-10k│   │Chunk 10k-20│   │Chunk 20k-30│  ← 5 parallel workers
└─────┬──────┘   └─────┬──────┘   └─────┬──────┘
      │                │                │
      └────────────────┴────────────────┘
                       │
                ┌──────▼──────┐
                │ Rate Limiter│ 15 req/s
                └─────────────┘
```

**Advantages:**
- 10-50x speedup for large datasets
- Resumable at chunk granularity
- No ordering dependencies

**Chunk Strategy:**
- Pre-allocate all chunks upfront
- Mark chunks as done atomically
- Incomplete chunks fetched on restart

### Options: Sequential Streaming
```
Instrument: BTC-27DEC24-60000-C (unknown total trades)

┌──────────────────────────────────────────────┐
│  Stream:  last_no+1 → last_no+10k → ...      │
└──────────────────────────────────────────────┘
                     │
              ┌──────▼──────┐
              │ Rate Limiter│
              └─────────────┘
```

**Advantages:**
- No need to know total trade count upfront
- Efficient for small datasets (most options have < 10k trades)
- Memory efficient (constant space)

**Streaming Strategy:**
- Start from last_no + 1
- Fetch chunks lazily (enqueue next on success)
- Stop when API returns no trades

## Technology Stack

### Runtime & Language
- **Bun:** Fast TypeScript runtime with built-in SQLite, test runner, bundler
- **TypeScript:** Strict mode, no `any`, full type safety

### Storage
- **SQLite:** Metadata and checkpoints (WAL mode for concurrency)
- **JSONL:** Trade data (append-only, human-readable, crash-safe)
- **Parquet:** (Planned) Columnar format for analytics

### Data Validation
- **Zod:** Runtime schema validation for API responses
- Ensures type safety at runtime
- Graceful handling of API changes

### HTTP & Networking
- **Fetch API:** Built into Bun, no external HTTP library
- **Token Bucket:** Custom rate limiter implementation

### Testing
- **Bun Test:** Built-in test runner
- Unit, integration, and E2E tests
- 90%+ code coverage

## Directory Structure

```
deribit-historical-data/
├── src/
│   ├── cli/
│   │   └── index.ts              # CLI entry point
│   ├── application/
│   │   ├── fetchers/
│   │   │   ├── future-fetcher.ts  # Futures download strategy
│   │   │   ├── option-fetcher.ts  # Options download strategy
│   │   │   └── delivery-fetcher.ts
│   │   ├── analytics/
│   │   │   └── greeks-calculator.ts
│   │   └── filters/
│   │       └── risk-filters.ts
│   ├── domain/
│   │   ├── black76.ts            # Pure pricing functions
│   │   ├── moneyness.ts          # ITM/OTM logic
│   │   └── models.ts             # Types & schemas
│   └── infrastructure/
│       ├── deribit-client.ts     # API client
│       ├── database.ts           # SQLite wrapper
│       ├── jsonl-storage.ts      # File I/O
│       └── rate-limiter.ts       # Token bucket
├── tests/
│   ├── unit/                     # Pure function tests
│   ├── integration/              # DB + API tests
│   └── e2e/                      # Full pipeline tests
├── data/
│   └── jsonl/                    # Trade data files
│       ├── BTC/
│       │   ├── BTC-PERPETUAL.jsonl
│       │   └── BTC-27DEC24-60000-C.jsonl
│       └── ETH/
├── docs/                         # This documentation
├── deribit-data.db               # Metadata database
├── package.json
├── tsconfig.json
└── README.md
```

## Design Patterns

### Dependency Injection
All services accept dependencies via constructors:
```typescript
class FutureFetcher {
  constructor(config: {
    client: DeribitClient;
    database: Database;
    storage: JSONLStorage;
  }) { ... }
}
```

**Benefits:**
- Testability (easy to mock)
- Flexibility (swap implementations)
- Clear dependencies

### Strategy Pattern
Two fetch strategies for different instrument types:
- FutureFetcher (chunk-based)
- OptionFetcher (streaming)

**Benefits:**
- Optimized for each use case
- Clean separation of concerns
- Easy to extend

### Repository Pattern
Database acts as repository for all data entities:
```typescript
database.getInstruments(currency, kind)
database.getOptionProgress(instrumentName)
database.markFutureChunkDone(...)
```

**Benefits:**
- Encapsulates storage logic
- Consistent API
- Easy to test

### Builder Pattern
CLI uses builder-style configuration:
```typescript
const fetcher = new FutureFetcher({
  client: new DeribitClient({ rateLimiter }),
  database: new Database("deribit-data.db"),
  storage: new JSONLStorage("./data/jsonl"),
  chunkSize: 10000,
  concurrency: 5,
});
```

## Comparison: Old vs New Architecture

| Aspect | Old (Timestamp) | New (Seq-Based) |
|--------|-----------------|-----------------|
| **Pagination** | Time windows | Sequence ranges |
| **Determinism** | Non-deterministic | Deterministic |
| **Storage** | SQLite only | JSONL + SQLite |
| **Resumability** | Timestamp checkpoints | Chunk/offset checkpoints |
| **Futures Strategy** | Sequential | Concurrent chunks |
| **Options Strategy** | Sequential | Streaming (lazy) |
| **Memory** | O(batch_size) | O(batch_size) |
| **API Endpoint** | www.deribit.com | history.deribit.com |

See [Design Decisions](design-decisions.md) for rationale behind the new architecture.

---

**Next:** [Design Decisions →](design-decisions.md)
