# Deribit Historical Data Pipeline

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-grade TypeScript/Bun system for fetching complete historical trade data from Deribit's cryptocurrency derivatives exchange. Features resumable downloads, crash-safe storage, and 10-50x performance improvements through concurrent chunk fetching.

## What This Does

- **Fetches complete historical data** for cryptocurrency options and futures from Deribit
- **Sequence-based pagination** ensures deterministic results with no gaps or duplicates
- **Dual fetch strategies** optimize for different instrument types (futures vs options)
- **Hybrid JSONL→Parquet storage** with automatic conversion and cleanup on completion
- **Analytics-ready Parquet** with enriched data (Greeks, moneyness, delivery prices)
- **Black-76 option pricing** with on-the-fly Greeks calculation (delta, gamma, vega, theta)
- **Production-ready** with rate limiting, retries, and comprehensive error handling

## Quick Start

```bash
# Install dependencies
bun install

# Start the progress dashboard (optional)
bun src/web/server.ts
# Then open http://localhost:3000 in your browser

# Fetch all BTC instruments (options + futures)
bun src/cli/index.ts fetch-instruments BTC

# Download historical trades (auto-detects futures vs options strategy)
bun src/cli/index.ts fetch-trades BTC --concurrency 5

# Fetch settlement prices
bun src/cli/index.ts fetch-deliveries btc_usd

# Or run complete pipeline
bun src/cli/index.ts fetch-all BTC

# Convert to enriched analytics Parquet (with Greeks + moneyness)
bun src/cli/index.ts merge-to-parquet BTC
```

**Output:**
- Raw trade data: `data/parquet-raw/BTC/*.parquet` (auto-converted from JSONL on completion)
- Analytics data: `data/parquet/BTC/*.parquet` (enriched with Greeks + moneyness)
- Temporary JSONL: `data/jsonl/BTC/*.jsonl` (only for in-progress instruments, auto-deleted)
- Metadata: `deribit-data.db` (SQLite with checkpoints)

## Key Features

### 🚀 High Performance
- **Concurrent chunk fetching** for large futures (10-50x speedup)
- **Streaming architecture** for options (constant memory usage)
- **Rate limiting** with token bucket (15 req/s sustainable)
- **Batch processing** with optimized SQLite and JSONL storage

### 🔒 Reliability
- **Sequence-based pagination** (deterministic, no gaps)
- **Crash-safe hybrid storage** (JSONL for in-progress, Parquet for completed)
- **Automatic resumability** (chunk-level for futures, offset for options)
- **Disk-first writes** (prefer duplicates over data loss)
- **Auto-cleanup** (JSONL deleted after Parquet conversion)

### 📊 Data Quality
- **Complete historical coverage** (all instruments from Deribit)
- **Runtime validation** with Zod schemas
- **Deduplication** during merge (JSONL → Parquet)
- **Gap detection** and validation tools

### 🧮 Analytics
- **Hybrid storage pipeline** - JSONL (in-progress) → Parquet (completed) → Enriched Parquet (analytics)
- **Auto-conversion** - Raw Parquet created automatically when instrument fetch completes
- **On-the-fly Greeks** calculation during enrichment (Black-76 model)
- **Moneyness classification** (ITM/ATM/OTM) using delivery prices
- **Columnar storage** for 10-100x faster queries vs JSONL
- **~10x compression** ratio (Parquet vs raw JSONL)

### 📊 Real-time Progress Dashboard
- **Web UI** - Live progress monitoring at `http://localhost:3000`
- **100ms updates** - Near real-time WebSocket updates
- **Instrument tracking** - Status (pending/in-progress/completed), progress bars, trade counts
- **Filtering & pagination** - Sort by progress/name/trades, filter by type/status
- **CLI-inspired design** - Dark theme, monospace fonts, terminal aesthetics

## Architecture

