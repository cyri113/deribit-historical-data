# API Reference

Complete CLI commands and TypeScript API reference.

## CLI Commands

### fetch-instruments

Fetch and store instrument metadata from Deribit.

```bash
bun src/cli/index.ts fetch-instruments <currency> [options]
```

**Arguments:** `currency` (BTC, ETH, SOL)
**Options:** `--kind <type>` (option, future, spot), `--expired` (default: true)

**Example:**
```bash
bun src/cli/index.ts fetch-instruments BTC --kind option
```

---

### fetch-trades

Fetch historical trades using seq-based pagination.

```bash
bun src/cli/index.ts fetch-trades <currency> [options]
```

**Arguments:** `currency` (BTC, ETH, SOL)
**Options:** `--kind <type>`, `--concurrency <n>` (default: 3), `--chunk-size <n>` (default: 10000)

**Example:**
```bash
bun src/cli/index.ts fetch-trades BTC --concurrency 5
```

**Storage:**
- Trades written to JSONL during fetch (in-progress only)
- Auto-converted to Parquet when complete
- JSONL deleted after conversion
- Final: `data/parquet-raw/BTC/*.parquet`

---

### fetch-deliveries

Fetch historical settlement prices.

```bash
bun src/cli/index.ts fetch-deliveries <index>... [options]
```

**Arguments:** `index` (btc_usd, eth_usd, sol_usd)
**Options:** `--concurrency <n>` (default: 2), `--batch-size <n>` (default: 100)

**Example:**
```bash
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd
```

---

### fetch-volatility

Fetch historical volatility data.

```bash
bun src/cli/index.ts fetch-volatility <currency>...
```

**Arguments:** `currency` (BTC, ETH, SOL)
**Options:** `--concurrency <n>` (default: 2)

**Example:**
```bash
bun src/cli/index.ts fetch-volatility BTC ETH
```

**Storage:** `data/parquet-raw/volatility/{currency}.parquet`

---

### fetch-all

Complete pipeline: instruments → trades → deliveries → volatility.

```bash
bun src/cli/index.ts fetch-all <currency> [options]
```

**Options:** `--kind <type>`, `--concurrency <n>`, `--skip-deliveries`, `--skip-volatility`

**Example:**
```bash
bun src/cli/index.ts fetch-all BTC --concurrency 5
```

---

### merge-to-parquet

Enrich raw Parquet with Greeks using **TypeScript row-by-row** processing (~1-2k trades/sec).

**Note:** For large datasets, use `enrich-with-duckdb` (10-100x faster).

```bash
bun src/cli/index.ts merge-to-parquet <currency> [options]
```

**Options:**
- `--min-expiration <date>` (e.g., "3m", "2024-01-01")
- `--max-expiration <date>`
- `--output-dir <path>` (default: ./data/parquet)

**Example:**
```bash
bun src/cli/index.ts merge-to-parquet BTC --min-expiration 3m
```

**What it does:**
1. Read trades from `data/parquet-raw/BTC/*.parquet`
2. Compute Greeks (Black-76) in TypeScript
3. Calculate moneyness (ITM/ATM/OTM)
4. Write to `data/parquet/BTC/*.parquet`

**Enriched Fields:** `delivery_price`, `moneyness`, `intrinsic_value`, `delta`, `gamma`, `vega`, `theta`, `theoretical_price`

---

### enrich-with-duckdb

⚡ **High-performance Greeks enrichment** using DuckDB SQL vectorized computation.

**Recommended for large datasets.** 10-100x faster than `merge-to-parquet`.

```bash
bun src/cli/index.ts enrich-with-duckdb <target>... [options]
```

**Arguments:** `target` (currency like BTC, or specific instrument)
**Options:**
- `--input-dir <path>` (default: ./data/parquet-raw)
- `--output-dir <path>` (default: ./data/parquet-duckdb)
- `--max-memory <size>` (default: 4GB)
- `--threads <n>` (default: CPU cores)

**Example:**
```bash
bun src/cli/index.ts enrich-with-duckdb BTC --max-memory 8GB
```

**How it works:**
1. Pure SQL Greeks (Black-76 as SQL expressions)
2. Vectorized execution (DuckDB processes millions of rows in parallel)
3. Memory efficient (streams Parquet, constant memory)
4. Direct Parquet → Parquet (no intermediate formats)

**Performance:**

| Method | Throughput | Memory | CPU |
|--------|-----------|--------|-----|
| TypeScript | 1-2k trades/sec | High | 1 core |
| DuckDB | 20-50k trades/sec | Low | All cores |

---

### stats

Show download statistics.

```bash
bun src/cli/index.ts stats [currency]
```

**Example:**
```bash
bun src/cli/index.ts stats BTC
```

---

## TypeScript API

### DeribitClient

HTTP client with rate limiting and retries.

```typescript
new DeribitClient(config?: {
  baseUrl?: string;
  historyBaseUrl?: string;
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  retryDelay?: number;
})
```

**Methods:**

