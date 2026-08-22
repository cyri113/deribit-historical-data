# Design Decisions

Core choices with rationale and trade-offs.

## 1. Seq-Based Pagination

**Decision**: Use `trade_seq` ranges (not timestamps) via history API.

**Rationale**:
- Deterministic, monotonic, no overlaps/gaps
- Resumable from precise `last_seq + 1`
- Simple dedup by `trade_seq` only

**Timestamp problem**:
```
Request 1: 2024-01-01 00:00:00 to 00:00:01
Returns: [trade A @ 00:00:00, trade B @ 00:00:00, trade C @ 00:00:01]

Request 2: resume from 00:00:01
Returns: [trade C @ 00:00:01, trade D @ 00:00:01]
Problem: trade C duplicated! If >10k trades at 00:00:01, some skipped.
```

**Trade-offs**:
- ✅ Deterministic, reproducible, no gaps
- ❌ Requires history API (not all exchanges)
- ❌ Can't filter by time before fetching

---

## 2. Simplified Fetch Strategy

**Decision**: Fetch all trades [1, lastSeq] in memory, write to Parquet.

**Rationale**:
- 99% of instruments have <10k trades (single API call)
- BTC-PERPETUAL not fetched (only large outlier, 300M+ trades)
- Chunking/streaming complexity unnecessary for typical instruments
- Filesystem idempotency (check Parquet exists → skip) sufficient

**Strategy**:
```typescript
async fetchInstrument(instrumentName: string) {
  // 1. Check if already fetched (idempotent)
  if (existsSync(parquetPath)) return { skipped: true };

  // 2. Get total count
  const lastSeq = await client.getLastTradeSeq(instrumentName);

  // 3. Fetch all trades in memory [1, lastSeq]
  const allTrades = [];
  for await (const trades of client.getAllTradesBySeq(instrumentName, 1, lastSeq, 10000)) {
    allTrades.push(...trades);
  }

  // 4. Write directly to Parquet
  await parquetStorage.writeTrades(instrumentName, allTrades);
}
```

**Trade-offs**:
- ✅ Simple, unified codebase (~135 lines per fetcher vs ~349 lines before)
- ✅ No database for progress tracking
- ✅ Idempotent via filesystem (re-run skips completed)
- ❌ Can't resume mid-instrument (but most <10k trades, <10s fetch)
- ❌ Higher memory usage (but <10k trades = ~2MB)

---

## 3. Direct Parquet Storage

**Decision**: Write trades directly to Parquet, no JSONL intermediate layer.

**Rationale**:
- 99% of instruments complete in <10s (single fetch, single write)
- Filesystem idempotency makes crashes recoverable
- No need for append-only format when most finish in one operation
- Simpler pipeline: Fetch → Parquet (vs Fetch → JSONL → Parquet → Delete)

**Crash Recovery**:
```
[CRASH mid-fetch of BTC-25DEC24-50000-C]
→ Parquet file NOT created at its final path (atomic write via temp+rename)
→ Re-run: No Parquet exists at the final path → fetch again ✅
→ No corrupted files, no cleanup needed (stale .tmp auto-removed on next write)
```

**Implementation note**: `ParquetStorage.writeTrades`/`appendTrades`/
`writeFuturesTrades` write to a `{path}.tmp` sibling and `rename()` into the
final path only after the writer closes successfully (`writeAtomic` in
`parquet-storage.ts`). This was a real gap for a while: the writer used to
open the `ParquetWriter` directly at the final path, so a crash/SIGKILL/OOM
mid-write could leave a truncated file exactly where `existsSync` checks
look -- silently and permanently treated as "already complete" on every
future run (a survivorship-bias mechanism for a historical dataset).
`appendTrades` was worse, since it rewrites the *entire* file (existing +
merged trades) in place, so an interruption could destroy previously-good
data, not just fail to add new data. Fixed by routing all three through
`writeAtomic`.

**Trade-offs**:
- ✅ Simpler pipeline (1 write vs 2 writes + cleanup)
- ✅ No JSONL disk usage (save ~140GB temporary space)
- ✅ Atomic writes (Parquet only created/replaced on success, via temp+rename)
- ❌ Can't resume partial fetch (but <10s per instrument, acceptable)

---

## 4. Filesystem-Based Idempotency

**Decision**: Use Parquet file existence checks, no SQLite for progress tracking.

**Rationale**:
- `existsSync(parquetPath)` is atomic and fast
- No state management: filesystem IS the source of truth
- Re-runnable: `bronze BTC` skips completed instruments automatically
- No schema migrations: no database to maintain
- Embedded metadata: all instrument info via `parseInstrumentName()` from filename

**Implementation**:
```typescript
const parquetPath = this.parquetStorage.getTradeFilePath(instrumentName);
if (existsSync(parquetPath)) {
  console.log(`✓ ${instrumentName} already complete`);
  return { skipped: true };
}
```

**Only SQLite usage**: BunQueue job queue (`data/queue.db`)

**Trade-offs**:
- ✅ Zero database schema to maintain
- ✅ Perfect idempotency (re-run anytime, skips completed)
- ✅ Filesystem = single source of truth
- ❌ Can't query progress via SQL (use filesystem stats instead)
- ❌ No partial progress tracking (instrument-level only)

---

## 5. BunQueue Workflows

