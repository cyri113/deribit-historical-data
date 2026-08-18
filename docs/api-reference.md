# API Reference

Complete reference for CLI commands and TypeScript API.

## CLI Commands

### fetch-instruments

Fetch and store instrument metadata from Deribit.

```bash
bun src/cli/index.ts fetch-instruments <currency> [options]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `currency` | string | Currency code (BTC, ETH, SOL) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--kind` | string | all | Filter by: "option", "future", "spot" |
| `--expired` | boolean | true | Include expired instruments |

**Examples:**
```bash
bun src/cli/index.ts fetch-instruments BTC
bun src/cli/index.ts fetch-instruments BTC --kind option
bun src/cli/index.ts fetch-instruments ETH --kind future --no-expired
```

**Output:**
```
Fetching BTC instruments...
✓ Found 10,234 instruments
✓ Stored 10,234 instruments in database

Breakdown:
  future: 12
  option: 10,222

Next: bun src/cli/index.ts fetch-trades BTC
```

---

### fetch-trades

Fetch historical trades using seq-based pagination.

```bash
bun src/cli/index.ts fetch-trades <currency> [options]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `currency` | string | Currency code (BTC, ETH, SOL) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--kind` | string | all | Filter by: "option", "future" |
| `--concurrency` | number | 3 | Parallel fetches (1-20) |
| `--chunk-size` | number | 10000 | Trades per chunk |

**Examples:**
```bash
bun src/cli/index.ts fetch-trades BTC
bun src/cli/index.ts fetch-trades BTC --kind future --concurrency 5
bun src/cli/index.ts fetch-trades ETH --kind option --chunk-size 5000
```

**Output:**
```
Fetching futures...
  BTC-PERPETUAL: [████████░░] 80% (24,000/30,000 chunks)

Fetching options...
  BTC-27DEC24-60000-C: ✓ Complete (5,234 trades)

✓ Futures: 240,000,000 trades from 12 instruments
✓ Options: 1,234,567 trades from 10,222 instruments
```

---

### fetch-deliveries

Fetch historical settlement prices.

```bash
bun src/cli/index.ts fetch-deliveries <index>... [options]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `index` | string[] | One or more index names (btc_usd, eth_usd) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--concurrency` | number | 2 | Parallel fetches |
| `--batch-size` | number | 100 | Records per API call |

**Examples:**
```bash
bun src/cli/index.ts fetch-deliveries btc_usd
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd sol_usd
bun src/cli/index.ts fetch-deliveries btc_usd --concurrency 4
```

---

### fetch-all

Complete pipeline: instruments → trades → deliveries.

```bash
bun src/cli/index.ts fetch-all <currency> [options]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `currency` | string | Currency code (BTC, ETH, SOL) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--kind` | string | all | Filter by: "option", "future" |
| `--concurrency` | number | 3 | Parallel fetches |
| `--skip-deliveries` | boolean | false | Skip delivery price fetching |

**Examples:**
```bash
bun src/cli/index.ts fetch-all BTC
bun src/cli/index.ts fetch-all BTC --kind option --concurrency 5
bun src/cli/index.ts fetch-all ETH --skip-deliveries
```

---

### merge-to-parquet

Convert JSONL trades to enriched Parquet files with computed Greeks and moneyness.

```bash
bun src/cli/index.ts merge-to-parquet <currency> [options]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `currency` | string | Currency code (BTC, ETH, SOL) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--min-expiration` | string | none | Only merge options expiring after date (e.g., "3m", "2024-01-01") |
| `--max-expiration` | string | none | Only merge options expiring before date |
| `--output-dir` | string | ./data/parquet | Output directory for Parquet files |

**Date Formats:**
- Relative: `3d` (3 days ago), `3m` (3 months ago), `1y` (1 year ago)
- Absolute: `2024-01-01`, `2024-06-15`

