# Deribit Historical Data Pipeline

A TypeScript/Bun pipeline for fetching, analyzing, and filtering Deribit options historical data using Black-76 pricing model and risk-based filters.

## Features

- **Historical Data Fetching**: Fetch trade data and delivery prices from Deribit public API
- **Black-76 Pricing**: Calculate option greeks (delta, gamma, vega, theta) using the Black-76 model
- **Moneyness Analysis**: Determine ITM/OTM status using delivery prices vs strike
- **Risk Filtering**: Apply configurable risk filters based on greeks and moneyness
- **High Performance**: Batch processing, rate limiting, and optimized SQLite storage
- **Comprehensive Testing**: Unit, integration, and E2E tests with 90%+ coverage

## Architecture

```
src/
├── infrastructure/       # API client, database, rate limiter
├── domain/              # Black-76 pricing, moneyness calculations
├── application/         # Fetchers, analytics, filters
└── cli/                 # Command-line interface

tests/
├── unit/                # Black-76 and moneyness tests
├── integration/         # Database and fetcher tests
└── e2e/                 # Full pipeline tests
```

## Installation

```bash
bun install
```

## Usage

### CLI Commands

#### Fetch Historical Trades

**Regular Mode** - Fetch trades for currently active instruments:

```bash
# Single perpetual future with 3-month lookback
bun src/cli/index.ts fetch-trades BTC-PERPETUAL --months 3

# Single option with specific date range
bun src/cli/index.ts fetch-trades BTC-18AUG26-60000-C --start-date 2026-05-01 --end-date 2026-08-01

# All BTC instruments (options and futures)
bun src/cli/index.ts fetch-trades BTC --months 3

# All BTC options only
bun src/cli/index.ts fetch-trades BTC --months 3 --kind option

# Faster parallel fetching for all instruments
bun src/cli/index.ts fetch-trades BTC --months 6 --concurrency 5
```

**Historical Mode** - Fetch ALL expired instruments available from Deribit:

```bash
# Fetch ALL expired BTC options with 30 days of trade history per instrument
bun src/cli/index.ts fetch-trades BTC --historical --kind option

# Fetch with longer trade history (60 days before expiration for each)
bun src/cli/index.ts fetch-trades BTC --historical --kind option --trade-lookback 60

# Higher concurrency for faster processing
bun src/cli/index.ts fetch-trades BTC --historical --kind option --concurrency 5
```

**Note**: Historical mode fetches ALL expired instruments that Deribit's API returns (no date filtering). For each instrument, it fetches trades from `--trade-lookback` days before that instrument's expiration. This gives you the complete historical dataset available from Deribit.

**Options:**
- `--historical` - Enable historical mode (fetches all expired instruments)
- `--kind <type>` - Filter by: option, future, or spot (currency only)
- `--trade-lookback <n>` - Days of trades before expiration per instrument (default: 30)
- `--concurrency <n>` - Parallel fetches (default: 3)
- `--batch-size <n>` - API batch size (default: 1000)
- `--db-batch-size <n>` - DB batch size (default: 5000)

**Regular Mode Options** (for currently active instruments):
- `--months <n>` - Lookback period in months (required for regular mode)
- `--start-date <date>` - Start date (YYYY-MM-DD or ISO8601)
- `--end-date <date>` - End date (default: now)
- `--expired` - Include expired instruments (regular mode only)

#### Fetch Delivery Prices

```bash
# Single index (all history)
bun src/cli/index.ts fetch-deliveries btc_usd

# Filtered by date range
bun src/cli/index.ts fetch-deliveries btc_usd --start-date 2024-01-01 --end-date 2024-12-31

# Multiple indices
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd sol_usd

# With custom concurrency
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd --concurrency 4
```

Fetches delivery (settlement) prices for expired options/futures contracts. By default fetches all historical data. Use date filters to limit the range.

**Options:**
- `--start-date <date>` - Start date filter (YYYY-MM-DD or ISO8601)
- `--end-date <date>` - End date filter (YYYY-MM-DD or ISO8601)
- `--concurrency <n>` - Parallel fetches (default: 2)
- `--batch-size <n>` - API batch size (default: 100)
- `--db-batch-size <n>` - DB batch size (default: 1000)

#### Compute Greeks

```bash
# Compute greeks for all option instruments
bun src/cli/index.ts compute-greeks

# Compute greeks for specific instrument
bun src/cli/index.ts compute-greeks BTC-18AUG26-60000-C

# Higher concurrency for faster processing
bun src/cli/index.ts compute-greeks --concurrency 5
```

