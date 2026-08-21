# Operations Guide

Installation, running, monitoring, and troubleshooting.

## Installation

### Prerequisites
- Bun v1.0+
- Git
- ~20GB+ disk space (for typical historical analysis)

### Setup
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
bun --version

# Clone and install
git clone https://github.com/YOUR_USERNAME/deribit-historical-data.git
cd deribit-historical-data
bun install

# Verify
bun src/cli/index.ts help
bun test
```

---

## Quick Start

### Fetch Expired Instruments
```bash
# Fetch BTC options expired in last 3 months
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

# Fetch BTC futures and options from specific date range
bun src/cli/index.ts fetch-all BTC --min-expiration 2024-01-01 --max-expiration 2024-12-31

# Fetch all expired instruments (no filter)
bun src/cli/index.ts fetch-all BTC
```

Runs complete pipeline:
1. Fetch expired instruments → filter by expiration dates
2. Enqueue fetch jobs (BunQueue)
3. Download trades → write directly to Parquet
4. Fetch delivery prices
5. Fetch historical volatility

**Time:** Varies by date range (4,640 options from 3 months ~30-60 min)

### Fetch Specific Data
```bash
# Delivery prices
bun src/cli/index.ts fetch-deliveries btc_usd eth_usd

# Historical volatility
bun src/cli/index.ts fetch-volatility BTC ETH
```

**Note:** Legacy commands (`fetch-instruments`, `fetch-trades`, `convert-to-raw-parquet`, `merge-to-parquet`, `stats`) are deprecated. Use `fetch-all` instead.

---

## Analytics Pipeline

After fetching trades, enrich with Greeks and moneyness.

### DuckDB Enrichment (Recommended)

**10-100x faster** than TypeScript row-by-row.

```bash
# Step 1: Fetch data
bun src/cli/index.ts fetch-all BTC

# Step 2: Enrich with DuckDB SQL (vectorized, parallel)
bun src/cli/index.ts enrich-with-duckdb BTC
```

**Output:** `data/parquet-duckdb/BTC.parquet` (single file per currency)

**Performance:**
- **DuckDB Bulk:** ~944k trades/sec (single query processes ALL files at once)
- **DuckDB Per-file:** ~20-50k trades/sec (deprecated approach)
- **TypeScript:** ~1-2k trades/sec, 1 core, high memory (deprecated)

**Architecture:**
- Processes 3,478 input files in one vectorized SQL query
- 10-100x faster than per-file processing
- Standard data lakehouse pattern (single large file instead of many small files)

### Enriched Fields

Each trade includes:
- **Trade Data:** price, amount, direction, timestamp, IV
- **Greeks:** delta, gamma, vega, theta (Black-76)
- **Moneyness:** delivery_price, ITM/ATM/OTM, intrinsic_value
- **Metrics:** IV rank, annualized yield, expected value, Sharpe ratio

### Querying Parquet

**DuckDB:**
```sql
-- High delta OTM calls
SELECT instrument_name, AVG(delta), COUNT(*) as trades
FROM 'data/parquet-duckdb/BTC.parquet'
WHERE option_type = 'call' AND moneyness = 'OTM' AND delta > 0.3
GROUP BY instrument_name ORDER BY AVG(delta) DESC;

-- High IV rank opportunities (mean reversion)
SELECT instrument_name, AVG(iv_rank_52w), AVG(annualized_premium_yield), COUNT(*)
FROM 'data/parquet-duckdb/BTC.parquet'
WHERE iv_rank_52w > 80 AND annualized_premium_yield > 30
GROUP BY instrument_name ORDER BY AVG(annualized_premium_yield) DESC;
```

**Python:**
```python
import pandas as pd

df = pd.read_parquet('data/parquet-duckdb/BTC.parquet')

# High delta calls
high_delta = df[(df['option_type'] == 'call') & (df['delta'] > 0.7)]

# Premium selling strategy
premium_selling = df[
    (df['iv_rank_52w'] > 70) &          # High IV percentile
    (df['annualized_premium_yield'] > 40) &  # High yield
    (df['expected_value_btc'] > 0)      # Positive EV
]

print(f"Avg yield: {premium_selling['annualized_premium_yield'].mean():.1f}%")
print(f"Avg win prob: {premium_selling['win_probability'].mean():.1f}%")
```

---

## Job Queue Management

### BunQueue Dashboard

View job status, queue metrics, and monitor progress:

```bash
# Terminal 1: Start BunQueue server
bun src/cli/index.ts queue-dashboard

# Terminal 2: Open dashboard
bunx bunqueue-dashboard
```

Dashboard at `http://localhost:6790`:
- Live job queue status
- Job history and failures
- Retry management
- Performance metrics
- SQLite database inspector

### Queue Status

Quick queue overview from CLI:

```bash
bun src/cli/index.ts queue-status
```

Shows:
- Queue database location (`./data/queue.db`)
- Instructions for detailed status via BunQueue CLI

### Queue Storage

BunQueue persists jobs to SQLite:
- **Location:** `./data/queue.db`
- **Jobs tracked:** All fetch/enrichment workflows
- **Features:** Automatic retries (3 attempts), exponential backoff, failure tracking

**Backup:**
```bash
cp data/queue.db backups/queue-$(date +%Y%m%d).db
```

---

## Monitoring Progress