**Examples:**
```bash
# Merge all completed BTC options
bun src/cli/index.ts merge-to-parquet BTC

# Merge only recent options (last 3 months)
bun src/cli/index.ts merge-to-parquet BTC --min-expiration 3m

# Merge specific date range
bun src/cli/index.ts merge-to-parquet ETH --min-expiration 2024-01-01 --max-expiration 2024-12-31

# Custom output directory
bun src/cli/index.ts merge-to-parquet BTC --output-dir ./analytics/btc
```

**Output:**
```
━━━ Merging BTC Options to Parquet ━━━

Filtering: expiring after 2026-05-18
Found 1364 completed options

  ✓ BTC-20JUL26-65000-C: 185 trades enriched in 0.01s
  ✓ BTC-20JUL26-65000-P: 142 trades enriched in 0.01s
  ...

━━━ Merge Summary ━━━
Total instruments: 1364
Enriched instruments: 1364
Total trades: 1,234,567
Duration: 45.32s
```

**What It Does:**

1. Reads trades from JSONL files
2. Computes Greeks (delta, gamma, vega, theta) using Black-76 model
3. Calculates moneyness (ITM/ATM/OTM) from delivery prices
4. Writes enriched data to Parquet files

**Enriched Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `delivery_price` | double | Settlement price at expiration |
| `moneyness` | string | "ITM", "ATM", or "OTM" |
| `intrinsic_value` | double | max(0, delivery - strike) for calls |
| `moneyness_percentage` | double | % by which option is ITM/OTM |
| `delta` | double | Rate of change w.r.t. underlying |
| `gamma` | double | Rate of change of delta |
| `vega` | double | Sensitivity to volatility |
| `theta` | double | Time decay per day |
| `theoretical_price` | double | Black-76 fair value |

**Performance:**
- ~1000-2000 trades/second
- 10-100x faster queries vs JSONL
- ~10x compression vs JSONL

---

### stats

Show download statistics.

```bash
bun src/cli/index.ts stats [currency]
```

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| `currency` | string | Optional: Currency filter (BTC, ETH, SOL) |

**Examples:**
```bash
bun src/cli/index.ts stats
bun src/cli/index.ts stats BTC
```

---

## TypeScript API

### DeribitClient

HTTP client for Deribit API with rate limiting and retries.

#### Constructor

```typescript
new DeribitClient(config?: DeribitClientConfig)
```

**Config:**
```typescript
interface DeribitClientConfig {
  baseUrl?: string;              // Default: "https://www.deribit.com/api/v2"
  historyBaseUrl?: string;       // Default: "https://history.deribit.com/api/v2"
  rateLimiter?: RateLimiter;     // Default: 15 req/s limiter
  maxRetries?: number;           // Default: 3
  retryDelay?: number;           // Default: 1000ms
}
```

#### Methods

**getInstruments**

```typescript
async getInstruments(
  currency: string,
  kind?: "future" | "option" | "spot",
  expired?: boolean
): Promise<DeribitInstrument[]>
```

Fetch all instruments for a currency.

**Example:**
```typescript
const client = new DeribitClient();
const instruments = await client.getInstruments("BTC", "option", true);
console.log(instruments.length); // 10,234
```

**getTradesBySeq**

```typescript
async getTradesBySeq(
  instrumentName: string,
  startSeq: number,
  endSeq: number,
  count?: number
): Promise<{ trades: DeribitTrade[]; hasMore: boolean }>
```

Fetch trades by sequence range.

**Example:**
```typescript
const { trades, hasMore } = await client.getTradesBySeq(
  "BTC-PERPETUAL",
  1,
  10000,
  10000
);
console.log(trades.length); // 10,000
```

**getAllTradesBySeq**

```typescript
async *getAllTradesBySeq(
  instrumentName: string,
  startSeq: number,
  endSeq: number,
  batchSize?: number
): AsyncGenerator<DeribitTrade[]>
```

Stream all trades in a range.

**Example:**
```typescript
for await (const batch of client.getAllTradesBySeq("BTC-PERPETUAL", 1, 100000)) {
  console.log(`Fetched ${batch.length} trades`);
}
```

**getDeliveryPrices**

```typescript
async getDeliveryPrices(
  indexName: string,
  offset?: number,
  count?: number
): Promise<{ data: DeribitDeliveryPrice[]; recordsTotal: number }>
```

