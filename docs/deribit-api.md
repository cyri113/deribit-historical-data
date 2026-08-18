# Deribit API Integration

This document describes how the project integrates with Deribit's REST API, including endpoints used, rate limiting strategy, pagination approaches, and error handling.

## API Endpoints

### Base URLs

The project uses **two different Deribit API hosts**:

```typescript
const MAIN_API = "https://www.deribit.com/api/v2";
const HISTORY_API = "https://history.deribit.com/api/v2";
```

**Why two APIs?**
- **Main API:** Real-time data, instrument metadata, delivery prices
- **History API:** Complete historical trade data with seq-based pagination

### 1. Get Instruments

**Endpoint:** `GET /public/get_instruments`
**Base URL:** `history.deribit.com` (for complete instrument list including expired)

**Purpose:** Fetch all instruments (active + expired) for a currency

**Request:**
```http
GET https://history.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=true
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `currency` | string | Yes | "BTC", "ETH", "SOL", etc. |
| `kind` | string | No | "option", "future", "spot" (omit for all) |
| `expired` | boolean | No | Include expired instruments (default: false) |

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": [
    {
      "instrument_name": "BTC-27DEC24-60000-C",
      "kind": "option",
      "base_currency": "BTC",
      "expiration_timestamp": 1735372800000,
      "strike": 60000,
      "option_type": "call",
      "is_active": true,
      "settlement_period": "month"
    },
    ...
  ]
}
```

**Usage in Code:**
```typescript
const instruments = await client.getInstruments("BTC", "option", true);
database.upsertInstruments(instruments);
```

### 2. Get Last Trades By Instrument (Seq-Based)

**Endpoint:** `GET /public/get_last_trades_by_instrument`
**Base URL:** `history.deribit.com`

**Purpose:** Fetch trades using sequence-based pagination (Design Decision #1)

**Request:**
```http
GET https://history.deribit.com/api/v2/public/get_last_trades_by_instrument?instrument_name=BTC-PERPETUAL&start_seq=1&end_seq=10000&count=10000&include_old=true
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument_name` | string | Yes | Full instrument name |
| `start_seq` | number | Yes | Starting trade_seq (inclusive) |
| `end_seq` | number | Yes | Ending trade_seq (inclusive) |
| `count` | number | No | Max trades per request (default: 1000, max: 10000) |
| `include_old` | boolean | No | Include old trades (required for historical) |

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "trades": [
      {
        "trade_seq": 1,
        "trade_id": "BTC-PERPETUAL-12345",
        "timestamp": 1692355200000,
        "price": 62500.5,
        "mark_price": 62501.0,
        "instrument_name": "BTC-PERPETUAL",
        "index_price": 62000.0,
        "direction": "buy",
        "amount": 1.5,
        "iv": 0.65
      },
      ...
    ],
    "has_more": true
  }
}
```

**Pagination:**
- `has_more: true` → More trades in the requested range, fetch next batch
- `has_more: false` → All trades in range fetched

**Usage in Code:**
```typescript
const { trades, hasMore } = await client.getTradesBySeq(
  "BTC-PERPETUAL",
  startSeq,
  endSeq,
  10000
);

await storage.appendTrades("BTC-PERPETUAL", trades);
```

### 3. Get Delivery Prices

**Endpoint:** `GET /public/get_delivery_prices`
**Base URL:** `www.deribit.com`

**Purpose:** Fetch historical settlement prices for expired contracts

**Request:**
```http
GET https://www.deribit.com/api/v2/public/get_delivery_prices?index_name=btc_usd&offset=0&count=100
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index_name` | string | Yes | "btc_usd", "eth_usd", etc. |
| `offset` | number | No | Pagination offset (default: 0) |
| `count` | number | No | Records per page (default: 100) |

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "data": [
      {
        "date": "2024-12-27",
        "delivery_price": 62350.5
      },
      ...
    ],
    "records_total": 1234
  }
}
```

**Pagination:**
- Offset-based (not seq-based)
- Continue until `offset + count >= records_total`

