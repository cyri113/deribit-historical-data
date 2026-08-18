# Project Overview

## Purpose

The Deribit Historical Data Pipeline is a production-grade TypeScript/Bun system designed to fetch, store, and analyze complete historical trade data from Deribit's cryptocurrency derivatives exchange. It provides researchers, traders, and quantitative analysts with reliable access to millions of historical trades for options and futures contracts.

## Problem Statement

Cryptocurrency options and futures data is essential for:
- Backtesting trading strategies
- Analyzing implied volatility patterns
- Studying market microstructure
- Validating pricing models
- Academic research on crypto derivatives

However, obtaining this data is challenging:
- **Volume:** Perpetual futures can have millions of trades (BTC-PERPETUAL has 300M+ trades)
- **API Constraints:** Rate limits (20 req/s), pagination complexity, no bulk exports
- **Reliability:** Network errors, crashes, API timeouts require resumable downloads
- **Data Quality:** Duplicates, gaps, and inconsistencies need handling

## Solution

This project solves these challenges with a robust, production-ready pipeline that:

### 1. **Resumable Downloads**
- Checkpoint-based progress tracking
- Automatic crash recovery
- No data loss on interruption
- Chunk-level granularity for futures (10k trades per chunk)

### 2. **High Performance**
- Concurrent chunk fetching for large futures (10-50x speedup)
- Streaming architecture for options (constant memory usage)
- Rate limiting with token bucket (15 req/s sustainable)
- Optimized SQLite and JSONL storage

### 3. **Data Integrity**
- Sequence-based pagination (deterministic, no gaps)
- Crash-safe append-only JSONL storage
- Deduplication at merge time
- Zod schema validation for API responses

### 4. **Complete Data Access**
- All historical instruments (expired and active)
- Trade-level data with implied volatility
- Delivery (settlement) prices
- Black-76 Greeks calculation

## Target Audience

### Quantitative Researchers
- Backtest options strategies using real historical data
- Study implied volatility surface evolution
- Analyze Greeks behavior near expiration

### Traders & Market Makers
- Validate pricing models against historical trades
- Understand market microstructure
- Analyze liquidity patterns

### Academic Researchers
- Study cryptocurrency derivatives markets
- Publish papers on options pricing
- Analyze market efficiency

### Data Scientists
- Train ML models on historical options data
- Feature engineering from Greeks and IV
- Market prediction and analysis

## Key Features

### Historical Data Fetching
- **Complete Coverage:** All available historical data from Deribit
- **Flexible Filtering:** By currency (BTC, ETH, SOL), instrument type (option/future), date ranges
- **Efficient Pagination:** Sequence-based for deterministic results

### Black-76 Option Pricing
- **From-Scratch Implementation:** No external pricing libraries
- **Accurate Greeks:** Delta, gamma, vega, theta calculations
- **Crypto-Optimized:** Zero risk-free rate assumption

### Moneyness Analysis
- **ITM/OTM Classification:** Using delivery prices vs strike
- **Expiration Analysis:** Determine option outcomes
- **Risk Filtering:** Apply Greek-based filters

### Storage & Performance
- **JSONL Format:** Human-readable, crash-safe, append-only
- **SQLite Metadata:** Fast checkpoint queries
- **Parquet Ready:** Convert to columnar format for analytics
- **Memory Efficient:** Stream processing, not loading entire datasets

## Use Cases

### 1. Options Strategy Backtesting
```
Workflow:
1. Fetch all BTC options for 2023-2024
2. Calculate Greeks at each trade
3. Apply strategy filters (e.g., delta > 0.3, theta < -10)
4. Analyze P&L using delivery prices
```

### 2. Implied Volatility Research
```
Workflow:
1. Fetch trades for specific expiration cycle
2. Extract IV from each trade
3. Build volatility surface over time
4. Compare with Black-76 theoretical values
```

### 3. Market Microstructure Analysis
```
Workflow:
1. Fetch high-frequency trade data for a contract
2. Analyze bid-ask spreads via price/mark_price
3. Study order flow around key events
4. Measure market impact
```

