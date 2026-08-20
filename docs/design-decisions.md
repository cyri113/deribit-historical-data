# Design Decisions

Core choices with rationale and trade-offs.

1. [Seq-Based Pagination](#decision-1-seq-based-pagination)
2. [Simplified Fetch Strategy](#decision-2-simplified-fetch-strategy)
3. [Direct Parquet Storage](#decision-3-direct-parquet-storage)
4. [Filesystem-Based Idempotency](#decision-4-filesystem-based-idempotency)
5. [BunQueue Workflows](#decision-5-bunqueue-for-workflow-management)
6. [DuckDB SQL Greeks](#decision-6-duckdb-sql-greeks-vs-typescript)

---

## Decision 1: Seq-Based Pagination

Use `trade_seq` ranges (not timestamps) via history API.

**Why:**
- **Deterministic:** Monotonic, no overlaps/gaps
- **Resumable:** Precise from `last_seq + 1`
- **Simple dedup:** By `trade_seq` only

**Timestamp problem:**
```
Request 1: 2024-01-01 00:00:00 to 00:00:01
Returns: [trade A @ 00:00:00, trade B @ 00:00:00, trade C @ 00:00:01]

Request 2: resume from 00:00:01
Returns: [trade C @ 00:00:01, trade D @ 00:00:01]
Problem: trade C duplicated! If >10k trades at 00:00:01, some skipped.
```

**Trade-offs:**
- ✅ Deterministic, reproducible, no gaps
- ❌ Requires history API (not all exchanges)
- ❌ Can't filter by time before fetching

**Validation:**
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

---

## Decision 2: Simplified Fetch Strategy

**Decision:** Single unified strategy for both futures and options - fetch all trades [1, lastSeq] in memory, write to Parquet.

**Rationale:**
- **99% of instruments have <10k trades** (single API call)
- **BTC-PERPETUAL is NOT fetched** (the only large outlier with 300M+ trades)
- Chunking/streaming complexity not needed for typical instruments
- Filesystem-based idempotency (check Parquet exists → skip) is sufficient

**Strategy:**
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

**Trade-offs:**
- ✅ Simple, unified codebase (~135 lines per fetcher vs ~349 lines before)
- ✅ No database needed for progress tracking
- ✅ Idempotent via filesystem (re-run skips completed instruments)
- ❌ Can't resume mid-instrument (but most are <10k trades, <10s fetch)
- ❌ Higher memory usage (but <10k trades = ~2MB)

---

## Decision 3: Direct Parquet Storage

**Decision:** Write trades directly to Parquet files, no JSONL intermediate layer.

**Rationale:**
- **99% of instruments complete in <10s** (single fetch, single write)
- **Filesystem idempotency** makes crashes recoverable (re-run skips completed instruments)
- **No need for append-only format** when most instruments finish in one operation
- **Simpler pipeline:** Fetch → Parquet (vs Fetch → JSONL → Parquet → Delete JSONL)

**Storage:**
```
data/parquet-raw/BTC/
  BTC-25DEC24-50000-C.parquet    ✅ Complete (skip on re-run)
  BTC-25DEC24-50000-P.parquet    ✅ Complete (skip on re-run)
  [no partial/temp files]
```

**Crash Recovery:**
```
[CRASH mid-fetch of BTC-25DEC24-50000-C]
→ Parquet file NOT created (atomic write)
→ Re-run: No Parquet exists → fetch again ✅
→ No corrupted files, no cleanup needed
```

**Trade-offs:**
- ✅ Simpler pipeline (1 write vs 2 writes + cleanup)
- ✅ No JSONL disk usage (save ~140GB temporary space)
- ✅ Atomic writes (Parquet only created on success)
- ❌ Can't resume partial fetch (but <10s per instrument, acceptable)

---

## Decision 4: Filesystem-Based Idempotency

**Decision:** Use Parquet file existence checks for idempotency, no SQLite database for progress tracking.

**Rationale:**
- **Simple and reliable:** `existsSync(parquetPath)` is atomic and fast
- **No state management:** Filesystem IS the source of truth
- **Re-runnable:** `fetch-all BTC` skips completed instruments automatically
- **No schema migrations:** No database to maintain
- **Embedded metadata:** All instrument metadata stored via `parseInstrumentName()` in Parquet

**Implementation:**
```typescript
// Check if already fetched (idempotent)
const parquetPath = this.parquetStorage.getTradeFilePath(instrumentName);
if (existsSync(parquetPath)) {
  console.log(`✓ ${instrumentName} already complete (Parquet exists)`);
  return { skipped: true };
}
```

**Only SQLite usage:** BunQueue job queue (`data/queue.db`) for job state management

**Trade-offs:**
- ✅ Zero database schema to maintain
- ✅ Perfect idempotency (re-run any time, skips completed)
- ✅ No database migrations needed
- ✅ Filesystem = single source of truth
- ❌ Can't query progress via SQL (use filesystem stats instead)
- ❌ No partial progress tracking (instrument-level only)

---

## Decision 5: BunQueue for Workflow Management

**Decision:** Use BunQueue for job queue instead of custom web dashboard.

**Rationale:**

**Custom Web Dashboard (Removed):**
- Custom WebSocket server (255 lines)
- React frontend (355 lines)
- Real-time progress updates (100ms polling)
- 4 React dependencies in package.json
- Custom integration tests
- Single-purpose: progress monitoring only

**BunQueue (Adopted):**
- Zero external infrastructure (embedded SQLite)
- Built-in web dashboard with full feature set
- Job queue + retry logic + failure handling
- Background job processing
- No custom server code needed
- Single dependency, MIT licensed

**Feature Comparison:**

| Feature | Custom Dashboard | BunQueue |
|---------|-----------------|----------|
| Progress monitoring | ✅ | ✅ |
| Job retry | ❌ | ✅ (3 attempts, exponential backoff) |
| Failure tracking | ❌ | ✅ (DLQ, error logs) |
| Background jobs | ❌ | ✅ |
| Cron scheduling | ❌ | ✅ |
| SQLite persistence | Partial (metadata only) | ✅ (full job state) |
| Web dashboard | Custom (355 lines) | Built-in |
| Code to maintain | ~650 lines | ~100 lines |

**Benefits:**
- **Less code:** 650+ lines removed, ~100 lines added (net -550 lines)
- **More features:** Retry logic, DLQ, cron, background processing
- **Better UX:** Professional dashboard vs custom implementation
- **Maintainability:** Upstream updates vs maintaining custom code
- **Bun-native:** Designed for Bun runtime (embedded mode)

**Trade-offs:**
- ✅ Professional job queue infrastructure
- ✅ 80% less code to maintain
- ✅ Built-in retry and failure handling
- ✅ Dashboard included (http://localhost:6790)
- ❌ Adds external dependency (but minimal, MIT licensed)
- ❌ Dashboard not custom-tailored (but feature-rich)

**Use Cases:**
- Monitor fetch progress via BunQueue dashboard
- Automatic retry of failed chunks
- Background enrichment jobs
- Scheduled re-fetches (cron)

**Commands:**
```bash
# Launch dashboard
bun src/cli/index.ts queue-dashboard

# Check queue status
bun src/cli/index.ts queue-status
```

---

## Decision 6: DuckDB SQL Greeks

Implement both: DuckDB SQL (default, 10-100x faster) and TypeScript (legacy).

**Performance:**
| Method | Throughput | Memory | CPU |
|--------|-----------|--------|-----|
| TypeScript | 1-2k/sec | High | 1 core |
| DuckDB | 20-50k/sec | Low (streaming) | All cores |

**Example:** 1M trades = 500s TypeScript vs 25s DuckDB (20x faster)

**How:** DuckDB WASM has no UDF → generate Black-76 as pure SQL templates (CDF via Abramowitz-Stegun)

**Use DuckDB when:** >100k trades, max performance, memory-constrained
**Use TypeScript when:** <100k trades, debugging, custom logic

**Trade-off:** 10-100x faster vs more complex SQL generation

---

## Summary

| Decision | Choice | Key Benefit | Main Trade-off |
|----------|--------|-------------|----------------|
| Pagination | Seq-based | Deterministic, no gaps | Can't filter by time before fetch |
| Fetch Strategy | Unified (fetch all in memory) | Simple codebase (~135 lines/fetcher) | Can't resume mid-instrument |
| Storage Format | Direct Parquet | Simple pipeline, atomic writes | Can't resume partial fetch |
| Idempotency | Filesystem-based (Parquet exists) | Zero database maintenance | No partial progress tracking |
| Workflow Management | BunQueue (embedded) | Professional queue, -550 lines | External dependency |
| Greeks Method | DuckDB (default) | 10-100x faster | More complex SQL generation |

---

**Next:** [Data Model →](data-model.md)
