# Parquet Merge Process

## Overview

The JSONL files are intermediate storage. For analysis, they should be merged into Parquet format with deduplication.

## Design Decision #3: JSONL → Parquet Pipeline

**Why not write Parquet directly?**
- Parquet is columnar and immutable - awkward for append-only incremental writes
- A crash during Parquet write can corrupt the file
- JSONL is append-only, human-inspectable, and crash-safe

**Process:**
1. JSONL files accumulate during fetch (one per instrument)
2. Separate merge step converts JSONL → Parquet
3. Deduplication happens during merge (Design Decision #6)

## Deduplication Strategy (Design Decision #6)

**Where duplicates come from:**
- API boundary overlaps (Deribit may return 1 duplicate trade_seq at chunk boundaries)
- Crash recovery (Design Decision #5: prefer duplicates over gaps)

**Dedup key:** `(instrument_name, trade_seq)`

**Approach:**
- Order-independent exact dedup using bitmap
- One bit per sequence position per instrument
- Memory: `O(max_seq)` per instrument, not `O(num_trades)`

## Implementation Options

### Option A: Python with PyArrow (Recommended)

Use the reference implementation's approach:

```python
import pyarrow as pa
import pyarrow.parquet as pq
import json

def merge_jsonl_to_parquet(jsonl_dir: str, output_path: str):
    """
    Merge all JSONL files into a single Parquet file with dedup
    """
    # Collect all trades
    trades = []
    seen = set()  # (instrument_name, trade_seq)

    for jsonl_file in glob(f"{jsonl_dir}/**/*.jsonl"):
        with open(jsonl_file) as f:
            for line in f:
                trade = json.loads(line)
                key = (trade['instrument_name'], trade['trade_seq'])

                if key not in seen:
                    seen.add(key)
                    trades.append(trade)

    # Convert to PyArrow Table
    table = pa.Table.from_pylist(trades)

    # Write Parquet with compression
    pq.write_table(table, output_path, compression='zstd')
```

### Option B: Bun with TypeScript

Bun doesn't have native Parquet support yet. Options:

1. **Shell out to Python:** Run Python script from Bun
2. **Use parquetjs:** Limited TypeScript library (less mature)
3. **Export as CSV:** For simple analysis needs

### Option C: DuckDB (SQL Interface)

Use DuckDB to query JSONL directly or convert to Parquet:

```sql
-- Read JSONL directly
SELECT * FROM read_json_auto('data/jsonl/**/*.jsonl');

-- Convert to Parquet
COPY (
  SELECT DISTINCT ON (instrument_name, trade_seq) *
  FROM read_json_auto('data/jsonl/**/*.jsonl')
  ORDER BY instrument_name, trade_seq
) TO 'output.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
```

## Recommended Workflow

For this TypeScript/Bun project:

1. **Fetch stage:** Use Bun CLI to download to JSONL
2. **Analysis stage:** Use DuckDB or Python for Parquet conversion
3. **Keep both:** JSONL as source of truth, Parquet for fast queries

## Example DuckDB Script

```sql
-- stats.sql
SELECT
  instrument_name,
  COUNT(*) as trade_count,
  MIN(timestamp) as first_trade,
  MAX(timestamp) as last_trade,
  MIN(trade_seq) as min_seq,
  MAX(trade_seq) as max_seq
FROM read_json_auto('data/jsonl/**/*.jsonl')
GROUP BY instrument_name
ORDER BY trade_count DESC;
```

Run with:
```bash
duckdb -c ".read stats.sql"
```

## Schema Validation

Before merging, validate JSONL schema:

```typescript
// validate-jsonl.ts
import { DeribitTradeSchema } from "../src/domain/models.ts";

async function validateJSONL(file: string) {
  const text = await Bun.file(file).text();
  const lines = text.trim().split("\n");

  for (const [i, line] of lines.entries()) {
    try {
      const trade = JSON.parse(line);
      DeribitTradeSchema.parse(trade); // Validates with Zod
    } catch (error) {
      console.error(`Invalid trade at line ${i + 1}: ${error}`);
      return false;
    }
  }

  return true;
}
```

## Next Steps

1. ✅ JSONL storage implemented
2. ⏸️ Parquet merge: Use DuckDB or Python as separate step
3. ⏸️ Validation: Add JSONL schema validation script
4. ⏸️ Gap detection: Check for missing trade_seq ranges per instrument