```typescript
// Fetch instruments
async getInstruments(
  currency: string,
  kind?: "future" | "option" | "spot",
  expired?: boolean
): Promise<DeribitInstrument[]>

// Fetch trades by sequence range
async getTradesBySeq(
  instrumentName: string,
  startSeq: number,
  endSeq: number,
  count?: number
): Promise<{ trades: DeribitTrade[]; hasMore: boolean }>

// Stream all trades in range
async *getAllTradesBySeq(
  instrumentName: string,
  startSeq: number,
  endSeq: number,
  batchSize?: number
): AsyncGenerator<DeribitTrade[]>

// Fetch delivery prices
async getDeliveryPrices(
  indexName: string,
  offset?: number,
  count?: number
): Promise<{ data: DeribitDeliveryPrice[]; recordsTotal: number }>

// Stream all delivery prices
async *getAllDeliveryPrices(
  indexName: string,
  batchSize?: number
): AsyncGenerator<DeribitDeliveryPrice[]>
```

**Example:**
```typescript
const client = new DeribitClient();
const instruments = await client.getInstruments("BTC", "option", true);
const { trades } = await client.getTradesBySeq("BTC-PERPETUAL", 1, 10000);
```

---

### Database

SQLite wrapper for metadata and checkpoints.

```typescript
new Database(path?: string)  // Default: "deribit-data.db"
```

**Key Methods:**

```typescript
// Instruments
upsertInstruments(instruments: Array<{...}>): void
getInstruments(currency: string, kind?: string): Array<InstrumentRecord>

// Future chunks
createFutureChunks(instrumentName: string, lastSeq: number, chunkSize?: number): void
getIncompleteFutureChunks(instrumentName: string): Array<{...}>
markFutureChunkDone(instrumentName: string, chunkStartSeq: number, chunkEndSeq: number, tradeCount: number, jsonlPath: string): void

// Option progress
getOptionProgress(instrumentName: string): { last_no: number; status: string; trade_count: number; }
updateOptionProgress(instrumentName: string, lastNo: number, tradeCount: number, jsonlPath: string): void

// Delivery prices
insertDeliveryPrices(deliveryPrices: DeliveryPrice[]): void
getDeliveryPrice(indexName: string, date: number): DeliveryPrice | null
```

---

### JSONLStorage

Append-only JSONL file storage for trades.

```typescript
new JSONLStorage(dataDir?: string)  // Default: "./data/jsonl"
```

**Methods:**

```typescript
async appendTrades(instrumentName: string, trades: DeribitTrade[]): Promise<void>
async readTrades(instrumentName: string): Promise<DeribitTrade[]>
async countTrades(instrumentName: string): Promise<number>
async closeAll(): Promise<void>
```

---

### Black-76 Pricing

Pure functions for option pricing and Greeks.

```typescript
// Price calculations
black76Call(forwardPrice: number, strike: number, timeToExpiry: number, volatility: number, discountFactor?: number): number
black76Put(...): number

// Greeks
delta(forwardPrice, strike, timeToExpiry, volatility, optionType: "call" | "put", discountFactor?): number
gamma(forwardPrice, strike, timeToExpiry, volatility, discountFactor?): number
vega(forwardPrice, strike, timeToExpiry, volatility, discountFactor?): number  // Per 1% vol change
theta(forwardPrice, strike, timeToExpiry, volatility, optionType, discountFactor?, riskFreeRate?): number  // Per day

// All at once
calculateGreeks(forwardPrice, strike, timeToExpiry, volatility, optionType, discountFactor?, riskFreeRate?): Black76Greeks
```

**Example:**
```typescript
const greeks = calculateGreeks(62000, 60000, 0.5, 0.65, "call");
// { price: 3245.67, delta: 0.68, gamma: 0.000012, vega: 156.3, theta: -8.45 }
```

---

### Moneyness

```typescript
function determineMoneyness(
  strike: number,
  deliveryPrice: number,
  optionType: "call" | "put"
): Moneyness

enum Moneyness { ITM = "ITM", ATM = "ATM", OTM = "OTM" }
```

**Example:**
```typescript
const moneyness = determineMoneyness(60000, 62000, "call");  // Moneyness.ITM
```

---

### ParquetWriter

Infrastructure class for JSONL → enriched Parquet conversion.

```typescript
new ParquetWriter(config: {
  database: Database;
  jsonlStorage: JSONLStorage;
  outputDir?: string;
})
```

**Methods:**

```typescript
async enrichInstrument(
  instrumentName: string,
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentProgress>

async enrichMultipleInstruments(
  instrumentNames: string[],
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentProgress[]>
```

---

### ParquetMerger

Application-layer orchestrator for JSONL → Parquet pipeline.

```typescript
new ParquetMerger(config: {
  database: Database;
  jsonlStorage: JSONLStorage;
  outputDir?: string;
})
```

**Methods:**

```typescript
async mergeCurrency(
  currency: string,
  onProgress?: (progress) => void,
  minExpiration?: number,
  maxExpiration?: number
): Promise<MergeResult>

async mergeAllCurrencies(
  currencies: string[],
  onProgress?: (progress) => void
): Promise<MergeResult[]>
```

**Example:**
```typescript
const merger = new ParquetMerger({ database, jsonlStorage });
const result = await merger.mergeCurrency("BTC");
console.log(`Merged ${result.enrichedInstruments} instruments`);
```

---

## Type Definitions

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
