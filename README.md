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

**Options:**
- `--months <n>` - Lookback period in months (required if no dates)
- `--start-date <date>` - Start date (YYYY-MM-DD or ISO8601)
- `--end-date <date>` - End date (default: now)
- `--kind <type>` - Filter by: option, future, or spot (currency only)
- `--expired` - Include expired instruments (currency only)
- `--concurrency <n>` - Parallel fetches (default: 3)
- `--batch-size <n>` - API batch size (default: 1000)
- `--db-batch-size <n>` - DB batch size (default: 5000)

#### Fetch Delivery Prices

```bash
# Single index
bun src/cli/index.ts fetch-deliveries btc_usd

# Multiple indices
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd sol_usd

# With custom concurrency
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd --concurrency 4
```

**Options:**
- `--concurrency <n>` - Parallel fetches (default: 2)
- `--batch-size <n>` - API batch size (default: 100)
- `--db-batch-size <n>` - DB batch size (default: 1000)

#### Compute Greeks

```bash
bun src/cli/index.ts compute-greeks BTC-18AUG26-60000-C
```

Computes Black-76 greeks from stored trades for an option.

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