### 4. Greeks Evolution Study
```
Workflow:
1. Fetch option trades from 30 days before expiration
2. Compute Greeks at each trade timestamp
3. Plot delta/gamma decay over time
4. Validate against theoretical models
```

## System Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    User Initiates Fetch                     │
│         bun src/cli/index.ts fetch-all BTC                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                Step 1: Fetch Instruments                     │
│  • Get all BTC instruments (options + futures)              │
│  • Store metadata in instruments table                      │
│  • Determine last_seq for each instrument                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                Step 2: Fetch Trades                          │
│                                                              │
│  Futures (e.g., BTC-PERPETUAL):                             │
│  • Pre-allocate chunks (1 to last_seq)                      │
│  • Fetch chunks concurrently (5+ at once)                   │
│  • Write to data/jsonl/BTC/BTC-PERPETUAL.jsonl              │
│  • Mark chunks complete in future_chunks table              │
│                                                              │
│  Options (e.g., BTC-27DEC24-60000-C):                       │
│  • Stream from last_no + 1                                  │
│  • Fetch chunks lazily until no more trades                 │
│  • Write to data/jsonl/BTC/BTC-27DEC24-60000-C.jsonl        │
│  • Update progress in option_progress table                 │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Step 3: Fetch Delivery Prices                   │
│  • Get settlement prices for btc_usd index                  │
│  • Store in delivery_prices table                           │
│  • Used to determine ITM/OTM at expiration                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Step 4: Compute Greeks (Optional)               │
│  • Read trades with IV from JSONL                           │
│  • Apply Black-76 formulas                                  │
│  • Store Greeks in database                                 │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Step 5: Analysis Ready                          │
│  • JSONL files: source of truth                             │
│  • SQLite: quick metadata queries                           │
│  • Convert to Parquet for fast analytics                    │
└─────────────────────────────────────────────────────────────┘
```

## Performance Characteristics

### Throughput
- **Futures:** 50k-100k trades/minute (with concurrency=5)
- **Options:** 20k-30k trades/minute (streaming, sequential)
- **Deliveries:** ~1000 records/minute (API limited)

### Storage Requirements
- **BTC-PERPETUAL:** ~300M trades = ~50GB JSONL (~10GB Parquet)
- **Typical Option:** 1k-100k trades = 100KB-10MB JSONL
- **SQLite Metadata:** ~100MB for 10,000 instruments

### Time Estimates
- **All BTC futures history:** 2-6 hours (depending on concurrency)
- **Single expiration cycle (100 options):** 10-30 minutes
- **All ETH options (1000+ instruments):** 2-4 hours

## Success Metrics

The project is successful when users can:
1. ✅ Download complete historical data without manual intervention
2. ✅ Resume interrupted downloads seamlessly
3. ✅ Trust data integrity (no gaps, proper deduplication)
4. ✅ Analyze data efficiently (JSONL → Parquet pipeline)
5. ✅ Understand system behavior via clear documentation

## Limitations & Future Work

### Current Limitations
- No real-time streaming (historical only)
- Manual Parquet conversion step
- Limited to Deribit exchange
- No order book data (trades only)

### Planned Enhancements
- Automated Parquet merge with deduplication
- Gap detection and validation tools
- Support for order book snapshots
- Real-time data streaming
- Multi-exchange support

## Comparison with Alternatives

| Solution | Pros | Cons |
|----------|------|------|
| **This Project** | Open source, resumable, complete data, free | Requires technical setup |
| **Manual API Calls** | Full control | Error-prone, not resumable, slow |
| **Commercial Providers** | Managed service | Expensive ($500-5000/month), limited history |
| **Deribit UI Export** | Simple | Limited to 10k rows, no bulk export |

## Getting Started

Ready to use the system? Start with:
1. [Operations Guide](operations.md) for installation and usage
2. [API Reference](api-reference.md) for command options
3. [Development Guide](development.md) if contributing

---

**Next:** [Architecture →](architecture.md)