**Usage in Code:**
```typescript
for await (const batch of client.getAllDeliveryPrices("btc_usd", 100)) {
  database.insertDeliveryPrices(batch);
}
```

---

## Rate Limiting

### Deribit Rate Limits

**Official Limit:** 20 requests/second per IP
**Burst Limit:** Short bursts allowed, but sustained > 20 req/s triggers errors

### Our Rate Limiting Strategy

**Implementation:** Token bucket algorithm
**Configured Rate:** 15 req/s (75% of official limit for safety margin)

#### Token Bucket Algorithm

```typescript
class RateLimiter {
  private tokens: number;
  private readonly capacity: number; // 15
  private readonly refillRate: number; // 15 tokens/second
  private lastRefill: number;

  async acquire(): Promise<void> {
    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;

    // Wait if no tokens available
    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.refillRate * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.tokens = 1;
    }

    this.tokens -= 1;
  }
}
```

**Benefits:**
- ✅ Allows bursts (up to 15 concurrent requests)
- ✅ Prevents sustained overuse
- ✅ Smooth request distribution

### Error Handling

**Rate Limit Errors:**

Deribit returns rate limit errors in two forms:

1. **HTTP 429:** Too Many Requests
2. **JSON-RPC Error 10028:** `too_many_requests`

**Retry Strategy:**

```typescript
async request<T>(method: string, params: object): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimiter.acquire();
      const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });

      if (response.status === 429) {
        throw new DeribitRateLimitError("HTTP 429");
      }

      const data = await response.json();
      if (data.error?.code === 10028) {
        throw new DeribitRateLimitError("Error 10028");
      }

      return data;
    } catch (error) {
      if (error instanceof DeribitRateLimitError && attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = retryDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
```

**Backoff Schedule:**
- Attempt 1: 1s delay
- Attempt 2: 2s delay
- Attempt 3: 4s delay
- After 3 retries: give up

---

## Pagination Strategies

### Strategy 1: Seq-Based (Trades)

**Used for:** `get_last_trades_by_instrument`

**Approach:**
1. Determine seq range: `[start_seq, end_seq]`
2. Fetch in chunks of 10,000
3. Use `has_more` flag to continue pagination

**Example:**
```typescript
async *getAllTradesBySeq(instrument: string, startSeq: number, endSeq: number) {
  let currentSeq = startSeq;

  while (currentSeq <= endSeq) {
    const { trades, hasMore } = await this.getTradesBySeq(
      instrument,
      currentSeq,
      endSeq,
      10000
    );

    if (trades.length > 0) {
      yield trades;
      currentSeq = trades[trades.length - 1].trade_seq + 1;
    }

    if (!hasMore) break;
  }
}
```

**Advantages:**
- Deterministic (no duplicates or gaps)
- Resumable from exact seq
- Independent of time

### Strategy 2: Offset-Based (Delivery Prices)

**Used for:** `get_delivery_prices`

**Approach:**
1. Start at offset 0
2. Fetch `count` records
3. Continue until `offset >= records_total`

**Example:**
```typescript
async *getAllDeliveryPrices(indexName: string, batchSize: number = 100) {
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, recordsTotal } = await this.getDeliveryPrices(
      indexName,
      offset,
      batchSize
    );

    if (data.length > 0) {
      yield data;
    }

    offset += data.length;
    hasMore = offset < recordsTotal;
  }
}
```

---

## API Response Validation

### Runtime Schema Validation with Zod

All API responses are validated using Zod schemas to ensure type safety:

```typescript
import { z } from "zod";

const DeribitTradeSchema = z.object({
  trade_seq: z.number(),
  trade_id: z.string(),
  timestamp: z.number(),
  price: z.number(),
  instrument_name: z.string(),
  index_price: z.number(),
  direction: z.enum(["buy", "sell"]),
  amount: z.number(),
  iv: z.number().optional(),
  mark_price: z.number().optional(),
  tick_direction: z.number(),
});

const DeribitTradesResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(),
  result: z.object({
    trades: z.array(DeribitTradeSchema),
    has_more: z.boolean(),
  }),
});

// Usage
const response = await fetch(url);
const data = await response.json();
const validated = DeribitTradesResponseSchema.parse(data); // Throws if invalid
```