```
┌─────────────────────┐
│  Deribit API        │  history.deribit.com (seq-based pagination)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  Application Layer                      │
│  • FutureFetcher  (concurrent chunks)   │
│  • OptionFetcher  (streaming)           │
│  • DeliveryFetcher (paginated)          │
└──────────┬──────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Infrastructure                          │
│  • DeribitClient    (HTTP + rate limit)  │
│  • JSONLStorage     (temp, in-progress)  │
│  • ParquetStorage   (auto-conversion)    │
│  • Database         (SQLite checkpoints) │
│  • ParquetWriter    (analytics enrich)   │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Storage (Hybrid Three-Layer)                │
│  1. data/jsonl/*/*.jsonl (temp, deleted)     │
│  2. data/parquet-raw/*/*.parquet (raw data)  │
│  3. data/parquet/*/*.parquet (analytics)     │
│  • deribit-data.db (metadata + checkpoints)  │
└──────────────────────────────────────────────┘
```

**Design Philosophy:**
- Layered architecture (Infrastructure → Domain → Application → CLI)
- Dependency injection for testability
- Pure functions in domain layer (Black-76, moneyness)
- Separation of concerns (see [Design Decisions](docs/design-decisions.md))

## CLI Commands

```bash
# Fetch instrument metadata
bun src/cli/index.ts fetch-instruments <currency> [--kind option|future]

# Fetch historical trades (seq-based)
bun src/cli/index.ts fetch-trades <currency> [--concurrency N]

# Fetch delivery prices
bun src/cli/index.ts fetch-deliveries <index>...

# Complete pipeline (instruments → trades → deliveries)
bun src/cli/index.ts fetch-all <currency>

# Enrich raw Parquet with Greeks and moneyness (optional)
bun src/cli/index.ts merge-to-parquet <currency> [--min-expiration <date>]

# Show statistics
bun src/cli/index.ts stats [currency]

# Help
bun src/cli/index.ts help
```

**Note:** Raw Parquet files are created automatically when fetch completes. The `merge-to-parquet` command is optional and creates enriched analytics data with Greeks calculations.

See [API Reference](docs/api-reference.md) for complete command documentation.

## Performance

### Throughput
- **Futures:** 50k-100k trades/minute (concurrency=5)
- **Options:** 20k-30k trades/minute (streaming)
- **Deliveries:** ~1000 records/minute

### Time Estimates
- **BTC-PERPETUAL** (300M trades): 2-6 hours
- **Single expiration cycle** (100 options): 10-30 minutes
- **All ETH options** (1000+ instruments): 2-4 hours

### Storage
- **BTC-PERPETUAL:** ~50GB JSONL (temp) → ~5GB Parquet (final)
- **Typical option:** 100KB-10MB JSONL (temp) → 10-100KB Parquet
- **SQLite metadata:** <100MB for 10,000 instruments
- **Space savings:** JSONL auto-deleted after Parquet conversion (~90% reduction)

## Documentation

Comprehensive documentation available in [`/docs`](docs/README.md):

### 📖 Getting Started
- **[Overview](docs/overview.md)** - Project goals, use cases, target audience
- **[Operations Guide](docs/operations.md)** - Installation, commands, troubleshooting

### 🏗️ Understanding the System
- **[Architecture](docs/architecture.md)** - System design, layers, data flow
- **[Design Decisions](docs/design-decisions.md)** - Why seq-based? Why JSONL? (6 key decisions)
- **[Data Model](docs/data-model.md)** - Database schema, JSONL format, relationships

### 🔧 Technical Reference
- **[Deribit API](docs/deribit-api.md)** - Endpoints, rate limiting, pagination strategies
- **[API Reference](docs/api-reference.md)** - Complete CLI and TypeScript API
- **[Development Guide](docs/development.md)** - Setup, testing, contributing

## Technology Stack

