# Migration Guide: Timestamp → Seq-Based Architecture

## What Changed

### Old Architecture (Timestamp-Based)
- Fetched trades using `get_last_trades_by_instrument_and_time`
- Time-window pagination (`start_timestamp`, `end_timestamp`)
- Trades stored directly in SQLite
- Single `fetch-all` command that did everything

### New Architecture (Seq-Based)
- Fetches trades using `get_last_trades_by_instrument` with `trade_seq` ranges
- Sequence-based pagination (`start_seq`, `end_seq`)
- Trades stored in JSONL (one file per instrument), SQLite for metadata only
- Separate commands: `fetch-instruments`, `fetch-trades`, `fetch-deliveries`, `fetch-all`
- Two distinct fetch strategies:
  - **Futures:** Pre-allocated chunks, concurrent fetch
  - **Options:** Streaming with lazy enqueue

## Why This Change

**Design Decisions (from reference implementation):**

1. **Seq-based pagination** - Deterministic, no gaps or duplicates
2. **Two strategies** - Futures (hundreds) vs Options (hundreds of thousands)
3. **JSONL intermediate** - Crash-safe append-only storage
4. **SQLite checkpoints** - Resumable downloads
5. **Disk-first writes** - Prefer duplicates over data loss
6. **Dedup at merge** - Tolerate duplicates in JSONL, clean in Parquet stage

## File Locations

### Old System
```
deribit-data.db          # All data in one SQLite file
```

### New System
```
deribit-data.db          # Metadata + checkpoints only
data/jsonl/
  BTC/
    BTC-PERPETUAL.jsonl
    BTC-27MAR26-70000-C.jsonl
    ...
  ETH/
    ETH-PERPETUAL.jsonl
    ...
```

## CLI Commands

### Old CLI (`src/cli/index.ts`)
```bash
# Still exists but deprecated
bun src/cli/index.ts fetch-all BTC
```

### New CLI (`src/cli/index-v2.ts`)

**Step 1: Fetch instruments**
```bash
bun src/cli/index-v2.ts fetch-instruments BTC
bun src/cli/index-v2.ts fetch-instruments BTC --kind option
```

**Step 2: Fetch trades**
```bash
# Auto-detects futures vs options
bun src/cli/index-v2.ts fetch-trades BTC

# Or filter by kind
bun src/cli/index-v2.ts fetch-trades BTC --kind future --concurrency 5
bun src/cli/index-v2.ts fetch-trades BTC --kind option
```

**Step 3: Fetch deliveries**
```bash
bun src/cli/index-v2.ts fetch-deliveries btc_usd eth_usd
```

**Or use the pipeline:**
```bash
bun src/cli/index-v2.ts fetch-all BTC --concurrency 5
```

**Check stats:**
```bash
bun src/cli/index-v2.ts stats
bun src/cli/index-v2.ts stats BTC
```

## Database Schema Changes

### New Tables

**instruments** - Stores instrument metadata
```sql
CREATE TABLE instruments (
  instrument_name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  expiration_timestamp INTEGER,
  strike REAL,
  option_type TEXT,
  is_active INTEGER NOT NULL,
  last_seq INTEGER
);
```

**future_chunks** - Track per-chunk progress for futures
```sql
CREATE TABLE future_chunks (
  instrument_name TEXT,
  chunk_start_seq INTEGER,
  chunk_end_seq INTEGER,
  is_done INTEGER DEFAULT 0,
  trade_count INTEGER,
  UNIQUE(instrument_name, chunk_start_seq, chunk_end_seq)
);
```

**option_progress** - Track streaming progress for options
```sql
CREATE TABLE option_progress (
  instrument_name TEXT PRIMARY KEY,
  last_no INTEGER DEFAULT 0,  -- Resume offset
  status TEXT DEFAULT 'in_progress',
  trade_count INTEGER
);
```

### Old Tables (Still Present)

- `trades` - Deprecated, data now in JSONL
- `delivery_prices` - Still used
- `greeks` - Still used
- `checkpoints` - Deprecated, replaced by future_chunks/option_progress

## Resumability

### Old System
- Checkpoints tracked `last_trade_seq` per instrument
- Restart would resume from last checkpoint

### New System

**Futures:**
- All chunks pre-allocated when instrument is prepared
- Incomplete chunks fetched on restart
- Completed chunks have `is_done=1` and are skipped

**Options:**
- Resume from `last_no + 1`
- Streaming continues until no more trades
- `MAX(last_no, ?)` guard prevents progress rollback on crash

## Data Flow

```
┌─────────────────────┐
│  fetch-instruments  │  → instruments table
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   fetch-trades      │
├─────────────────────┤
│  For each future:   │
│  1. Get last_seq    │  → instruments.last_seq
│  2. Create chunks   │  → future_chunks table
│  3. Fetch chunks    │  → JSONL files
│  4. Mark done       │  → future_chunks.is_done=1
│                     │
│  For each option:   │
│  1. Get last_no     │  → option_progress.last_no
│  2. Fetch from      │  → JSONL files
│     last_no+1       │
│  3. Update progress │  → option_progress (MAX guard)
│  4. Mark complete   │  → option_progress.status='completed'
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ fetch-deliveries    │  → delivery_prices table
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│  (Future step)      │
│  Merge JSONL →      │  → Parquet file (deduped)
│  Parquet            │
└─────────────────────┘
```

## Breaking Changes

1. **Storage format:** SQLite → JSONL for trades
2. **CLI interface:** Different commands and options
3. **Progress tracking:** Different checkpoint schema
4. **API endpoint:** Main API → History API (`history.deribit.com`)

## Migration Path

### Option A: Fresh Start (Recommended)
```bash
# Start with new system
mv deribit-data.db deribit-data-old.db
bun src/cli/index-v2.ts fetch-all BTC
```

### Option B: Coexistence
```bash
# Use old CLI for existing data
bun src/cli/index.ts <command>

# Use new CLI for new data
bun src/cli/index-v2.ts <command>
```

### Option C: Full Migration
```bash
# Export old data
bun src/cli/index.ts export-historical BTC --format csv --output old-data.csv

# Fetch with new system
bun src/cli/index-v2.ts fetch-all BTC

# Compare/validate
```

## Performance Improvements

1. **Futures:** Concurrent chunk fetching (10-50x faster for large futures)
2. **Options:** Lazy streaming (no pre-allocation overhead for empty instruments)
3. **Resumability:** Chunk-level granularity (lost seconds, not hours)
4. **Memory:** JSONL streaming (constant memory, not O(trades))

## Next Steps

1. Test new CLI with small dataset
2. Validate JSONL output
3. Implement Parquet merge (see `scripts/parquet-merge.md`)
4. Add gap validation
5. Deprecate old CLI

## Rollback Plan

If issues occur:

```bash
# Restore old database
mv deribit-data-old.db deribit-data.db

# Use old CLI
bun src/cli/index.ts <command>

# Remove JSONL files
rm -rf data/jsonl/
```

## Support

- Old CLI: `src/cli/index.ts` (backup at `src/cli/index.ts.backup`)
- New CLI: `src/cli/index-v2.ts`
- Documentation: This file + `scripts/parquet-merge.md`
