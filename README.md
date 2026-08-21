# Deribit Historical Data Pipeline

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Fetch Deribit historical trades for expired instruments (options, futures). TypeScript/Bun with seq-based pagination, filesystem-based idempotency, BunQueue workflows, and DuckDB Greeks (10-100x faster than row-by-row).

## Quick Start

```bash
bun install

# Fetch expired BTC options from last 3 months
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

# Enrich with Greeks
bun src/cli/index.ts enrich-with-duckdb BTC

# Monitor progress
bun src/cli/index.ts queue-dashboard  # http://localhost:6790
```

**Output:**
- `data/parquet-raw/BTC/*.parquet` - Bronze: Raw trades (one file per instrument)
- `data/parquet-raw/futures/*.parquet` - Bronze: Dated futures for forward prices
- `data/parquet-raw/deliveries/*.parquet` - Delivery/settlement prices
- `data/parquet-raw/volatility/*.parquet` - Historical volatility
- `data/parquet-duckdb/BTC.parquet` - Silver/Gold: Enriched with Greeks (single file per currency)
- `data/queue.db` - BunQueue job queue (only SQLite database)

## Features

**Data:** Expired instruments with expiration filters, seq-based pagination (no gaps), idempotent re-runs
**Performance:** BunQueue concurrent jobs (3 parallel), 15 req/s shared rate limiting
**Storage:** Direct Parquet writes, filesystem-based idempotency (skip completed instruments)
**Analytics:** DuckDB vectorized Greeks with forward prices (944k trades/sec, 10-100x faster than TypeScript)
**Workflows:** BunQueue job queue, retry logic (3 attempts), web dashboard
**Reliability:** Atomic Parquet writes, shared rate limiter, crash recovery via re-run

## CLI Commands

**Fetch expired instruments:**
```bash
# Expired BTC options from last 3 months
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

# Expired BTC futures and options from specific date range
bun src/cli/index.ts fetch-all BTC --min-expiration 2024-01-01 --max-expiration 2024-12-31

# All expired BTC instruments
bun src/cli/index.ts fetch-all BTC

# Delivery prices and volatility
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd
bun src/cli/index.ts fetch-volatility BTC ETH
```

**Enrich with Greeks:**
```bash
bun src/cli/index.ts enrich-with-duckdb BTC  # Recommended (20-50k/sec, DuckDB vectorized)
```

**Queue management:**
```bash
bun src/cli/index.ts queue-status      # Quick status
bun src/cli/index.ts queue-dashboard   # Monitor at http://localhost:6790
```

**Note:** Legacy commands (`fetch-instruments`, `fetch-trades`, `convert-to-raw-parquet`, `merge-to-parquet`, `stats`) are deprecated. Use `fetch-all` instead.

## Architecture

```
CLI → Application (Fetchers, Analytics, Filters) → Domain (Black-76, moneyness) → Infrastructure

Infrastructure:
├── DeribitClient      - HTTP, rate limit (15 req/s shared), Zod validation
├── QueueManager       - BunQueue (embedded SQLite, retry, dashboard)
├── ParquetStorage     - Direct Parquet I/O (read/write trades, instruments, deliveries, volatility)
├── DuckDB             - WASM, Black-76 pure SQL, vectorized (10-100x faster)
└── RateLimiter        - Token bucket (15 req/s)

Storage (Medallion Architecture):
1. data/parquet-raw/BTC/*.parquet         - Bronze: Raw trades (one file per instrument)
2. data/parquet-raw/futures/*.parquet     - Bronze: Dated futures (forward prices for Greeks)
3. data/parquet-raw/deliveries/*.parquet  - Delivery/settlement prices
4. data/parquet-raw/volatility/*.parquet  - Historical volatility
5. data/parquet-duckdb/BTC.parquet        - Silver/Gold: Enriched with Greeks (single file)
6. data/queue.db                          - BunQueue job queue (only SQLite)

No instrument metadata database - All metadata embedded in Parquet files via parseInstrumentName()
```

## Performance

**Throughput:** 99% of instruments <10k trades (single API call, <10s per instrument)
**Time:** Typical expiry (100 options) ~10-30min, 4,640 expired options (3 months) ~30-60min
**Storage:** Typical expiry (100 options) ~10-50MB Parquet, 4,640 options ~500MB-2GB
**Concurrency:** 3 parallel BunQueue jobs, 15 req/s shared rate limiter
**Greeks:** DuckDB 20-50k/sec vs TypeScript 1-2k/sec (10-100x faster)

## Key Design Decisions