**Decision**: Use BunQueue for job queue instead of custom web dashboard.

**Rationale**:

**Custom Dashboard (Removed)**:
- 650+ lines (WebSocket server + React frontend)
- 4 React dependencies
- Single-purpose: progress monitoring only

**BunQueue (Adopted)**:
- Zero external infrastructure (embedded SQLite)
- Built-in dashboard + retry + failure handling + background jobs
- Single dependency, MIT licensed
- ~100 lines integration code

**Feature Comparison**:

| Feature | Custom | BunQueue |
|---------|--------|----------|
| Progress monitoring | ✅ | ✅ |
| Job retry | ❌ | ✅ (3x, exponential backoff) |
| Failure tracking | ❌ | ✅ (DLQ, error logs) |
| Background jobs | ❌ | ✅ |
| Cron scheduling | ❌ | ✅ |
| Code to maintain | 650 lines | 100 lines |

**Note -- two separate retry layers**: this table's "Job retry" is BunQueue
retrying an entire failed *job* (e.g. re-running `fetch-trades` for a
currency). That's distinct from `DeribitClient`'s own retry/backoff on
individual HTTP requests (429/any 5xx) inside `withRetry` in
`deribit-client.ts`, which every endpoint method now routes through. Both
matter: without the per-request layer, a single transient rate-limit hit
mid-pagination would throw out of the fetch immediately rather than backing
off and retrying that one request, and (before the `fetch-trades` handler
was fixed to re-throw on any per-instrument failure) the job-level layer
never even got a chance to retry since the job always reported "completed."

**Commands**:
```bash
queue-worker      # Process jobs (run in separate terminal)
queue-dashboard   # Web UI at http://localhost:6790
queue-status      # CLI status
```

**Trade-offs**:
- ✅ Professional queue infrastructure, -550 lines code
- ✅ Retry, DLQ, background processing built-in
- ✅ Dashboard included
- ❌ External dependency (minimal, MIT)
- ❌ Dashboard not custom-tailored (but feature-rich)

---

## 6. DuckDB SQL Greeks

**Decision**: DuckDB SQL (default) + TypeScript (legacy fallback).

**Performance**:

| Method | Throughput | Memory | CPU |
|--------|-----------|--------|-----|
| TypeScript | 1-2k/sec | High | 1 core |
| DuckDB SQL | 20-50k/sec | Low (streaming) | All cores |

**Example**: 1M trades = 500s TypeScript vs 25s DuckDB (20x faster)

**Implementation**: DuckDB WASM has no UDF → Black-76 as pure SQL templates (CDF via Abramowitz-Stegun)

**Use Cases**:
- **DuckDB**: >100k trades, max performance, memory-constrained
- **TypeScript**: <100k trades, debugging, custom logic

**Trade-offs**:
- ✅ 10-100x faster
- ❌ More complex SQL generation

---

## 7. Medallion Architecture

**Decision**: Bronze (raw) → Silver (enriched) → Gold (analytics).

**Structure**:
```
data/
├── bronze/instruments/BTC/  # Raw trades, one file per instrument
├── bronze/futures/          # Dated futures for forward prices
├── silver/BTC.parquet       # Single file: all instruments + Greeks
└── queue.db                 # BunQueue state
```

**Benefits**:
- Standard data lakehouse pattern
- Clear separation of concerns
- Optimized for analytics (read one silver file, not thousands of bronze files)
- Better compression (across all data)

**Silver Layer Strategy**:
- Single DuckDB query reads ALL bronze files → writes one silver file
- 10-100x faster than per-file processing
- Standard lakehouse pattern

---

## 8. Strict Data Quality

**Decision**: Greeks = NULL if no futures_price (no fallback to spot index_price).

**Rationale**:
- Spot price ≠ forward price (basis risk, funding, time value)
- Inaccurate Greeks worse than missing Greeks for analytics
- Preserve all data: spot price available in `index_price` column for audit
- Use `is_valid` flag to filter analytics-ready data

**is_valid flag**:
- `TRUE` = Has futures_price, IV > 0, TTM > 1 day, valid Greeks
- `FALSE` = Missing futures, IV=0, very short-dated, or NaN Greeks

**Recommendation**:
```sql
SELECT * FROM 'data/silver/BTC.parquet'
WHERE is_valid = true  -- Analytics-ready data only
```

**Trade-offs**:
- ✅ Accurate Greeks for backtesting
- ✅ All data preserved for audit
- ❌ Lower coverage (~82% with futures vs 100% with spot fallback)

---

## Summary

| Decision | Choice | Key Benefit | Trade-off |
|----------|--------|-------------|-----------|
| Pagination | Seq-based | Deterministic, no gaps | Can't filter by time before fetch |
| Fetch | Unified (all in memory) | Simple (~135 lines/fetcher) | Can't resume mid-instrument |
| Storage | Direct Parquet | Atomic writes, simple pipeline | Can't resume partial fetch |
| Idempotency | Filesystem (Parquet exists) | Zero DB maintenance | No partial progress tracking |
| Workflow | BunQueue | -550 lines, retry/DLQ | External dependency |
| Greeks | DuckDB SQL | 10-100x faster | Complex SQL generation |
| Architecture | Medallion (bronze/silver) | Standard lakehouse pattern | More directories |
| Quality | Strict (no fallback) | Accurate Greeks | Lower coverage (~82%) |
