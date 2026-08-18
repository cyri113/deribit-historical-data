# Deribit Historical Data Pipeline - Documentation

Welcome to the comprehensive documentation for the Deribit Historical Data Pipeline project.

## 📚 Documentation Index

### Getting Started
- **[Overview](overview.md)** - Project goals, use cases, and high-level workflow
- **[Operations Guide](operations.md)** - Installation, running commands, and troubleshooting

### Understanding the System
- **[Architecture](architecture.md)** - System design, layers, and data flow
- **[Design Decisions](design-decisions.md)** - Key architectural choices and trade-offs
- **[Data Model](data-model.md)** - Database schema, JSONL format, and relationships

### Technical Reference
- **[Deribit API Integration](deribit-api.md)** - API endpoints, rate limiting, and pagination
- **[API Reference](api-reference.md)** - CLI commands and TypeScript API documentation
- **[Development Guide](development.md)** - Setup, testing, and contributing

## 🚀 Quick Start

```bash
# Install dependencies
bun install

# Fetch instrument metadata
bun src/cli/index.ts fetch-instruments BTC

# Fetch historical trades
bun src/cli/index.ts fetch-trades BTC --concurrency 5

# Fetch delivery prices
bun src/cli/index.ts fetch-deliveries btc_usd

# Or run the complete pipeline
bun src/cli/index.ts fetch-all BTC
```

## 🎯 What This Project Does

The Deribit Historical Data Pipeline:
- Fetches complete historical trade data for cryptocurrency options and futures from Deribit
- Downloads delivery (settlement) prices for expired contracts
- Calculates Black-76 option Greeks (delta, gamma, vega, theta)
- Provides resumable, crash-safe downloads with checkpoint system
- Stores data in JSONL format for reliability and Parquet for analysis

## 🏗️ System Architecture at a Glance

```
┌─────────────────────┐
│  Deribit API        │
│  (history.deribit)  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  CLI Interface      │  ← bun src/cli/index.ts
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  Application Layer                      │
│  • FutureFetcher (chunked, concurrent)  │
│  • OptionFetcher (streaming, lazy)      │
│  • DeliveryFetcher (paginated)          │
└──────────┬──────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Infrastructure Layer                    │
│  • DeribitClient (API + rate limiting)   │
│  • JSONLStorage (crash-safe writes)      │
│  • Database (SQLite for checkpoints)     │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Storage                                 │
│  • data/jsonl/**/*.jsonl (trades)        │
│  • deribit-data.db (metadata + progress) │
└──────────────────────────────────────────┘
```

## 📖 Documentation Guide by Role

### For Operators/Users
1. Start with [Overview](overview.md) to understand what the system does
2. Follow [Operations Guide](operations.md) for setup and usage
3. Refer to [API Reference](api-reference.md) for command options

### For Developers
1. Read [Architecture](architecture.md) to understand the system design
2. Review [Design Decisions](design-decisions.md) for the "why" behind choices
3. Study [Data Model](data-model.md) for database and file formats
4. Check [Development Guide](development.md) for contributing

### For System Architects
1. [Design Decisions](design-decisions.md) - Understand trade-offs
2. [Architecture](architecture.md) - See the layered design
3. [Deribit API Integration](deribit-api.md) - API strategy and constraints

## 🔄 Architecture Highlights

The system uses sequence-based architecture for superior reliability and performance:

**Key features:**
- Deterministic pagination (no gaps or duplicates)
- 10-50x faster for large futures via concurrent chunk fetching
- Crash-safe JSONL storage
- Resumable at chunk-level granularity

## 🛠️ Technology Stack

- **Runtime:** Bun (fast TypeScript/JavaScript runtime)
- **Language:** TypeScript (strict mode)
- **Storage:** SQLite (metadata), JSONL (trades), Parquet (analysis)
- **API:** Deribit REST API (history.deribit.com)
- **Validation:** Zod (runtime schema validation)

## 📊 Data Flow Summary

```
1. fetch-instruments → instruments table (metadata)
2. fetch-trades → data/jsonl/**/*.jsonl (append-only)
3. fetch-deliveries → delivery_prices table
4. compute-greeks → greeks table
5. [Future] merge JSONL → Parquet (deduped, compressed)
```

## 🆘 Getting Help

- **Troubleshooting:** See [Operations Guide](operations.md#troubleshooting)
- **API Questions:** Check [API Reference](api-reference.md)
- **Contributing:** Read [Development Guide](development.md)
- **Issues:** Report bugs or request features via GitHub issues

## 📝 Maintenance

This documentation is maintained alongside the codebase. When making changes:
1. Update relevant documentation files
2. Run documentation hooks (see `.claude/hooks/`)
3. Keep examples up-to-date with actual command syntax

---

**Last Updated:** 2026-08-18
**Version:** 2.0 (seq-based architecture)