1. **Seq-based pagination:** Deterministic, no gaps (vs timestamp-based)
2. **Simplified fetch strategy:** Unified approach (fetch all [1, lastSeq] in memory) for 99% of instruments <10k trades
3. **Direct Parquet storage:** Write directly to Parquet (no JSONL intermediate layer)
4. **Filesystem-based idempotency:** Check Parquet exists → skip (no SQLite database for progress tracking)
5. **BunQueue workflows:** Professional queue vs custom dashboard (-550 lines code)
6. **DuckDB SQL Greeks:** 10-100x faster via vectorized execution
7. **Forward prices for Greeks:** Use dated futures instead of spot index for accurate Black-76 pricing

See [Design Decisions](docs/design-decisions.md) for rationale.

## Forward Prices for Greeks

Greeks calculations use **forward prices** from dated futures contracts instead of spot index prices:

- **Fetches:** Dated futures (e.g., `BTC-10AUG26`) matching option expiries
- **Storage:** `data/parquet-raw/futures/*.parquet`
- **Join:** DuckDB ASOF join matches futures trades to option trades by timestamp
- **Fallback:** Uses spot `index_price` if futures data unavailable
- **Accuracy:** Forward price typically $5-50 different from spot → more accurate Greeks

**Why it matters:** Deribit uses forward prices for Greeks calculations. Using spot price (index_price) instead of forward price can cause delta/gamma errors, especially when futures trade at premium/discount to spot.

## Data Model

**Parquet Raw (Bronze):**
- `trade_seq`, `timestamp`, `price`, `index_price`, `direction`, `amount`, `iv`
- One file per instrument: `BTC-25DEC24-60000-C.parquet`
- Metadata embedded via `parseInstrumentName()` from filename

**Parquet Enriched (Silver/Gold - 16 fields):**
- Trade data + Greeks (delta, gamma, vega, theta)
- Forward prices (from futures when available)
- Data quality flag (`is_valid` for filtering analytics-ready data)

**BunQueue (only SQLite):**
- Job queue state in `data/queue.db`
- No instrument metadata database

⚠️ **IV Format:** Deribit returns `iv:65` = 65% (use `iv/100` for Greeks)

## Queue Dashboard

Monitor job progress via BunQueue dashboard:

```bash
bun src/cli/index.ts queue-dashboard
# Open http://localhost:6790
```

**Features:**
- Real-time job queue status
- Completed/failed/waiting jobs with timestamps
- Retry management (3 attempts, exponential backoff)
- Job history
- Performance metrics

**Storage:** `data/queue.db` (backup: `cp data/queue.db backups/`)

## Testing

```bash
bun test                    # All tests
bun test tests/unit/        # Pure functions (100% coverage)
bun test tests/integration/ # DB, storage, API (80%+)
bun test --coverage         # With coverage report
```

## Documentation

**Getting Started:**
- [Overview](docs/overview.md) - What it does, use cases
- [Operations](docs/operations.md) - Install, commands, troubleshooting

**Architecture:**
- [Architecture](docs/architecture.md) - Layers, components, data flow
- [Design Decisions](docs/design-decisions.md) - 8 key choices with rationale
- [Data Model](docs/data-model.md) - Schema, formats, lifecycle

**Reference:**
- [API Reference](docs/api-reference.md) - CLI and TypeScript API
- [Development](docs/development.md) - Setup, testing, contributing

## Use Cases

**Backtest:** Fetch options → compute Greeks → filter (`WHERE is_valid = true AND delta > 0.3`) → P&L
**IV Research:** Trade-level IV → volatility surface → model validation
**Microstructure:** Bid-ask spreads, order flow, market impact (may include `is_valid = false` for near-expiry)
**Greeks:** Track delta/gamma decay over lifetimes

**Data Quality Filtering:**
```sql
-- High-quality analytics (recommended)
SELECT * FROM read_parquet('data/parquet-duckdb/BTC.parquet')
WHERE is_valid = true  -- Filters out IV=0, very short-dated, NaN Greeks

-- All data (research, including edge cases)
SELECT * FROM read_parquet('data/parquet-duckdb/BTC.parquet')

-- Quality audit
SELECT is_valid, COUNT(*) FROM read_parquet('data/parquet-duckdb/BTC.parquet')
GROUP BY is_valid
```

## Stack

**Runtime:** Bun (TypeScript, SQLite, test, bundler built-in)
**Language:** TypeScript strict, no `any`
**Storage:** Parquet (columnar analytics), SQLite (BunQueue jobs only)
**Queue:** BunQueue (embedded SQLite, MIT)
**Analytics:** DuckDB WASM (vectorized SQL)
**Validation:** Zod

## License

MIT - see [LICENSE](LICENSE)

---

**Built with:** TypeScript + Bun + BunQueue + DuckDB
**Architecture:** Seq-based pagination, filesystem idempotency, medallion storage (Bronze/Silver/Gold), vectorized Greeks