Fetch delivery prices with pagination.

**getAllDeliveryPrices**

```typescript
async *getAllDeliveryPrices(
  indexName: string,
  batchSize?: number
): AsyncGenerator<DeribitDeliveryPrice[]>
```

Stream all delivery prices.

---

### Database

SQLite wrapper for metadata and checkpoints.

#### Constructor

```typescript
new Database(path?: string)  // Default: "deribit-data.db"
```

#### Methods

**upsertInstruments**

```typescript
upsertInstruments(instruments: Array<{
  instrument_name: string;
  kind: string;
  base_currency: string;
  expiration_timestamp?: number;
  strike?: number;
  option_type?: string;
  is_active: boolean;
  settlement_period?: string;
  last_seq?: number;
}>): void
```

**getInstruments**

```typescript
getInstruments(
  currency: string,
  kind?: string,
  expired?: boolean
): Array<InstrumentRecord>
```

**createFutureChunks**

```typescript
createFutureChunks(
  instrumentName: string,
  lastSeq: number,
  chunkSize?: number
): void
```

**getIncompleteFutureChunks**

```typescript
getIncompleteFutureChunks(instrumentName: string): Array<{
  id: number;
  chunk_start_seq: number;
  chunk_end_seq: number;
}>
```

**markFutureChunkDone**

```typescript
markFutureChunkDone(
  instrumentName: string,
  chunkStartSeq: number,
  chunkEndSeq: number,
  tradeCount: number,
  jsonlPath: string
): void
```

**getOptionProgress**

```typescript
getOptionProgress(instrumentName: string): {
  last_no: number;
  status: string;
  trade_count: number;
}
```

**updateOptionProgress**

```typescript
updateOptionProgress(
  instrumentName: string,
  lastNo: number,
  tradeCount: number,
  jsonlPath: string
): void
```

**insertDeliveryPrices**

```typescript
insertDeliveryPrices(deliveryPrices: DeliveryPrice[]): void
```

**getDeliveryPrice**

```typescript
getDeliveryPrice(indexName: string, date: number): DeliveryPrice | null
```

---

### JSONLStorage

Append-only JSONL file storage for trades.

#### Constructor

```typescript
new JSONLStorage(dataDir?: string)  // Default: "./data/jsonl"
```

#### Methods

**appendTrades**

```typescript
async appendTrades(
  instrumentName: string,
  trades: DeribitTrade[]
): Promise<void>
```

Append trades to JSONL file (with automatic flush).

**readTrades**

```typescript
async readTrades(instrumentName: string): Promise<DeribitTrade[]>
```

Read all trades from JSONL file.

**countTrades**

```typescript
async countTrades(instrumentName: string): Promise<number>
```

Count trades without loading into memory.

**closeAll**

```typescript
async closeAll(): Promise<void>
```

Close all open file handles (call on shutdown).

---

### Black-76 Pricing

Pure functions for option pricing and Greeks.

**black76Call**

```typescript
function black76Call(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor?: number
): number
```

Calculate call option price.

**Example:**
```typescript
const price = black76Call(62000, 60000, 0.5, 0.65, 1);
console.log(price); // 3245.67
```

**black76Put**

```typescript
function black76Put(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor?: number
): number
```

**delta**

```typescript
function delta(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor?: number
): number
```

**gamma**

```typescript
function gamma(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor?: number
): number
```

**vega**

```typescript
function vega(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor?: number
): number
```

Returns vega per 1% change in volatility.

**theta**

```typescript
function theta(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor?: number,
  riskFreeRate?: number
): number
```

Returns theta per day.

**calculateGreeks**

```typescript
function calculateGreeks(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor?: number,
  riskFreeRate?: number
): Black76Greeks
```

Calculate all Greeks at once.

**Example:**
```typescript
const greeks = calculateGreeks(62000, 60000, 0.5, 0.65, "call");
console.log(greeks);
// {
//   price: 3245.67,
//   delta: 0.68,
//   gamma: 0.000012,
//   vega: 156.3,
//   theta: -8.45
// }
```

---

