# Data Model

This document describes the complete data model for the Deribit Historical Data Pipeline, including database schema, JSONL format, and data relationships.

## Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Storage Layer                           │
│                                                             │
│  ┌────────────────────┐        ┌───────────────────────┐   │
│  │  SQLite DB         │        │  JSONL Files          │   │
│  │  (Metadata)        │        │  (Trade Data)         │   │
│  │                    │        │                       │   │
│  │  • instruments     │        │  data/jsonl/          │   │
│  │  • future_chunks   │        │    BTC/               │   │
│  │  • option_progress │        │      BTC-PERP.jsonl   │   │
│  │  • delivery_prices │        │      BTC-27DEC.jsonl  │   │
│  │  • greeks          │        │    ETH/               │   │
│  └────────────────────┘        │      ETH-PERP.jsonl   │   │
│                                └───────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## SQLite Database Schema

### Table: `instruments`

Stores metadata for all instruments (options, futures, perpetuals).

```sql
CREATE TABLE instruments (
  instrument_name TEXT PRIMARY KEY,           -- e.g., "BTC-PERPETUAL", "BTC-27DEC24-60000-C"
  kind TEXT NOT NULL,                         -- "future", "option", "spot"
  base_currency TEXT NOT NULL,                -- "BTC", "ETH", "SOL"
  expiration_timestamp INTEGER,               -- Unix milliseconds (NULL for perpetuals)
  strike REAL,                                -- Strike price (NULL for futures)
  option_type TEXT,                           -- "call", "put" (NULL for futures)
  is_active INTEGER NOT NULL,                 -- 1 = active, 0 = expired
  settlement_period TEXT,                     -- "month", "week", "day"
  last_seq INTEGER,                           -- Last trade_seq from API
  fetched_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_instruments_currency_kind ON instruments(base_currency, kind);
CREATE INDEX idx_instruments_active ON instruments(is_active);
```

**Purpose:**
- Store instrument metadata from Deribit `get_instruments` API
- Track `last_seq` for futures (used to create chunks)
- Query instruments by currency, type, or status

**Example Row:**
```json
{
  "instrument_name": "BTC-27DEC24-60000-C",
  "kind": "option",
  "base_currency": "BTC",
  "expiration_timestamp": 1735372800000,
  "strike": 60000,
  "option_type": "call",
  "is_active": 1,
  "settlement_period": "month",
  "last_seq": 123456,
  "fetched_at": 1692355200000
}
```

### Table: `future_chunks`

