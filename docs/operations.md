# Operations Guide

Complete guide for installing, running, monitoring, and troubleshooting the Deribit Historical Data Pipeline.

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [CLI Commands](#cli-commands)
4. [Monitoring Progress](#monitoring-progress)
5. [Resuming Downloads](#resuming-downloads)
6. [Performance Tuning](#performance-tuning)
7. [Troubleshooting](#troubleshooting)
8. [Maintenance](#maintenance)

---

## Installation

### Prerequisites

- **Bun** v1.0+ (runtime)
- **Git** (for cloning)
- **~50GB+ free disk space** (for BTC-PERPETUAL)

### Step 1: Install Bun

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

### Step 2: Clone Repository

```bash
git clone https://github.com/YOUR_USERNAME/deribit-historical-data.git
cd deribit-historical-data
```

### Step 3: Install Dependencies

```bash
bun install
```

### Step 4: Verify Installation

```bash
# Run help command
bun src/cli/index.ts help

# Run tests (optional)
bun test
```

---

## Quick Start

### Fetch All BTC Data

Complete pipeline (instruments → trades → deliveries):

```bash
bun src/cli/index.ts fetch-all BTC
```

This will:
1. Fetch all BTC instruments (options + futures)
2. Download all trades to `data/jsonl/BTC/`
3. Fetch delivery prices for btc_usd
4. Show progress and statistics

**Estimated time:** 2-6 hours (depending on concurrency)

### Fetch Specific Data

#### Only Instruments
```bash
bun src/cli/index.ts fetch-instruments BTC
```

#### Only Futures Trades
```bash
bun src/cli/index.ts fetch-trades BTC --kind future --concurrency 5
```

#### Only Options Trades
```bash
bun src/cli/index.ts fetch-trades BTC --kind option
```

#### Only Delivery Prices
```bash
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd
```

---

## Analytics Pipeline

After fetching trades and delivery prices, convert JSONL data to analytics-ready Parquet files.

### Why Parquet?

The two-layer architecture provides:
- **JSONL (source)**: Crash-safe, human-readable, resumable downloads
- **Parquet (analytics)**: 10-100x faster queries, ~10x compression, enriched with Greeks

### When to Run Merge

Run `merge-to-parquet` after:
1. ✅ Fetching trades (`fetch-trades` or `fetch-all`)
2. ✅ Fetching delivery prices (`fetch-deliveries` or `fetch-all`)

### Basic Workflow

```bash
# Step 1: Fetch all data
bun src/cli/index.ts fetch-all BTC

# Step 2: Convert to analytics-ready Parquet
bun src/cli/index.ts merge-to-parquet BTC
```

### Merge Recent Options Only

For iterative analysis, merge only recent expirations:

```bash
# Last 3 months
bun src/cli/index.ts merge-to-parquet BTC --min-expiration 3m

# Last 6 months
bun src/cli/index.ts merge-to-parquet BTC --min-expiration 6m

# Specific date range
bun src/cli/index.ts merge-to-parquet BTC \
  --min-expiration 2024-01-01 \
  --max-expiration 2024-12-31
```

### What Gets Enriched

Each trade in the Parquet files includes:

**Original Trade Data:**
- Price, amount, direction, timestamp
- Index price, mark price, implied volatility

**Computed Greeks (Black-76):**
- Delta, gamma, vega, theta
- Theoretical price

**Moneyness (at expiration):**
- Delivery price
- Moneyness classification (ITM/ATM/OTM)
- Intrinsic value
- Moneyness percentage

### Performance Expectations

| Dataset | Instruments | Trades | Time | Output Size |
|---------|-------------|--------|------|-------------|
| BTC (1 month) | ~1,400 | 1.2M | ~45s | ~150 MB |
| BTC (3 months) | ~4,000 | 3.5M | ~2 min | ~400 MB |
| BTC (1 year) | ~15,000 | 12M | ~8 min | ~1.2 GB |
| ETH (1 month) | ~1,200 | 800K | ~30s | ~100 MB |

*Assumes ~1500-2000 trades/second enrichment rate*

### Storage Requirements

Parquet files are ~10x smaller than JSONL:

```
JSONL: 2.5 GB  →  Parquet: ~250 MB  (90% reduction)
```

### Querying Parquet Files

Use DuckDB, Python (pandas/pyarrow), or any Parquet-compatible tool:

**DuckDB example:**
```sql
-- Top 10 most profitable ITM calls
SELECT instrument_name, delivery_price, strike,
       intrinsic_value, COUNT(*) as trades
FROM 'data/parquet/BTC/*.parquet'
WHERE moneyness = 'ITM' AND option_type = 'call'
GROUP BY instrument_name, delivery_price, strike, intrinsic_value
ORDER BY intrinsic_value DESC
LIMIT 10;
```

**Python example:**
```python
import pandas as pd

# Read all BTC options
df = pd.read_parquet('data/parquet/BTC/')

# Filter high delta calls
high_delta = df[(df['option_type'] == 'call') & (df['delta'] > 0.7)]

# Analyze by moneyness
print(high_delta.groupby('moneyness')['intrinsic_value'].describe())
```

---

## CLI Commands

### fetch-instruments

Fetch and store instrument metadata.

```bash
bun src/cli/index.ts fetch-instruments <CURRENCY> [OPTIONS]
```

**Arguments:**
- `CURRENCY` - Currency code (BTC, ETH, SOL)

**Options:**
- `--kind <type>` - Filter by type: option, future, spot
- `--expired` - Include expired instruments (default: true)

**Examples:**
```bash
# All BTC instruments
bun src/cli/index.ts fetch-instruments BTC

# Only BTC options
bun src/cli/index.ts fetch-instruments BTC --kind option

# Only active ETH futures
bun src/cli/index.ts fetch-instruments ETH --kind future --no-expired
```

### fetch-trades

Fetch historical trades using seq-based pagination.

```bash
bun src/cli/index.ts fetch-trades <CURRENCY> [OPTIONS]
```

**Arguments:**
- `CURRENCY` - Currency code (BTC, ETH, SOL)

**Options:**
- `--kind <type>` - Filter by: option, future (default: both)
- `--concurrency <n>` - Parallel fetches (default: 3)
- `--chunk-size <n>` - Chunk size in trades (default: 10000)

**Examples:**
```bash
# All BTC trades (futures + options)
bun src/cli/index.ts fetch-trades BTC

# Only futures with high concurrency
bun src/cli/index.ts fetch-trades BTC --kind future --concurrency 5

# Only options with smaller chunks
bun src/cli/index.ts fetch-trades BTC --kind option --chunk-size 5000
```

**Automatic Strategy Selection:**
- **Futures:** Chunk-based concurrent fetching
- **Options:** Streaming sequential fetching

### fetch-deliveries

Fetch historical settlement prices.

```bash
bun src/cli/index.ts fetch-deliveries <INDEX>... [OPTIONS]
```

**Arguments:**
- `INDEX` - One or more index names (btc_usd, eth_usd, sol_usd)

**Options:**
- `--concurrency <n>` - Parallel fetches (default: 2)
- `--batch-size <n>` - API batch size (default: 100)

**Examples:**
```bash
# Single index
bun src/cli/index.ts fetch-deliveries btc_usd

# Multiple indices
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd sol_usd

# Higher concurrency
bun src/cli/index.ts fetch-deliveries btc_usd --concurrency 4
```

### fetch-all

Run complete pipeline: instruments → trades → deliveries.

```bash
bun src/cli/index.ts fetch-all <CURRENCY> [OPTIONS]
```

**Arguments:**
- `CURRENCY` - Currency code (BTC, ETH, SOL)

**Options:**
- `--kind <type>` - Filter by: option, future (default: both)
- `--concurrency <n>` - Parallel fetches (default: 3)
- `--skip-deliveries` - Skip delivery price fetching

**Examples:**
```bash
# Complete BTC pipeline
bun src/cli/index.ts fetch-all BTC

# Only options with deliveries
bun src/cli/index.ts fetch-all BTC --kind option

# Futures only, skip deliveries
bun src/cli/index.ts fetch-all BTC --kind future --skip-deliveries
```

### stats

Show download statistics.

```bash
bun src/cli/index.ts stats [CURRENCY]
```

**Examples:**
```bash
# All currencies
bun src/cli/index.ts stats

# BTC only
bun src/cli/index.ts stats BTC
```

**Output:**
```
Currency: BTC
Instruments: 10,234
  - Futures: 12
  - Options: 10,222

Trades Downloaded:
  - BTC-PERPETUAL: 300,123,456 trades (45.2 GB)
  - BTC-27DEC24-60000-C: 5,234 trades (512 KB)
  - ...

Total: 305,456,789 trades (46.8 GB)

Delivery Prices: 1,234 records
Greeks Computed: 12,345 records
```

---

## Monitoring Progress

### Real-Time Progress

The CLI shows real-time progress during fetch:

```
Fetching BTC instruments...
✓ Found 10,234 instruments

Fetching futures...
  BTC-PERPETUAL: [████████░░] 80% (24,000/30,000 chunks) - 240M trades

Fetching options...
  BTC-27DEC24-60000-C: ✓ Complete (5,234 trades)
  BTC-27DEC24-60000-P: [███░░░] 50% (2,500 trades)
  ...

Progress: 8,234/10,234 instruments (80%)
```

### Database Queries

Check progress via SQL:

```bash
# Open database
bun:sqlite deribit-data.db

# Future chunks progress
SELECT
  instrument_name,
  COUNT(*) as total_chunks,
  SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as completed_chunks,
  SUM(trade_count) as total_trades
FROM future_chunks
GROUP BY instrument_name;

# Option progress
SELECT
  instrument_name,
  last_no,
  status,
  trade_count
FROM option_progress
WHERE status = 'in_progress';
```

### File System Monitoring

```bash
# Watch JSONL directory size
du -sh data/jsonl/BTC

# Count JSONL files
find data/jsonl/BTC -name "*.jsonl" | wc -l

# See largest files
du -sh data/jsonl/BTC/*.jsonl | sort -rh | head -10
```

---

## Resuming Downloads

The system automatically resumes from checkpoints on restart.

### How It Works

**Futures:**
- Incomplete chunks are re-fetched
- Completed chunks (is_done=1) are skipped

**Options:**
- Resumes from `last_no + 1`
- MAX guard prevents rollback

### Manual Resume

Just re-run the same command:

```bash
# Original command
bun src/cli/index.ts fetch-trades BTC

# [CRASH or CTRL+C]

# Resume (same command)
bun src/cli/index.ts fetch-trades BTC
```

Output:
```
Resuming BTC-PERPETUAL...
  Skipping 15,000 completed chunks
  Fetching 15,000 remaining chunks...
```

### Force Re-Download

To re-download from scratch:

```bash
# Delete checkpoints
rm deribit-data.db

# Delete JSONL files
rm -rf data/jsonl/BTC

# Fetch again
bun src/cli/index.ts fetch-trades BTC
```

---

## Performance Tuning

### Concurrency

Higher concurrency = faster downloads (up to a point).

```bash
# Low concurrency (conservative)
bun src/cli/index.ts fetch-trades BTC --concurrency 3

# High concurrency (aggressive)
bun src/cli/index.ts fetch-trades BTC --concurrency 10
```

**Recommendations:**
- **Futures:** 5-10 (benefits from parallelism)
- **Options:** 3-5 (most are small, I/O bound)

**Trade-offs:**
- Higher concurrency → faster but more API load
- Too high → rate limit errors, diminishing returns

### Chunk Size

Larger chunks = fewer API calls, but less granular resumability.

```bash
# Small chunks (more resumable)
bun src/cli/index.ts fetch-trades BTC --chunk-size 5000

# Large chunks (fewer API calls)
bun src/cli/index.ts fetch-trades BTC --chunk-size 20000
```

**Recommendations:**
- **Futures:** 10,000 (default, good balance)
- **Options:** 10,000 (most complete in 1 chunk anyway)

### Database Tuning

Edit `src/infrastructure/database.ts`:

```typescript
this.db.run("PRAGMA cache_size = -128000"); // 128MB cache (default: 64MB)
this.db.run("PRAGMA temp_store = MEMORY");   // Use memory for temp tables
```

### Network Optimization

**Use wired connection** if possible (more stable than WiFi)

**Monitor network:**
```bash
# Check bandwidth usage
nload

# Check connection stability
ping -c 100 history.deribit.com
```

---

## Troubleshooting

### Problem: Rate Limit Errors

**Symptoms:**
```
DeribitRateLimitError: Rate limit exceeded (HTTP 429)
```

**Solution:**
1. Reduce concurrency: `--concurrency 3`
2. Wait 60s and retry
3. System automatically retries with exponential backoff

### Problem: Slow Downloads

**Symptoms:** Fetching takes > 12 hours for BTC

**Diagnosis:**
```bash
# Check concurrency
# Should see multiple chunks fetching in parallel

# Check network
ping -c 10 history.deribit.com
```

**Solutions:**
- Increase concurrency: `--concurrency 10`
- Use wired connection
- Check system resources (CPU, disk I/O)

### Problem: Disk Space Full

**Symptoms:**
```
Error: ENOSPC: no space left on device
```

**Solution:**
```bash
# Check disk usage
df -h

# Clear old JSONL files (if re-downloading)
rm -rf data/jsonl/OLD_CURRENCY

# Compress old data
tar -czf btc-archive.tar.gz data/jsonl/BTC
rm -rf data/jsonl/BTC
```

### Problem: Database Locked

**Symptoms:**
```
Error: database is locked
```

**Solution:**
```bash
# Close other processes accessing the DB
lsof deribit-data.db

# If stuck, remove WAL files (safe if not writing)
rm deribit-data.db-wal deribit-data.db-shm
```

### Problem: Missing Trades (Gaps)

**Diagnosis:**
```typescript
// Check for gaps in JSONL
const trades = await storage.readTrades("BTC-PERPETUAL");
for (let i = 1; i < trades.length; i++) {
  if (trades[i].trade_seq !== trades[i-1].trade_seq + 1) {
    console.log(`Gap: ${trades[i-1].trade_seq} → ${trades[i].trade_seq}`);
  }
}
```

**Solution:**
- Re-download the instrument
- Check API availability (Deribit may have gaps)

### Problem: Validation Errors

**Symptoms:**
```
ZodError: Invalid API response
```

**Solution:**
- Check Deribit API status
- Update Zod schemas if API changed
- Report issue with response sample

---

## Maintenance

### Regular Tasks

**Weekly:**
- Check disk space: `df -h`
- Backup database: `cp deribit-data.db backups/deribit-data-$(date +%Y%m%d).db`

**Monthly:**
- Clean up old checkpoints
- Verify data integrity
- Update Bun: `bun upgrade`

### Data Validation

```bash
# Validate JSONL syntax
jq empty data/jsonl/BTC/BTC-PERPETUAL.jsonl

# Count trades
wc -l data/jsonl/BTC/*.jsonl

# Check for duplicates
jq -r '.trade_seq' data/jsonl/BTC/BTC-PERPETUAL.jsonl | sort | uniq -d
```

### Backup Strategy

**What to backup:**
- ✅ `deribit-data.db` (< 100 MB, critical)
- ✅ `data/jsonl/**/*.jsonl` (large, can regenerate)

**Backup script:**
```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
tar -czf backups/deribit-data-$DATE.tar.gz deribit-data.db data/jsonl
echo "Backup created: backups/deribit-data-$DATE.tar.gz"
```

### Log Rotation

CLI outputs to stdout. Redirect to log file:

```bash
bun src/cli/index.ts fetch-all BTC > logs/fetch-btc-$(date +%Y%m%d).log 2>&1
```

---

**Next:** [Development Guide →](development.md)