Computes Black-76 greeks from stored trades. If no instrument is specified, processes all option instruments in parallel.

**Options:**
- `--concurrency <n>` - Parallel processing (default: 3)

#### Apply Risk Filters

```bash
bun src/cli/index.ts apply-filters BTC-18AUG26-60000-C btcConservative
```

Available filter presets:
- `btcConservative` - Conservative risk thresholds for BTC
- `btcAggressive` - Wider risk tolerance for BTC
- `itmOnly` - Only ITM options at expiry
- `otmOnly` - Only OTM options
- `highDeltaCalls` - High delta call options (≥0.6)
- `lowThetaDecay` - Low theta decay options

#### Export Historical Data

Export expired instruments with complete data (trades, greeks, delivery prices) for analysis.

```bash
# Export all historical instruments to JSON
bun src/cli/index.ts export-historical --output historical.json

# Export BTC historical instruments to CSV
bun src/cli/index.ts export-historical BTC --format csv --output btc-historical.csv

# Export to stdout (pipe to other tools)
bun src/cli/index.ts export-historical BTC | jq '.[] | select(.optionType == "call")'

# Only instruments expired before a specific date
bun src/cli/index.ts export-historical --before-date 2026-08-01 --output aug-expired.json
```

**Output formats:**
- `json` - Complete data structure with all trades and greeks
- `csv` - Summary view with instrument, strike, delivery price, moneyness, trade count, greeks coverage

**Use cases:**
- Historical backtesting and analytics
- Outcome analysis (ITM/OTM at expiration)
- Greeks evolution over time
- Option pricing validation

## Performance Features

### Rate Limiting
- Token bucket algorithm with 15 req/s limit (75% of Deribit's 20 req/s)
- Automatic retry with exponential backoff on rate limit errors

### Database Optimization
- WAL mode for concurrent reads during writes
- Prepared statements for all queries
- Batch inserts in transactions (1000-5000 records per batch)
- Indexed queries for efficient lookups

### Memory Management
- Streaming architecture (no full dataset in memory)
- Configurable batch sizes for API and DB operations
- Automatic buffer flushing

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
```

### Test Coverage

- **Unit Tests**: Black-76 pricing formulas, moneyness calculations
- **Integration Tests**: Database operations, trade/delivery storage
- **E2E Tests**: Full pipeline with 10k+ records

## Implementation Details

### Black-76 Model

The Black-76 model is implemented from scratch with standard normal CDF approximation:

```typescript
C = e^(-r*T) * [F*N(d1) - K*N(d2)]
P = e^(-r*T) * [K*N(-d2) - F*N(-d1)]
```

For crypto derivatives, risk-free rate (r) = 0, simplifying calculations.

### Greeks Formulas

- **Delta**: Rate of change of option price w.r.t. underlying
- **Gamma**: Rate of change of delta w.r.t. underlying
- **Vega**: Rate of change of option price w.r.t. volatility (per 1%)
- **Theta**: Rate of change of option price w.r.t. time (per day)

### Database Schema

**trades**
- Primary key: `id` (trade ID)
- Indexed: `(instrument_name, timestamp)`
- Stores: price, amount, IV, index price, mark price

**delivery_prices**
- Primary key: `(index_name, date)`
- Stores: settlement prices for each expiration

**greeks**
- Primary key: Auto-increment
- Unique: `(instrument_name, timestamp)`
- Stores: All greeks + underlying price + IV

## Project Structure Best Practices

### Separation of Concerns

- **Infrastructure Layer**: Pure I/O (API, DB, rate limiting)
- **Domain Layer**: Pure business logic (Black-76, moneyness)
- **Application Layer**: Orchestration (fetchers, calculators, filters)
- **Presentation Layer**: CLI interface

### File Organization

- **Cohesion over line count**: Files grouped by responsibility, not arbitrary limits
- **Single responsibility**: Each module has one reason to change
- **Dependency injection**: All dependencies passed via constructors

### Code Quality

- **Strict TypeScript**: No `any`, all strict flags enabled
- **Runtime validation**: Zod schemas for API responses
- **Error handling**: Custom error classes, retry logic, graceful degradation
- **Performance monitoring**: Structured logging with duration tracking

## Dependencies

- **Bun**: Runtime and package manager
- **zod**: Runtime type validation for API responses
- **bun:sqlite**: Built-in SQLite for data storage

No external dependencies for HTTP, testing, or file I/O.

## License

MIT