Tracks chunk-level progress for futures (see [Design Decision 2](design-decisions.md#decision-2-dual-fetch-strategies)).

```sql
CREATE TABLE future_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_name TEXT NOT NULL,
  chunk_start_seq INTEGER NOT NULL,
  chunk_end_seq INTEGER NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,          -- 0 = incomplete, 1 = complete
  jsonl_path TEXT,                             -- Path to JSONL file
  trade_count INTEGER DEFAULT 0,               -- Number of trades in chunk
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(instrument_name, chunk_start_seq, chunk_end_seq)
);

CREATE INDEX idx_future_chunks_instrument ON future_chunks(instrument_name);
CREATE INDEX idx_future_chunks_done ON future_chunks(is_done);
```

**Purpose:**
- Pre-allocated chunks for concurrent fetching
- Track completion status for resumability
- Audit trail for download progress

**Example Rows:**
```json
[
  {
    "id": 1,
    "instrument_name": "BTC-PERPETUAL",
    "chunk_start_seq": 1,
    "chunk_end_seq": 10000,
    "is_done": 1,
    "jsonl_path": "data/jsonl/BTC/BTC-PERPETUAL.jsonl",
    "trade_count": 10000,
    "updated_at": 1692355200000
  },
  {
    "id": 2,
    "instrument_name": "BTC-PERPETUAL",
    "chunk_start_seq": 10001,
    "chunk_end_seq": 20000,
    "is_done": 0,
    "trade_count": 0
  }
]
```

**Queries:**
```sql
-- Get incomplete chunks for resuming
SELECT * FROM future_chunks
WHERE instrument_name = 'BTC-PERPETUAL' AND is_done = 0
ORDER BY chunk_start_seq;

-- Get progress stats
SELECT
  COUNT(*) as total_chunks,
  SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as completed,
  SUM(trade_count) as total_trades
FROM future_chunks
WHERE instrument_name = 'BTC-PERPETUAL';
```

### Table: `option_progress`

Tracks streaming progress for options (see [Design Decision 2](design-decisions.md#decision-2-dual-fetch-strategies)).

```sql
CREATE TABLE option_progress (
  instrument_name TEXT PRIMARY KEY,
  last_no INTEGER NOT NULL DEFAULT 0,          -- Resume offset (last fetched seq)
  status TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress', 'completed'
  jsonl_path TEXT,
  trade_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_option_progress_status ON option_progress(status);
```

**Purpose:**
- Track streaming progress for options
- Resume from `last_no + 1` on restart
- Detect completion (no more trades)

**Example Row:**
```json
{
  "instrument_name": "BTC-27DEC24-60000-C",
  "last_no": 5234,
  "status": "completed",
  "jsonl_path": "data/jsonl/BTC/BTC-27DEC24-60000-C.jsonl",
  "trade_count": 5234,
  "updated_at": 1692355200000
}
```

**Update with MAX Guard:**
```sql
-- Prevents rollback on concurrent crashes (Design Decision #5)
UPDATE option_progress
SET last_no = MAX(last_no, ?), trade_count = ?, updated_at = ?
WHERE instrument_name = ?
```

### Table: `delivery_prices`

Stores settlement prices for expired contracts.

```sql
CREATE TABLE delivery_prices (
  index_name TEXT NOT NULL,                    -- e.g., "btc_usd", "eth_usd"
  date INTEGER NOT NULL,                       -- Unix milliseconds (midnight UTC)
  delivery_price REAL NOT NULL,                -- Settlement price in USD
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (index_name, date)
);

CREATE INDEX idx_delivery_prices_index_date ON delivery_prices(index_name, date);
```

**Purpose:**
- Store historical settlement prices
- Used to determine ITM/OTM at expiration
- Fetched from Deribit `get_delivery_prices` API

**Example Row:**
```json
{
  "index_name": "btc_usd",
  "date": 1735372800000,  // 2024-12-27 00:00:00 UTC
  "delivery_price": 62350.5
}
```

**Queries:**
```sql
-- Get delivery price for BTC on 2024-12-27
SELECT delivery_price FROM delivery_prices
WHERE index_name = 'btc_usd' AND date = 1735372800000;

-- Get all BTC delivery prices in 2024
SELECT * FROM delivery_prices
WHERE index_name = 'btc_usd'
  AND date >= 1704067200000  -- 2024-01-01
  AND date < 1735689600000   -- 2025-01-01
ORDER BY date;
```

### Table: `greeks` ⚠️ DEPRECATED

> **Note:** This table is deprecated in favor of the Parquet analytics pipeline. Greeks are now computed on-the-fly during JSONL → Parquet merge and stored together with trades in Parquet files.

Stores computed Black-76 Greeks (legacy, optional, derived from trades).

```sql
CREATE TABLE greeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_name TEXT NOT NULL,
  timestamp INTEGER NOT NULL,                  -- Unix milliseconds
  delta REAL NOT NULL,
  gamma REAL NOT NULL,
  vega REAL NOT NULL,
  theta REAL NOT NULL,
  price REAL NOT NULL,                         -- Option price
  underlying_price REAL NOT NULL,              -- Spot/index price
  implied_volatility REAL NOT NULL,            -- IV from trade
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(instrument_name, timestamp)
);

CREATE INDEX idx_greeks_instrument_timestamp ON greeks(instrument_name, timestamp);
```

**Purpose:**
- Store pre-computed Greeks for quick access
- Avoid recalculating on every query
- Enable time-series analysis of Greeks

**Example Row:**
```json
{
  "id": 1,
  "instrument_name": "BTC-27DEC24-60000-C",
  "timestamp": 1692355200000,
  "delta": 0.62,
  "gamma": 0.000015,
  "vega": 45.3,
  "theta": -12.5,
  "price": 2350.5,
  "underlying_price": 62000,
  "implied_volatility": 0.65
}
```

### Deprecated Tables

The following tables exist for backward compatibility but are not used in the seq-based architecture:

```sql
-- DEPRECATED: Trades now stored in JSONL
CREATE TABLE trades (...);

-- DEPRECATED: Replaced by future_chunks + option_progress
CREATE TABLE checkpoints (...);
```

---

## JSONL File Format

### Directory Structure

```
data/jsonl/
├── BTC/
│   ├── BTC-PERPETUAL.jsonl
│   ├── BTC-27DEC24-60000-C.jsonl
│   ├── BTC-27DEC24-60000-P.jsonl
│   └── ...
├── ETH/
│   ├── ETH-PERPETUAL.jsonl
│   └── ...
└── SOL/
    └── SOL-PERPETUAL.jsonl
```

**Naming Convention:**
- One file per instrument
- Organized by underlying currency
- Filename = `{instrument_name}.jsonl`

### Trade Record Schema

Each line in a JSONL file is a complete trade record:

```json
{
  "trade_seq": 123456,
  "trade_id": "ETH-12345-67890",
  "timestamp": 1692355200000,
  "tick_direction": 1,
  "price": 0.002,
  "mark_price": 0.00195,
  "instrument_name": "BTC-27DEC24-60000-C",
  "index_price": 62000.0,
  "direction": "buy",
  "amount": 1.5,
  "iv": 65
}
```

**Field Descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `trade_seq` | number | Unique sequence number (monotonically increasing) |
| `trade_id` | string | Unique trade identifier from Deribit |
| `timestamp` | number | Unix milliseconds |
| `tick_direction` | number | Price direction: 0=same, 1=up, 2=down, 3=zero-plus |
| `price` | number | Execution price (in BTC for BTC options) |
| `mark_price` | number | Mark price at execution time (in BTC for BTC options) |
| `instrument_name` | string | Full instrument name |
| `index_price` | number | Underlying index/spot price (in USD) |
| `direction` | string | "buy" or "sell" |
| `amount` | number | Contract quantity |
| `iv` | number | **Implied volatility in percentage format** (e.g., 65 = 65%) |

⚠️ **Important: Implied Volatility Format**

Deribit API returns implied volatility (`iv`) in **percentage format**:
- `iv: 65` means **65% volatility**, not 0.65
- `iv: 19.06` means **19.06% volatility**, not 0.1906
- `iv: 80` means **80% volatility**, not 0.80

When calculating Greeks using Black-76 formula, **the IV must be converted to decimal format by dividing by 100**:
```typescript
// CORRECT: Convert percentage to decimal
const greeks = calculateGreeks(
  trade.index_price,
  strike,
  timeToExpiry,
  trade.iv / 100,  // 65 → 0.65 (65%)
  optionType
);

// WRONG: Using percentage directly
const greeks = calculateGreeks(
  ...,
  trade.iv,  // ❌ Would interpret 65 as 6500% volatility!
  ...
);
```

This conversion is handled automatically in `parquet-writer.ts` when enriching trades with Greeks.

**Validation (Zod Schema):**
```typescript
const DeribitTradeSchema = z.object({
  trade_seq: z.number(),
  trade_id: z.string(),
  timestamp: z.number(),
  tick_direction: z.number(),
  price: z.number(),
  mark_price: z.number().optional(),
  instrument_name: z.string(),
  index_price: z.number(),
  direction: z.enum(["buy", "sell"]),
  amount: z.number(),
  iv: z.number().optional(),
});
```

### File Properties

- **Append-only:** New trades appended to end (crash-safe)
- **Line-delimited:** One JSON object per line
- **No metadata:** Pure trade data, no headers or footers
- **Human-readable:** Can inspect with `cat`, `jq`, `grep`

**Example Operations:**
```bash
# Count trades
wc -l data/jsonl/BTC/BTC-PERPETUAL.jsonl

# View first trade
head -1 data/jsonl/BTC/BTC-PERPETUAL.jsonl | jq .

# Find specific trade_seq
grep '"trade_seq":123456' data/jsonl/BTC/BTC-PERPETUAL.jsonl

# Extract all buy trades
jq 'select(.direction == "buy")' data/jsonl/BTC/BTC-PERPETUAL.jsonl
```

---

## Parquet File Format (Analytics)

Enriched trade data with computed Greeks and moneyness, generated via `merge-to-parquet` command.

### Schema

24 fields per trade (trade data + Greeks + moneyness):

```typescript
interface EnrichedTrade {
  // Trade Data (from JSONL)
  trade_id: string;
  trade_seq: number;
  instrument_name: string;
  timestamp: number;                    // Unix milliseconds
  price: number;
  amount: number;
  direction: "buy" | "sell";
  tick_direction: number;
  index_price: number;
  mark_price?: number;
  implied_volatility?: number;

  // Instrument Metadata
  strike: number;
  expiration_timestamp: number;         // Unix milliseconds
  option_type: "call" | "put";
  time_to_expiry_years: number;

  // Computed Greeks (Black-76)
  delta?: number;                       // Rate of change w.r.t. underlying
  gamma?: number;                       // Rate of change of delta
  vega?: number;                        // Sensitivity to volatility (per 1%)
  theta?: number;                       // Time decay (per day)
  theoretical_price?: number;           // Black-76 fair value

  // Moneyness (at Expiration)
  delivery_price?: number;              // Settlement price
  moneyness?: "ITM" | "ATM" | "OTM";   // Classification
  intrinsic_value?: number;             // max(0, delivery - strike) for calls
  moneyness_percentage?: number;        // % ITM/OTM
}
```

### File Organization

```
data/parquet/
├── BTC/
│   ├── BTC-10AUG26-65000-C.parquet
│   ├── BTC-10AUG26-65000-P.parquet
│   └── ...
├── ETH/
│   ├── ETH-10AUG26-3000-C.parquet
│   └── ...
└── SOL/
    └── ...
```

### Example Record

```json
{
  "trade_id": "440015020",
  "trade_seq": 185,
  "instrument_name": "BTC-10AUG26-65000-C",
  "timestamp": 1723273270387,
  "price": 0.0024,
  "amount": 0.4,
  "direction": "buy",
  "tick_direction": 1,
  "index_price": 65150.66,
  "mark_price": 0.00246951,
  "implied_volatility": 19.06,
  "strike": 65000,
  "expiration_timestamp": 1723276800000,
  "option_type": "call",
  "time_to_expiry_years": 0.00014987,
  "delta": 0.5504,
  "gamma": 0.000026,
  "vega": 3.1565,
  "theta": -54990.58,
  "theoretical_price": 6119.67,
  "delivery_price": 65240.61,
  "moneyness": "ATM",
  "intrinsic_value": 240.61,
  "moneyness_percentage": 0.37
}
```

### Generation Process

```bash
# 1. Fetch trades (stored in JSONL)
bun src/cli/index.ts fetch-all BTC

# 2. Fetch delivery prices (stored in SQLite)
# (done automatically by fetch-all)

# 3. Merge to Parquet (compute Greeks + moneyness)
bun src/cli/index.ts merge-to-parquet BTC
```

**What happens during merge:**
1. Read trades from JSONL files
2. For each trade with IV: compute Greeks using Black-76
3. Join with delivery price from SQLite (by instrument + expiration)
4. Calculate moneyness if delivery price exists
5. Write enriched record to Parquet

### Performance

- **Generation:** ~1500-2000 trades/second
- **Query speed:** 10-100x faster than JSONL
- **Compression:** ~10x smaller than JSONL
- **Deduplication:** Handled automatically

### Querying Examples

**DuckDB:**
```sql
-- High delta OTM calls (speculative trades)
SELECT instrument_name, AVG(delta) as avg_delta, COUNT(*) as trades
FROM 'data/parquet/BTC/*.parquet'
WHERE option_type = 'call' AND moneyness = 'OTM' AND delta > 0.3
GROUP BY instrument_name
ORDER BY avg_delta DESC;
```

**Python (pandas):**
```python
import pandas as pd

# Read all BTC options
df = pd.read_parquet('data/parquet/BTC/')

# Filter profitable ITM calls
profitable = df[
    (df['option_type'] == 'call') &
    (df['moneyness'] == 'ITM') &
    (df['intrinsic_value'] > 1000)
]

# Analyze Greeks distribution
profitable[['delta', 'gamma', 'vega', 'theta']].describe()
```

### Regeneration

Parquet files can be regenerated anytime from JSONL source:

```bash
# Remove old analytics
rm -rf data/parquet/BTC/

# Regenerate from JSONL
bun src/cli/index.ts merge-to-parquet BTC
```

---

## Data Relationships

### Entity Relationship Diagram

```
┌─────────────────┐
│   instruments   │
│   (metadata)    │
└────────┬────────┘
         │ 1
         │
         │ N
    ┌────┴─────────────────────┐
    │                          │
    ▼ (kind=future)            ▼ (kind=option)
┌──────────────┐          ┌──────────────────┐
│future_chunks │          │ option_progress  │
│ (checkpoints)│          │   (checkpoint)   │
└──────┬───────┘          └────────┬─────────┘
       │                           │
       │ points to                 │ points to
       ▼                           ▼
┌─────────────────────────────────────┐
│        JSONL Files                  │
│  (trade data, one file per inst)    │
└─────────────────────────────────────┘

┌──────────────────┐
│ delivery_prices  │
│  (settlement)    │
└──────────────────┘
         │
         │ linked by
         │ (index_name, expiration_date)
         ▼
┌──────────────────┐
│   instruments    │
│    (options)     │
└──────────────────┘
```

### Relationships

#### 1. Instrument → Chunks/Progress (1:N)

**For Futures:**
```sql
SELECT * FROM future_chunks WHERE instrument_name = 'BTC-PERPETUAL';
-- Returns: N chunks (e.g., 30,000 for BTC-PERPETUAL)
```

**For Options:**
```sql
SELECT * FROM option_progress WHERE instrument_name = 'BTC-27DEC24-60000-C';
-- Returns: 1 row (single progress record)
```

#### 2. Instrument → JSONL File (1:1)

Each instrument has exactly one JSONL file:
```
instruments.instrument_name = "BTC-PERPETUAL"
→ data/jsonl/BTC/BTC-PERPETUAL.jsonl
```

#### 3. Instrument → Delivery Price (1:1)

Options link to delivery prices via:
- `instruments.base_currency` → `delivery_prices.index_name` (e.g., BTC → btc_usd)
- `instruments.expiration_timestamp` → `delivery_prices.date`

```sql
SELECT dp.delivery_price
FROM instruments i
JOIN delivery_prices dp ON (
  LOWER(i.base_currency) || '_usd' = dp.index_name AND
  DATE(i.expiration_timestamp / 1000, 'unixepoch') = DATE(dp.date / 1000, 'unixepoch')
)
WHERE i.instrument_name = 'BTC-27DEC24-60000-C';
```

#### 4. Trades → Greeks (1:1)

Trades and Greeks linked by `(instrument_name, timestamp)`:

```sql
SELECT t.*, g.delta, g.gamma, g.vega, g.theta
FROM trades t
LEFT JOIN greeks g ON (
  t.instrument_name = g.instrument_name AND
  t.timestamp = g.timestamp
)
WHERE t.instrument_name = 'BTC-27DEC24-60000-C';
```

---

## Data Lifecycle

```
1. fetch-instruments
   ↓
   instruments table populated
   ↓
2. fetch-trades
   ↓
   IF future:
     • Create future_chunks rows
     • Fetch chunks → JSONL
     • Mark chunks done
   ELSE (option):
     • Create/update option_progress
     • Stream trades → JSONL
     • Mark complete
   ↓
3. fetch-deliveries
   ↓
   delivery_prices table populated
   ↓
4. compute-greeks (optional)
   ↓
   Read JSONL → Compute → Store in greeks table
   ↓
5. merge to Parquet (future)
   ↓
   Read JSONL → Dedup → Write Parquet
```

---

## Storage Sizes

Typical sizes for reference:

| Data Type | Example | Storage |
|-----------|---------|---------|
| **SQLite DB** | 10,000 instruments, 30k chunks | ~50 MB |
| **JSONL (Perpetual)** | BTC-PERPETUAL (300M trades) | ~50 GB |
| **JSONL (Option)** | BTC-27DEC24-60000-C (5k trades) | ~500 KB |
| **Parquet (Merged)** | All BTC trades (compressed) | ~10 GB |
| **Delivery Prices** | 5 years of BTC daily prices | ~1 MB |
| **Greeks** | 100 options × 1000 trades each | ~50 MB |

---

## Data Integrity

### Sequence Validation

Ensure no gaps in `trade_seq`:

```typescript
function validateSequences(trades: Trade[]): boolean {
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].trade_seq !== trades[i-1].trade_seq + 1) {
      console.error(`Gap: ${trades[i-1].trade_seq} → ${trades[i].trade_seq}`);
      return false;
    }
  }
  return true;
}
```

### Deduplication Check

Count duplicates before merge:

```bash
# Count lines in JSONL
wc -l data/jsonl/BTC/BTC-PERPETUAL.jsonl

# Count unique trade_seq
jq -r '.trade_seq' data/jsonl/BTC/BTC-PERPETUAL.jsonl | sort -u | wc -l

# Difference = number of duplicates
```

### Referential Integrity

Validate instrument → delivery price linkage:

```sql
-- Options without delivery prices (potential issue)
SELECT i.instrument_name, i.expiration_timestamp
FROM instruments i
LEFT JOIN delivery_prices dp ON (
  LOWER(i.base_currency) || '_usd' = dp.index_name AND
  DATE(i.expiration_timestamp / 1000, 'unixepoch') = DATE(dp.date / 1000, 'unixepoch')
)
WHERE i.kind = 'option' AND i.is_active = 0 AND dp.delivery_price IS NULL;
```

---

**Next:** [Deribit API Integration →](deribit-api.md)
