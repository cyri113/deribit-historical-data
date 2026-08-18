# Design Decisions

This document explains the key architectural decisions made in the Deribit Historical Data Pipeline, including the rationale, trade-offs, and alternatives considered.

## Table of Contents

1. [Decision 1: Seq-Based Pagination](#decision-1-seq-based-pagination)
2. [Decision 2: Dual Fetch Strategies](#decision-2-dual-fetch-strategies)
3. [Decision 3: JSONL Intermediate Storage](#decision-3-jsonl-intermediate-storage)
4. [Decision 4: SQLite for Metadata Only](#decision-4-sqlite-for-metadata-only)
5. [Decision 5: Disk-First Writes](#decision-5-disk-first-writes)
6. [Decision 6: Dedup at Merge Time](#decision-6-dedup-at-merge-time)

---

## Decision 1: Seq-Based Pagination

### Context
Deribit API provides two pagination methods:
1. **Timestamp-based:** `start_timestamp` / `end_timestamp`
2. **Sequence-based:** `start_seq` / `end_seq`

### Decision
Use **sequence-based pagination** (`trade_seq` ranges) exclusively via the history API (`history.deribit.com`).

### Rationale

#### Determinism
- **Seq-based:** Deterministic ordering. `trade_seq` is a monotonically increasing integer assigned by Deribit
- **Timestamp-based:** Non-deterministic. Multiple trades can have identical timestamps, leading to:
  - Overlapping results across API calls
  - Missing trades (gaps) when using time windows
  - No reliable way to resume from exact position

**Example of timestamp problem:**
```
Request 1: trades from 2024-01-01 00:00:00 to 00:00:01
Returns: [trade A @ 00:00:00, trade B @ 00:00:00, trade C @ 00:00:01]

Request 2: resume from 00:00:01
Returns: [trade C @ 00:00:01, trade D @ 00:00:01, ...]
Problem: trade C duplicated! And if > 10k trades at 00:00:01, some might be skipped.
```

#### Gap Prevention
- **Seq-based:** Continuous ranges guarantee no gaps (seq 1, 2, 3, 4... N)
- **Timestamp-based:** Time windows can miss trades due to:
  - Clock skew
  - Exact timestamp boundary issues
  - API behavior changes

#### Resumability
- **Seq-based:** Resume from exact `last_seq + 1`
- **Timestamp-based:** Must use last timestamp, risking duplicates or gaps

### Trade-offs

**Advantages:**
- ✅ Deterministic, reproducible results
- ✅ No gaps or missed trades
- ✅ Precise resumability
- ✅ Simpler deduplication (just by `trade_seq`)

**Disadvantages:**
- ❌ Requires history API (not available for all exchanges)
- ❌ Cannot filter by time before fetching (must fetch all, filter later)
- ❌ Need to know `last_seq` upfront for futures

### Alternatives Considered

#### Alt 1: Timestamp-Based Pagination
**Rejected because:**
- Non-deterministic results
- Gap risk too high
- Difficult to verify completeness

#### Alt 2: Hybrid Approach (Time + Seq)
Use timestamps for filtering, then seq within time ranges.

**Rejected because:**
- Added complexity
- Still vulnerable to timestamp issues
- Seq-only approach is simpler and more reliable

### Validation
After fetching, validate sequence continuity:
```typescript
function validateSequences(trades: Trade[]): boolean {
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].trade_seq !== trades[i-1].trade_seq + 1) {
      console.error(`Gap detected: ${trades[i-1].trade_seq} → ${trades[i].trade_seq}`);
      return false;
    }
  }
  return true;
}
```

---

## Decision 2: Dual Fetch Strategies

### Context
The system must handle two very different instrument types:
- **Futures:** Few instruments (5-10 per currency), millions of trades each
  - Example: BTC-PERPETUAL has 300M+ trades
- **Options:** Thousands of instruments, few trades each
  - Example: BTC-27DEC24-60000-C has ~5k trades
  - Total: 10,000+ option instruments for BTC

### Decision
Implement **two distinct fetch strategies**:
1. **FutureFetcher:** Chunk-based with concurrent fetching
2. **OptionFetcher:** Streaming with lazy enqueue

### Rationale

#### Futures: Chunk-Based, Concurrent

**Why:**
- Large datasets benefit from parallelism
- Chunks enable fine-grained resumability
- Can saturate API rate limit efficiently

**Strategy:**
1. Get `last_seq` from API (e.g., 300,000,000 for BTC-PERPETUAL)
2. Pre-allocate chunks: [1-10k], [10k-20k], ..., [299.99M-300M]
3. Fetch chunks concurrently (5+ parallel workers)
4. Mark chunks as done atomically

**Benefits:**
- 10-50x speedup vs sequential
- Crash-safe: incomplete chunks re-fetched on restart
- Progress visible at chunk level

**Example:**
```
BTC-PERPETUAL (300M trades, 10k per chunk = 30,000 chunks)
Sequential: 30,000 API calls × 2s each = 16.7 hours
Concurrent (5 workers): 30,000 / 5 × 2s = 3.3 hours
```

#### Options: Streaming, Lazy Enqueue

**Why:**
- Most options have < 10k trades (single API call)
- Don't know trade count upfront for expired options
- Overwhelming to pre-allocate for 10,000+ options

**Strategy:**
1. Get `last_no` from progress table (resume offset)
2. Fetch chunk starting from `last_no + 1`
3. If has_more, enqueue next chunk lazily
4. Stop when no more trades

**Benefits:**
- Memory efficient (no pre-allocation)
- Simple for small datasets
- Handles unknown trade counts gracefully

**Example:**
```
BTC-27DEC24-60000-C (5k trades)
Fetch seq 0-10k → returns 5k trades, has_more=false
Done in 1 API call!
```

### Trade-offs

**Futures (Concurrent Chunks):**
- ✅ Massively faster for large datasets
- ✅ Fine-grained resumability
- ❌ Requires upfront `last_seq` API call
- ❌ More complex (chunk management, concurrency)

**Options (Streaming):**
- ✅ Simple implementation
- ✅ Memory efficient
- ✅ No pre-allocation overhead
- ❌ Sequential only (no parallelism)
- ❌ Slower for large datasets (rare for options)

### Alternatives Considered

#### Alt 1: Single Strategy (Streaming for All)
**Rejected because:**
- Too slow for large futures (16+ hours for BTC-PERPETUAL)
- Wasted opportunity for parallelism

#### Alt 2: Single Strategy (Chunked for All)
**Rejected because:**
- Overhead for small options (most have < 1k trades)
- 10,000 instruments × chunk tables = database bloat
- Pre-allocation complexity not worth it for options

#### Alt 3: Auto-Switch Based on Trade Count
Fetch first chunk, if large, switch to chunked mode.

**Rejected because:**
- Added complexity
- Type-based switching is simpler and predictable
- Can't easily switch mid-fetch

### Implementation

```typescript
// CLI automatically chooses strategy
if (instrument.kind === "future") {
  await futureFetcher.fetchInstrument(instrument.name);
} else if (instrument.kind === "option") {
  await optionFetcher.fetchInstrument(instrument.name);
}
```

---

## Decision 3: JSONL Intermediate Storage

### Context
Trade data must be stored reliably and efficiently. Options:
1. SQLite directly
2. Parquet directly
3. JSONL → Parquet pipeline

### Decision
Use **JSONL (JSON Lines) as intermediate storage**, with planned Parquet conversion.

### Rationale

#### Crash Safety
- **JSONL:** Append-only format. Partial writes = truncated file, data intact.
- **Parquet:** Columnar, immutable. Partial write = corrupted file, data lost.
- **SQLite:** Needs WAL/journal. Still more complex than append-only.

**Example crash scenario:**
```
Writing trade 50,000 / 100,000...
[CRASH]

JSONL: File has 50,000 valid lines, resume from line 50,001 ✅
Parquet: File corrupted, re-download entire file ❌
```

#### Human Readable
- **JSONL:** Plain text, easy to inspect, debug, or manually edit
- **Parquet:** Binary format, requires special tools

**Debugging example:**
```bash
# Inspect first trade
head -1 data/jsonl/BTC/BTC-PERPETUAL.jsonl | jq .

# Count trades
wc -l data/jsonl/BTC/BTC-PERPETUAL.jsonl

# Search for specific seq
grep '"trade_seq":123456' data/jsonl/BTC/BTC-PERPETUAL.jsonl
```

#### Simplicity
- **JSONL:** Single-pass append, minimal logic
- **Parquet:** Complex schema management, row groups, compression settings

#### Incrementality
- **JSONL:** Append new trades anytime
- **Parquet:** Immutable after write, must rewrite entire file

### Trade-offs

**Advantages:**
- ✅ Crash-safe (append-only)
- ✅ Human-readable
- ✅ Simple implementation
- ✅ Incremental writes
- ✅ Easy validation/debugging

**Disadvantages:**
- ❌ Larger file size vs Parquet (~5x)
- ❌ Slower analytics (line-by-line parsing)
- ❌ Extra conversion step to Parquet

### Size Comparison

```
BTC-PERPETUAL (300M trades):
- JSONL: ~50 GB
- Parquet (compressed): ~10 GB
- SQLite: ~30 GB
```

### Conversion Strategy

JSONL serves as the **source of truth**. Convert to Parquet for analytics:

```bash
# Using DuckDB
duckdb -c "
  COPY (
    SELECT DISTINCT ON (instrument_name, trade_seq) *
    FROM read_json_auto('data/jsonl/**/*.jsonl')
  ) TO 'trades.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
"
```

**Benefits of two-stage pipeline:**
1. **Reliability:** JSONL ensures no data loss during fetch
2. **Performance:** Parquet optimized for analytics
3. **Flexibility:** Can regenerate Parquet anytime from JSONL

### Alternatives Considered

#### Alt 1: SQLite Only
**Rejected because:**
- Write amplification (B-tree updates)
- WAL complexity
- Large database files harder to distribute
- Slower for scan queries vs Parquet

#### Alt 2: Parquet Only
**Rejected because:**
- Crash risk (immutable format)
- Difficult to debug
- Complex append logic
- Harder to implement resumability

#### Alt 3: CSV
**Rejected because:**
- Escaping issues (commas in strings)
- No schema (type ambiguity)
- JSONL is self-describing

---

## Decision 4: SQLite for Metadata Only

### Context
SQLite database stores:
- ❌ Trade data (DEPRECATED - now in JSONL)
- ✅ Instrument metadata
- ✅ Checkpoint progress (future_chunks, option_progress)
- ✅ Delivery prices
- ✅ Greeks

### Decision
Use SQLite **only for metadata and checkpoints**, not for trade data.

### Rationale

#### Database Size
**Old approach (trades in SQLite):**
- BTC-PERPETUAL: 300M trades × ~200 bytes = 60 GB database
- Slow inserts, large file, slow backups

**New approach (metadata only):**
- 10,000 instruments × ~500 bytes = ~5 MB
- Future chunks: 30,000 chunks × ~100 bytes = ~3 MB
- Total: < 50 MB for complete metadata

#### Performance
**Checkpoints (frequent, small):**
- SQLite excels at small, indexed queries
- Fast updates for progress tracking

**Trades (infrequent, large):**
- JSONL better for bulk appends
- No index overhead
- Faster writes

#### Backup & Distribution
**Small SQLite DB:**
- Fast to back up (< 100 MB)
- Easy to distribute
- Quick to restore

**Large trade data:**
- Stay in JSONL (distributed separately)
- Can regenerate SQLite from JSONL if needed

### Trade-offs

**Advantages:**
- ✅ Small, fast database (< 100 MB vs 60+ GB)
- ✅ Quick checkpoint queries
- ✅ Easy backup/restore
- ✅ Separation of concerns (metadata vs data)

**Disadvantages:**
- ❌ Can't query trades directly via SQL
- ❌ Need JSONL → Parquet for analytics
- ❌ Two storage systems to manage

### What Stays in SQLite

```sql
-- Metadata (small, frequently queried)
instruments (instrument_name, kind, strike, expiration, last_seq, ...)
future_chunks (instrument_name, chunk_start_seq, chunk_end_seq, is_done, ...)
option_progress (instrument_name, last_no, status, trade_count, ...)

-- Reference data (small)
delivery_prices (index_name, date, delivery_price)

-- Derived data (optional, for quick access)
greeks (instrument_name, timestamp, delta, gamma, vega, theta, ...)
```

### Alternatives Considered

#### Alt 1: Everything in SQLite
**Rejected because:**
- 60+ GB database files
- Slow inserts
- Difficult to distribute
- Write amplification

#### Alt 2: Everything in JSONL
**Rejected because:**
- Can't efficiently query checkpoints
- No indexes for fast lookups
- Progress tracking would be slow

#### Alt 3: NoSQL (MongoDB, etc.)
**Rejected because:**
- Added dependency
- Overkill for simple checkpoint tracking
- SQLite is built into Bun

---

## Decision 5: Disk-First Writes

### Context
When fetching a chunk of trades, two operations must happen:
1. Write trades to JSONL (disk)
2. Update checkpoint in SQLite (database)

What order should these happen in?

### Decision
**Write to disk (JSONL) first, then update checkpoint.**

```typescript
// Step 1: Fetch trades from API
const trades = await client.getTradesBySeq(start, end);

// Step 2: FLUSH TO DISK FIRST
await storage.appendTrades(instrumentName, trades);
await storage.flush(); // ← Ensure data hits disk

// Step 3: THEN update checkpoint
database.updateProgress(instrumentName, lastSeq, tradeCount);
```

### Rationale

#### Prefer Duplicates Over Gaps

**Crash scenarios:**

**Option A: Disk first (our choice)**
```
1. Write trades to JSONL ✅
2. [CRASH before DB update]
Result: Trades on disk, checkpoint not updated
On restart: Re-fetch same chunk → duplicates in JSONL ✅
Outcome: Safe! Duplicates removed during Parquet merge.
```

**Option B: DB first (rejected)**
```
1. Update checkpoint in DB ✅
2. [CRASH before JSONL write]
Result: Checkpoint updated, but trades not on disk
On restart: Checkpoint says "done", skip this chunk → GAP ❌
Outcome: DATA LOSS!
```

#### Duplicates Are Recoverable, Gaps Are Not

- **Duplicates:** Can be detected and removed (by `trade_seq`)
- **Gaps:** Cannot be detected without external verification. Lost data is unrecoverable.

#### Idempotency

By writing disk-first, the system is **idempotent**:
- Re-running the same chunk multiple times = same final result (after dedup)
- Safe to retry on any error

### Trade-offs

**Advantages:**
- ✅ No data loss on crash
- ✅ Idempotent (safe to retry)
- ✅ Duplicates easily detected/removed

**Disadvantages:**
- ❌ Possible duplicate trades in JSONL
- ❌ Slightly slower (must flush before DB update)

### Flush Implementation

```typescript
class JSONLStorage {
  async appendTrades(instrumentName: string, trades: Trade[]): Promise<void> {
    const sink = await this.getSink(instrumentName);

    for (const trade of trades) {
      sink.write(JSON.stringify(trade) + "\n");
    }

    // CRITICAL: Flush to ensure data hits disk
    await sink.flush();
  }
}
```

### Checkpoint MAX Guard

To prevent rollback on concurrent crashes:

```sql
-- Use MAX to prevent progress from going backward
UPDATE option_progress
SET last_no = MAX(last_no, ?)
WHERE instrument_name = ?
```

This ensures if two processes crash and restart, the furthest progress wins.

### Alternatives Considered

#### Alt 1: DB First
**Rejected because:**
- Data loss on crash
- Gaps unacceptable

#### Alt 2: Atomic Transaction (DB + File)
**Rejected because:**
- Impossible to make JSONL + SQLite atomic together
- File systems don't support this
- Added complexity

#### Alt 3: Write-Ahead Log (WAL)
Create a WAL for JSONL writes, commit to DB only after WAL flush.

**Rejected because:**
- Over-engineered
- JSONL itself is already append-only (crash-safe)
- DB-second approach is simpler

---

## Decision 6: Dedup at Merge Time

### Context
Due to Design Decision #5 (prefer duplicates), JSONL files may contain duplicate trades.

### Decision
**Tolerate duplicates in JSONL. Deduplicate during Parquet merge.**

### Rationale

#### Simplicity During Fetch
- No need to check for duplicates during download
- Faster writes (append-only)
- Simpler error handling

#### Single Source of Truth
- JSONL = raw data (may have duplicates)
- Parquet = clean data (deduped)
- Easy to audit: compare JSONL line count vs Parquet row count

#### Deterministic Dedup
Dedup key: `(instrument_name, trade_seq)`

```sql
-- DuckDB dedup during merge
SELECT DISTINCT ON (instrument_name, trade_seq) *
FROM read_json_auto('data/jsonl/**/*.jsonl')
ORDER BY instrument_name, trade_seq
```

**Why this works:**
- `trade_seq` is unique per instrument (Deribit guarantee)
- Deterministic ordering
- Idempotent (run multiple times = same result)

### Trade-offs

**Advantages:**
- ✅ Simpler fetch logic (no dedup checks)
- ✅ Faster writes
- ✅ Clear separation (raw vs clean data)
- ✅ Deterministic dedup

**Disadvantages:**
- ❌ JSONL files larger than necessary
- ❌ Extra processing step (merge)
- ❌ Disk space waste (temporary)

### Duplicate Sources

Where duplicates come from:

1. **Crash recovery:** (Design Decision #5)
   - Fetch chunk 1-10k, write to disk, crash before DB update
   - Restart, re-fetch 1-10k → duplicates

2. **API boundary overlaps:**
   - Rare, but Deribit may return last trade of previous chunk in next chunk
   - Example: Request 1-10k returns 10,000 trades, last is seq 10,000
   - Request 10,001-20k might also include seq 10,000

### Dedup Strategy

**During Parquet merge:**
```sql
COPY (
  SELECT DISTINCT ON (instrument_name, trade_seq)
    instrument_name, trade_seq, timestamp, price, amount, ...
  FROM read_json_auto('data/jsonl/**/*.jsonl')
  ORDER BY instrument_name, trade_seq
) TO 'trades.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
```

**Dedup validation:**
```typescript
const jsonlCount = countLinesInJSONL();
const parquetCount = countRowsInParquet();
console.log(`Removed ${jsonlCount - parquetCount} duplicates`);
```

### Alternatives Considered

#### Alt 1: Dedup During Write
Check JSONL for duplicates before appending.

**Rejected because:**
- Requires reading entire file before each write (slow)
- Defeats append-only simplicity
- Race conditions in concurrent writes

#### Alt 2: In-Memory Dedup
Keep a Set of seen `trade_seq` in memory.

**Rejected because:**
- 300M trades × 8 bytes per seq = 2.4 GB memory
- Not scalable
- Lost on crash (back to duplicates anyway)

#### Alt 3: No Dedup (Trust API)
Assume API never returns duplicates.

**Rejected because:**
- Violates Design Decision #5 (prefer duplicates)
- Crash recovery would cause duplicates anyway
- Better to have explicit dedup step

---

## Summary Table

| Decision | Choice | Key Benefit | Main Trade-off |
|----------|--------|-------------|----------------|
| **1. Pagination** | Seq-based | Deterministic, no gaps | Can't filter by time before fetch |
| **2. Fetch Strategy** | Dual (Futures=chunks, Options=stream) | Optimized for each type | More complex codebase |
| **3. Storage Format** | JSONL → Parquet | Crash-safe, human-readable | Larger files, extra conversion step |
| **4. Database Role** | Metadata only | Small DB (< 100 MB) | Can't query trades via SQL directly |
| **5. Write Order** | Disk-first | No data loss | Possible duplicates |
| **6. Dedup Timing** | Merge-time | Simple fetch logic | Temporary disk space waste |

---

## Decision Evolution

These decisions were validated through:
1. **Design Phase:** Analysis of timestamp vs seq-based approaches
2. **Implementation:** Dual fetch strategies and JSONL storage
3. **Testing:** Real workloads (BTC-PERPETUAL with 300M trades, 10k+ options)
4. **Production:** Reliable, performant system for complete historical downloads

---

**Next:** [Data Model →](data-model.md)