### Moneyness

**determineMoneyness**

```typescript
function determineMoneyness(
  strike: number,
  deliveryPrice: number,
  optionType: "call" | "put"
): Moneyness
```

**Example:**
```typescript
const moneyness = determineMoneyness(60000, 62000, "call");
console.log(moneyness); // Moneyness.ITM
```

**Enum:**
```typescript
enum Moneyness {
  ITM = "ITM",  // In the money
  ATM = "ATM",  // At the money
  OTM = "OTM"   // Out of the money
}
```

---

### Utility Functions

**parseInstrumentName**

```typescript
function parseInstrumentName(instrumentName: string): Instrument | null
```

Parse instrument name into components.

**Example:**
```typescript
const instrument = parseInstrumentName("BTC-27DEC24-60000-C");
console.log(instrument);
// {
//   name: "BTC-27DEC24-60000-C",
//   underlying: "BTC",
//   strike: 60000,
//   expiration: 1735372800000,
//   optionType: "call",
//   instrumentType: "option"
// }
```

---

### ParquetWriter

Infrastructure class for converting JSONL trades to enriched Parquet files.

#### Constructor

```typescript
new ParquetWriter(config: ParquetWriterConfig)
```

**Config:**
```typescript
interface ParquetWriterConfig {
  database: Database;              // Database instance for metadata + delivery prices
  jsonlStorage: JSONLStorage;      // JSONL storage for reading trades
  outputDir?: string;              // Default: "./data/parquet"
}
```

#### Methods

**enrichInstrument()**

Convert a single instrument's trades to Parquet with computed Greeks and moneyness.

```typescript
async enrichInstrument(
  instrumentName: string,
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentProgress>
```

**Example:**
```typescript
const writer = new ParquetWriter({
  database: new Database(),
  jsonlStorage: new JSONLStorage(),
});

const result = await writer.enrichInstrument("BTC-10AUG26-65000-C");
console.log(`Enriched ${result.enrichedTrades} trades`);
```

**enrichMultipleInstruments()**

Process multiple instruments with progress tracking.

```typescript
async enrichMultipleInstruments(
  instrumentNames: string[],
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentProgress[]>
```

---

### ParquetMerger

Application-layer orchestrator for JSONL → Parquet pipeline.

#### Constructor

```typescript
new ParquetMerger(config: ParquetMergerConfig)
```

**Config:**
```typescript
interface ParquetMergerConfig {
  database: Database;
  jsonlStorage: JSONLStorage;
  outputDir?: string;
}
```

#### Methods

**mergeCurrency()**

Merge all completed options for a currency.

```typescript
async mergeCurrency(
  currency: string,
  onProgress?: (progress: EnrichmentProgress) => void,
  minExpiration?: number,
  maxExpiration?: number
): Promise<MergeResult>
```

**Example:**
```typescript
const merger = new ParquetMerger({
  database: new Database(),
  jsonlStorage: new JSONLStorage(),
});

const result = await merger.mergeCurrency("BTC");
console.log(`Merged ${result.enrichedInstruments} instruments`);
console.log(`Total trades: ${result.totalTrades}`);
```

**mergeAllCurrencies()**

Merge multiple currencies in sequence.

```typescript
async mergeAllCurrencies(
  currencies: string[],
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<MergeResult[]>
```

---

## Type Definitions

### Core Types

```typescript
interface Trade {
  id: string;
  instrumentName: string;
  price: number;
  amount: number;
  direction: "buy" | "sell";
  timestamp: number;
  indexPrice: number;
  markPrice?: number;
  impliedVolatility?: number;
}

interface DeliveryPrice {
  indexName: string;
  date: number;
  deliveryPrice: number;
}

interface Greeks {
  instrumentName: string;
  timestamp: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  price: number;
  underlyingPrice: number;
  impliedVolatility: number;
}

interface Instrument {
  name: string;
  underlying: string;
  strike: number;
  expiration: number;
  optionType: "call" | "put";
  instrumentType: "option" | "future" | "perpetual";
}
```

---

**Documentation complete!** See [README](README.md) for navigation.
