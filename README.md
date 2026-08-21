# Deribit Historical Data Pipeline

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Deribit options/futures historical trade data pipeline. TypeScript/Bun, medallion architecture (bronze/silver), DuckDB Greeks, BunQueue orchestration.

## Quick Start

```bash
bun install
bun src/cli/index.ts queue-worker  # Terminal 1: Start worker

# Terminal 2: Run pipeline
bun src/cli/index.ts pipeline BTC --kind option --min-expiration 3m
# Fetches bronze → enriches silver → outputs data/silver/BTC.parquet
```

## Commands

```bash
# Medallion layers
bronze BTC [--kind option|future] [--min-expiration 3m]  # Fetch raw data
silver BTC [--max-memory 8GB]                            # Compute Greeks
pipeline BTC                                             # Bronze → Silver

# Queue
queue-worker      # Process jobs (run in separate terminal)
queue-dashboard   # Web UI at http://localhost:6790
queue-status      # CLI status
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

**Data Flow:**
```
bronze BTC → API fetch → bronze/instruments/BTC/*.parquet + bronze/futures/*.parquet
silver BTC → DuckDB SQL → silver/BTC.parquet (Greeks via vectorized SQL)
pipeline BTC → bronze + silver sequentially
```

**Performance:**
- Bronze: 99% instruments <10k trades = <10s/instrument, 3 parallel jobs
- Silver: DuckDB 20-50k trades/sec (vs TypeScript 1-2k/sec)

## Use Cases

```sql
-- Analytics (recommended: use is_valid filter)
SELECT * FROM 'data/silver/BTC.parquet' WHERE is_valid = true AND delta > 0.3

-- Research (include edge cases)
SELECT * FROM 'data/silver/BTC.parquet'

-- Quality audit
SELECT is_valid, COUNT(*) FROM 'data/silver/BTC.parquet' GROUP BY is_valid
```

## Documentation

- [Architecture](docs/architecture.md) - Components, data flow
- [Data Model](docs/data-model.md) - Schemas, lifecycle
- [Design Decisions](docs/design-decisions.md) - Key choices

## License

MIT