- **Runtime:** Bun (fast TypeScript runtime with built-in SQLite)
- **Language:** TypeScript (strict mode, no `any`)
- **Storage:** SQLite (metadata), JSONL (trades), Parquet (analytics)
- **API:** Deribit REST API (history.deribit.com)
- **Validation:** Zod (runtime schema validation)
- **Testing:** Bun Test (unit, integration, E2E)

No external dependencies for HTTP, testing, or file I/O.

## Project Structure

```
src/
├── cli/                 # Command-line interface
├── application/         # Orchestration (fetchers, analytics, filters)
│   ├── fetchers/        # FutureFetcher, OptionFetcher, DeliveryFetcher
│   ├── analytics/       # Greeks calculation, ParquetMerger
│   └── filters/         # Risk-based filtering
├── domain/              # Pure business logic (Black-76, moneyness)
└── infrastructure/      # External I/O (API, DB, storage, rate limiting)
    ├── deribit-client.ts    # HTTP + rate limiting
    ├── database.ts          # SQLite metadata + checkpoints
    ├── jsonl-storage.ts     # Temporary JSONL (in-progress)
    ├── parquet-storage.ts   # Raw Parquet (auto-conversion)
    └── parquet-writer.ts    # Analytics Parquet (enrichment)

tests/
├── unit/                # Pure function tests (Black-76, moneyness)
├── integration/         # DB, storage, and API tests
└── e2e/                 # Full pipeline tests

docs/                    # Comprehensive documentation
data/
├── jsonl/               # Temporary (in-progress instruments only)
├── parquet-raw/         # Raw trade data (auto-converted from JSONL)
└── parquet/             # Analytics data (enriched with Greeks)
deribit-data.db          # Metadata database (gitignored)
```

## Testing

```bash
# Run all tests
bun test

# Unit tests only
bun test tests/unit/

# Integration tests
bun test tests/integration/

# E2E tests
bun test tests/e2e/

# With coverage
bun test --coverage
```

**Coverage:**
- Unit tests: 100% (pure functions)
- Integration tests: 80%+
- E2E tests: Critical paths

## Why Seq-Based + Hybrid Storage?

The project uses **sequence-based pagination** with **hybrid JSONL→Parquet storage** for superior reliability and performance:

- ✅ **Deterministic pagination** - No gaps or duplicates (trade_seq is monotonic)
- ✅ **10-50x faster** for large futures via concurrent chunk fetching
- ✅ **Crash-safe hybrid storage** - JSONL for speed, Parquet for efficiency
- ✅ **Precise resumability** - Resume from exact trade_seq + 1
- ✅ **Auto-cleanup** - JSONL deleted after Parquet conversion (~90% space savings)
- ✅ **Best of both worlds** - Fast appends (JSONL) + efficient storage (Parquet)

See [Design Decisions](docs/design-decisions.md) for detailed rationale.

## Use Cases

### Quantitative Research
- Backtest options strategies using complete historical data
- Study implied volatility surface evolution
- Analyze Greeks behavior near expiration

### Market Analysis
- Validate pricing models against historical trades
- Understand market microstructure (bid-ask spreads, order flow)
- Measure market impact and liquidity patterns

### Academic Research
- Study cryptocurrency derivatives markets
- Analyze option pricing efficiency
- Research market behavior during major events

### Data Science
- Train ML models on historical options data
- Feature engineering from Greeks and IV
- Market prediction and analysis

## Contributing

Contributions welcome! Please see [Development Guide](docs/development.md) for:
- Development setup
- Code style and conventions
- Testing requirements
- Pull request process

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- **Documentation:** [/docs](docs/README.md)
- **GitHub:** https://github.com/cyri113/deribit-historical-data
- **Issues:** https://github.com/cyri113/deribit-historical-data/issues

---

**Built with:** TypeScript + Bun + SQLite + Hybrid JSONL→Parquet
**Architecture:** Seq-based pagination, dual fetch strategies, hybrid storage with auto-conversion
**Status:** Production-ready, actively maintained