**Benefits:**
- ✅ Catches API changes immediately
- ✅ Type-safe access to data
- ✅ Clear error messages on schema mismatch

---

## Error Handling

### Error Types

```typescript
class DeribitAPIError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown
  ) {
    super(message);
    this.name = "DeribitAPIError";
  }
}

class DeribitRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeribitRateLimitError";
  }
}
```

### Retry Logic

**Retryable Errors:**
- Rate limit errors (429, 10028)
- Service unavailable (503)
- Network timeouts

**Non-Retryable Errors:**
- Invalid parameters (400)
- Authentication errors (401)
- Not found (404)
- Schema validation failures

**Implementation:**
```typescript
const RETRYABLE_CODES = [429, 503, 10028];

function isRetryable(error: Error): boolean {
  if (error instanceof DeribitRateLimitError) return true;
  if (error instanceof DeribitAPIError && RETRYABLE_CODES.includes(error.code)) return true;
  return false;
}
```

---

## API Quirks & Edge Cases

### 1. Instrument Name Encoding

Some instrument names contain special characters:

```
BTC-PERPETUAL  ✅
BTC-27DEC24-60000-C  ✅
```

Always URL-encode instrument names in query parameters:
```typescript
const params = new URLSearchParams({
  instrument_name: encodeURIComponent(instrumentName)
});
```

### 2. Timestamp Precision

Deribit uses **milliseconds** for all timestamps:

```json
{
  "timestamp": 1692355200000,  // NOT seconds
  "expiration_timestamp": 1735372800000
}
```

### 3. Delivery Price Date Format

Delivery prices use **string dates** in `YYYY-MM-DD` format:

```json
{
  "date": "2024-12-27",
  "delivery_price": 62350.5
}
```

Convert to milliseconds for storage:
```typescript
const dateMs = new Date(date + "T00:00:00Z").getTime();
```

### 4. Implied Volatility Scale

IV is returned as a decimal (0-1 scale), not percentage:

```json
{
  "iv": 0.65  // = 65% IV
}
```

### 5. has_more Interpretation

`has_more` means "more trades **in the requested range**", not "more trades overall":

```typescript
// Request: start_seq=1, end_seq=10000
// Response: 10,000 trades, has_more=true
// Meaning: There are more trades between seq 1-10,000 (fetch again with same range)

// Response: 5,000 trades, has_more=false
// Meaning: All trades between seq 1-10,000 have been fetched
```

---

## API Limits Summary

| Resource | Limit | Notes |
|----------|-------|-------|
| **Rate Limit** | 20 req/s | We use 15 req/s for safety |
| **Max trades per request** | 10,000 | `count` parameter |
| **Max delivery prices per request** | No documented limit | We use 100 |
| **Burst Requests** | ~50 before throttle | Short bursts allowed |

---

## Testing API Integration

### Manual API Testing

```bash
# Test get_instruments
curl -s "https://history.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=true" | jq .

# Test get_last_trades_by_instrument
curl -s "https://history.deribit.com/api/v2/public/get_last_trades_by_instrument?instrument_name=BTC-PERPETUAL&start_seq=1&end_seq=10&count=10&include_old=true" | jq .

# Test get_delivery_prices
curl -s "https://www.deribit.com/api/v2/public/get_delivery_prices?index_name=btc_usd&count=5" | jq .
```

### Integration Tests

See `tests/integration/deribit-client.test.ts` for full test suite.

```typescript
test("fetch trades by seq", async () => {
  const client = new DeribitClient();
  const { trades, hasMore } = await client.getTradesBySeq(
    "BTC-PERPETUAL",
    1,
    10,
    10
  );

  expect(trades.length).toBeGreaterThan(0);
  expect(trades[0].trade_seq).toBeGreaterThanOrEqual(1);
});
```

---

**Next:** [Operations Guide →](operations.md)