### Real-Time CLI Progress
```
📥 Fetching BTC instruments...
✓ Found 4,640 instruments

✓ Enqueued 0 futures + 4,640 options

▶️  Job fetch-option (123) started
✓ BTC-25DEC24-60000-C: 5,234 trades
✓ Job fetch-option (123) completed: {"instrumentName":"BTC-25DEC24-60000-C","totalTrades":5234}

✓ BTC-25DEC24-60000-C already complete (Parquet exists)  [idempotent skip]
```

### BunQueue Dashboard

Best way to monitor progress:

```bash
bun src/cli/index.ts queue-dashboard
# Open http://localhost:6790
```

Shows:
- Real-time job queue status
- Completed/failed/waiting jobs
- Job history with timestamps
- Retry attempts and failures

### File System
```bash
# Count completed instruments
find data/parquet-raw/BTC -name "*.parquet" | wc -l

# Check Parquet size
du -sh data/parquet-raw/BTC

# Largest files
du -sh data/parquet-raw/BTC/*.parquet | sort -rh | head -10
```

---

## Resuming Downloads

System is idempotent via filesystem checks.

**Idempotency:** Re-running same command skips instruments with existing Parquet files

### Resume Example
```bash
# Original command
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

# [CRASH or CTRL+C]

# Resume (same command)
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

Output:
✓ BTC-25DEC24-60000-C already complete (Parquet exists)  [skipped]
✓ BTC-25DEC24-60000-P already complete (Parquet exists)  [skipped]
📥 Fetching BTC-25DEC24-65000-C (3,421 trades)...  [new]
```

### Force Re-Download
```bash
# Delete specific instrument
rm data/parquet-raw/BTC/BTC-25DEC24-60000-C.parquet

# Delete all BTC data
rm -rf data/parquet-raw/BTC

# Re-run
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m
```

---

## Performance Tuning

### BunQueue Concurrency

Default: 3 parallel jobs (configured in `src/infrastructure/queue.ts`)

To change:
```typescript
// src/infrastructure/queue.ts
QueueManager.instance = new Bunqueue("deribit-data", {
  concurrency: 5,  // Increase to 5 parallel jobs
  // ...
});
```

**Trade-offs:**
- Higher concurrency = faster but more API load
- Too high = rate limit errors (15 req/s shared across all workers)
- 3 is recommended for 99% of instruments (<10k trades)

---

## Troubleshooting

### Rate Limit Errors

**Symptoms:** `DeribitRateLimitError: Rate limit exceeded (HTTP 429)`

**Solutions:**
1. Reduce concurrency: `--concurrency 3`
2. Wait 60s and retry
3. System auto-retries with exponential backoff

### Slow Downloads

**Symptoms:** Taking too long

**Solutions:**
- Increase BunQueue concurrency (edit `src/infrastructure/queue.ts`)
- Use wired connection (more stable than WiFi)
- Check system resources: `top`, `iotop`
- Check network: `ping -c 10 www.deribit.com`
- Monitor BunQueue dashboard to identify slow jobs

### Disk Space Full

**Symptoms:** `Error: ENOSPC: no space left on device`

**Solutions:**
```bash
df -h
rm -rf data/parquet-raw/OLD_CURRENCY
tar -czf btc-archive.tar.gz data/parquet-raw/BTC && rm -rf data/parquet-raw/BTC
```

### Queue Database Locked

**Symptoms:** `Error: database is locked` (for `data/queue.db`)

**Solutions:**
```bash
# Close other processes
lsof data/queue.db

# Remove WAL files (if safe)
rm data/queue.db-wal data/queue.db-shm

# Or delete and restart (loses job history, not data)
rm data/queue.db
```

### Missing Trades (Gaps)

**Diagnosis:**
```typescript
const trades = await parquetStorage.readTrades("BTC-25DEC24-60000-C");
for (let i = 1; i < trades.length; i++) {
  if (trades[i].trade_seq !== trades[i-1].trade_seq + 1) {
    console.log(`Gap: ${trades[i-1].trade_seq} → ${trades[i].trade_seq}`);
  }
}
```

**Solution:**
```bash
# Delete corrupted Parquet file
rm data/parquet-raw/BTC/BTC-25DEC24-60000-C.parquet

# Re-fetch (idempotent)
bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m
```

### Validation Errors

**Symptoms:** `ZodError: Invalid API response`

**Solutions:**
- Check Deribit API status
- Update Zod schemas if API changed
- Report issue with response sample

---

## Maintenance

### Regular Tasks

**Weekly:**
- Check disk: `df -h`
- Backup queue: `cp data/queue.db backups/queue-$(date +%Y%m%d).db`

**Monthly:**
- Verify data integrity
- Update Bun: `bun upgrade`

### Data Validation
```bash
# Count completed instruments
find data/parquet-raw/BTC -name "*.parquet" | wc -l

# Check for corrupted Parquet files
for f in data/parquet-raw/BTC/*.parquet; do
  parquet-tools cat "$f" > /dev/null 2>&1 || echo "Corrupted: $f"
done
```

### Backup
```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
tar -czf backups/deribit-data-$DATE.tar.gz data/parquet-raw data/parquet-duckdb data/queue.db
echo "Backup: backups/deribit-data-$DATE.tar.gz"
```

### Logging
```bash
bun src/cli/index.ts fetch-all BTC > logs/fetch-btc-$(date +%Y%m%d).log 2>&1
```

---

**Next:** [Development Guide →](development.md)
