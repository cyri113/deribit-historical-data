# Overview

## What It Does

Fetches, stores, and enriches Deribit historical trades (options, futures). Built for quants needing expired instruments with Greeks and moneyness.

## Core Problem

**Volume:** Thousands of expired instruments, millions of trades
**API:** Rate-limited, paginated, no bulk export
**Historical Data:** Need instruments that expired in specific time periods (e.g., last 3 months)
**Quality:** Must avoid duplicates and gaps

## Solution

**Idempotent:** Filesystem-based (check Parquet exists → skip), perfect re-runability
**Fast:** BunQueue concurrent jobs (3 parallel), 15 req/s rate limiting
**Reliable:** Seq-based pagination (no gaps), direct Parquet writes
**Complete:** Expired instruments, trade-level IV, delivery prices, Black-76 Greeks

## Features

**Data:** Expired instruments, filter by currency/type/expiration dates, seq-based pagination
**Greeks:** Black-76 (delta, gamma, vega, theta), crypto-optimized (r=0), DuckDB vectorized
**Moneyness:** ITM/OTM/ATM classification, expiration outcomes
**Storage:** Direct Parquet writes (columnar analytics), filesystem-based idempotency
**Queue:** BunQueue job queue (embedded SQLite), retry logic, web dashboard

## Use Cases

**Backtest:** Fetch options → compute Greeks → filter (delta > 0.3) → P&L analysis
**IV Research:** Trade-level IV → volatility surface → model validation
**Microstructure:** Bid-ask spreads, order flow, market impact
**Greeks:** Track delta/gamma decay over instrument lifetimes

## Workflow

```
# Fetch expired instruments from last 3 months
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

1. BunQueue: fetch-instruments job → API getInstruments(expired=true) → filter by expiration
2. BunQueue: fetch-trades job → enqueue fetch-option/fetch-future jobs per instrument
3. For each instrument:
   - Check if Parquet exists → skip if yes (idempotent)
   - Fetch all trades [1, lastSeq] in memory
   - Write directly to Parquet
4. Enrich (optional): DuckDB vectorized Greeks → Parquet

Output:
  data/parquet-raw/BTC/         (Bronze: raw trades, one file per instrument)
  data/parquet-raw/deliveries/  (Delivery/settlement prices)
  data/parquet-raw/volatility/  (Historical volatility)
  data/parquet-duckdb/BTC/      (Silver/Gold: enriched with Greeks)
  data/queue.db                 (BunQueue job queue - only SQLite)
```

## Performance

**Throughput:** 99% of instruments <10k trades (single API call, <10s)
**Storage:** Typical expiry (100 options) ~10-50MB Parquet
**Concurrency:** 3 parallel jobs, 15 req/s shared rate limiter
**Enrichment:** DuckDB ~20-50k trades/sec (10-100x faster than TypeScript)

## Limitations

- Historical expired instruments only (no streaming, no perpetuals)
- Deribit only
- No order book data
- Cannot resume mid-instrument (but <10s per instrument)

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

**Docs:** [Operations](operations.md) · [Architecture](architecture.md) · [API Reference](api-reference.md)
