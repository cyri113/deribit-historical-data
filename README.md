# Deribit Historical Data Pipeline

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Deribit options/futures historical trade data pipeline. TypeScript/Bun, medallion architecture (bronze/silver/gold), DuckDB Greeks, BunQueue orchestration.

## Quick Start

```bash
bun install

# Run complete pipeline (single command with live progress)
bun src/cli/index.ts pipeline BTC --kind option --min-expiration 3m
# Fetches bronze → enriches silver → adds gold → outputs data/gold/BTC.parquet
```

## Commands

```bash
# Pipeline (recommended - runs all layers sequentially)
pipeline BTC [--kind option|future] [--min-expiration 3m] [--concurrency 3]
# Bronze → Silver → Gold with live progress logs

# Individual layers (advanced)
bronze BTC [--kind option|future] [--min-expiration 3m]  # Fetch raw data
silver BTC [--max-memory 8GB]                            # Compute Greeks
gold BTC                                                 # Add trading metrics

# Queue management
queue-worker      # Start background worker (for bronze/silver/gold commands)
queue-status      # Show job counts
```

## Storage

```
data/
├── bronze/                          # Raw API data
│   ├── instruments/BTC/*.parquet    # One file per instrument (BTC-29MAY26-70000-C.parquet)
│   ├── futures/*.parquet            # Dated futures for forward prices (BTC-29MAY26.parquet)
│   ├── deliveries/*.parquet         # Settlement prices (btc_usd.parquet)
│   └── volatility/*.parquet         # Historical vol (BTC.parquet)
├── silver/                          # Enriched with Greeks
│   └── BTC.parquet                  # Single file: all instruments + Greeks
├── gold/                            # Analytics-ready with trading metrics
│   └── BTC.parquet                  # Single file: silver + trading metrics
└── queue.db                         # BunQueue job state (only SQLite)
```

## Data Model

### Bronze Schema (16 fields)
`bronze/instruments/BTC/BTC-29MAY26-70000-C.parquet`

```
trade_id, trade_seq, instrument_name, timestamp, price, amount, direction,
tick_direction, index_price, mark_price, implied_volatility, strike,
expiration_timestamp, option_type, time_to_expiry_years
```

### Silver Schema (21 fields = Bronze + 5)
`silver/BTC.parquet` - All instruments in single file

**Bronze fields + Computed:**
- `futures_price` - Forward price from ASOF join with futures
- `delta, gamma, vega, theta` - Black-76 Greeks
- `is_valid` - Quality flag (TRUE = has futures_price, IV>0, TTM>1day, valid Greeks)

### Gold Schema (24 fields = Silver + 3)
`gold/BTC.parquet` - Analytics-ready with trading metrics

**Silver fields + Trading Metrics:**
- `days_to_expiry` - Integer days until expiration (for DTE filtering: 0DTE, 7DTE, 30DTE)
- `strike_delta` - Delta buckets: 5-delta, 10-delta, 25-delta, 50-delta, deep-itm
- `vol_regime` - IV percentile classification: low (<33%), mid (33-67%), high (>67%)

**Greeks Formula (Black-76):**
- Inputs: F=futures_price, K=strike, T=time_to_expiry_years, σ=implied_volatility/100
- Computed via DuckDB vectorized SQL (20-50k trades/sec)
- NULL if no futures_price (strict quality: no fallback to spot index_price)

**ASOF Join:** Each option trade matched to nearest prior futures trade by timestamp
```sql
LEFT JOIN futures ON extract_expiry(option.name) = futures.name
  AND futures.timestamp <= option.timestamp
QUALIFY ROW_NUMBER() OVER (PARTITION BY option.trade_id ORDER BY futures.timestamp DESC) = 1
```

## Architecture

**Stack:** Bun, TypeScript, Parquet, DuckDB WASM, BunQueue (SQLite queue)

**Key Patterns:**
- Seq-based pagination (trade_seq field, deterministic)
- Filesystem idempotency (check if .parquet exists → skip)
- BunQueue orchestration (3 concurrent jobs, 15 req/s rate limit)
- Metadata in filename (parseInstrumentName, no instrument DB)
- Forward prices from futures (accurate Greeks vs spot price)

**Data Flow (Pipeline):**
```
1. fetch-instruments → Get instrument list from API
2. fetch-trades → Download all option/future trades (9k+ files, batched)
3. fetch-dated-futures → Scan option files, fetch required futures
4. fetch-deliveries → Settlement prices (optional)
5. fetch-volatility → Historical vol data (optional)
6. enrich-duckdb → Compute Greeks via DuckDB SQL → silver/BTC.parquet
7. enrich-gold → Add trading metrics → gold/BTC.parquet

Each step waits for previous to complete (sequential waterfall)
```

**Performance:**
- Bronze: 99% instruments <10k trades = <10s/instrument, 3 parallel jobs
- Silver: DuckDB 20-50k trades/sec (vs TypeScript 1-2k/sec)
- Gold: DuckDB 20-50k trades/sec (windowed calculations)

## Use Cases

```sql
-- Analytics (recommended: use gold layer)
SELECT * FROM 'data/gold/BTC.parquet'
WHERE is_valid = true
  AND strike_delta = '25-delta'
  AND days_to_expiry <= 30
  AND vol_regime = 'high'

-- Research (silver layer for raw Greeks)
SELECT * FROM 'data/silver/BTC.parquet'

-- Quality audit
SELECT is_valid, COUNT(*) FROM 'data/gold/BTC.parquet' GROUP BY is_valid
```

## Documentation

- [Architecture](docs/architecture.md) - Components, data flow
- [Data Model](docs/data-model.md) - Schemas, lifecycle
- [Design Decisions](docs/design-decisions.md) - Key choices

## License

MIT
