#!/usr/bin/env bun

import { DeribitClient } from "../infrastructure/deribit-client.ts";
import { ParquetStorage } from "../infrastructure/parquet-storage.ts";
import { JSONLStorage } from "../infrastructure/jsonl-storage.ts"; // Still needed for stats on legacy JSONL files
import { FutureFetcher } from "../application/fetchers/future-fetcher.ts";
import { OptionFetcher } from "../application/fetchers/option-fetcher.ts";
import { DeliveryFetcher } from "../application/fetchers/delivery-fetcher.ts";
import { VolatilityFetcher } from "../application/fetchers/volatility-fetcher.ts";
import { ParquetMerger } from "../application/analytics/parquet-merger.ts";
import { ParquetConverter } from "../application/converters/parquet-converter.ts";
import cliProgress from "cli-progress";
import Table from "cli-table3";

const COMMANDS = ["bronze", "silver", "pipeline", "fetch-instruments", "fetch-trades", "fetch-deliveries", "fetch-volatility", "fetch-all", "convert-to-raw-parquet", "merge-to-parquet", "enrich-with-duckdb", "stats", "queue-worker", "queue-status", "queue-dashboard", "help"] as const;
type Command = typeof COMMANDS[number];

// Argument parsing
interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg.startsWith("--")) {
      const flagName = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith("--")) {
        flags[flagName] = nextArg;
        i++;
      } else {
        flags[flagName] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

/**
 * Parse date string to Unix timestamp (milliseconds)
 * Supports:
 * - Relative: "3m" (3 months ago), "6m", "1y"
 * - Absolute: "2024-01-01" (ISO date)
 */
function parseDate(dateStr: string): number {
  // Relative date format: <number><unit>
  const relativeMatch = dateStr.match(/^(\d+)([mdy])$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]!);
    const unit = relativeMatch[2]!;

    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    switch (unit) {
      case 'd': // days
        return now - (amount * msPerDay);
      case 'm': // months (approximate as 30 days)
        return now - (amount * 30 * msPerDay);
      case 'y': // years (approximate as 365 days)
        return now - (amount * 365 * msPerDay);
      default:
        throw new Error(`Invalid date unit: ${unit}`);
    }
  }

  // Absolute date format: ISO date string
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) {
    throw new Error(`Invalid date format: ${dateStr}. Use ISO date (2024-01-01) or relative (3m, 6m, 1y)`);
  }

  return timestamp;
}

function printHelp() {
  console.log(`
Deribit Historical Data Fetcher (Medallion Architecture)

Usage: bun src/cli/index.ts <command> [options]

Commands (Medallion Architecture):

  bronze <currency> [options]
    Fetch raw data from Deribit API (Bronze layer)
    Fetches: instruments, trades, futures, deliveries, volatility

    Options:
      --kind <type>           Filter by: option, future (default: both)
      --concurrency <n>       Parallel fetches (default: 3)
      --skip-deliveries       Skip delivery price fetching
      --skip-volatility       Skip historical volatility fetching
      --min-expiration <date> Only fetch options expiring after date (e.g., 3m, 6m, 2024-01-01)
      --max-expiration <date> Only fetch options expiring before date

    Examples:
      bun src/cli/index.ts bronze BTC --kind option --min-expiration 3m
      bun src/cli/index.ts bronze ETH --concurrency 5

  silver <currency> [options]
    Enrich bronze data with Greeks (Silver layer)
    Uses DuckDB vectorized SQL (10-100x faster than TypeScript)

    Options:
      --input-dir <path>      Input directory for bronze Parquet (default: ./data/bronze)
      --output-dir <path>     Output directory for silver Parquet (default: ./data/silver)
      --max-memory <size>     DuckDB memory limit (default: 4GB)
      --threads <n>           Number of threads (default: CPU cores)

    Examples:
      bun src/cli/index.ts silver BTC
      bun src/cli/index.ts silver ETH --max-memory 8GB --threads 8

  pipeline <currency> [options]
    Run complete pipeline: bronze → silver (end-to-end)

    Options:
      Same as bronze command

    Examples:
      bun src/cli/index.ts pipeline BTC --kind option --min-expiration 3m
      bun src/cli/index.ts pipeline ETH

Queue Management:

  queue-worker
    Start queue worker to process jobs in background

  queue-status
    Show status of all jobs in the queue

  queue-dashboard
    Start web dashboard at http://localhost:6790

Legacy Commands (deprecated, use bronze/silver/pipeline instead):

  fetch-instruments <currency> [--kind <type>] [--expired]
    Fetch and store instrument metadata from Deribit

    Options:
      --kind <type>    Filter by: option, future, spot
      --expired        Include expired instruments (default: true)

    Examples:
      bun src/cli/index.ts fetch-instruments BTC
      bun src/cli/index.ts fetch-instruments BTC --kind option
      bun src/cli/index.ts fetch-instruments ETH --kind future

  fetch-trades <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>]
    Fetch trades using seq-based pagination
    Auto-detects futures (concurrent chunks) vs options (streaming)

    Options:
      --kind <type>           Filter by: option, future (default: both)
      --concurrency <n>       Parallel fetches (default: 3)
      --chunk-size <n>        Chunk size (default: 10000)
      --min-expiration <date> Only fetch options expiring after date (e.g., 3m, 6m, 2024-01-01)
      --max-expiration <date> Only fetch options expiring before date
      --max-seq <n>           Skip instruments with more than N trades (default: no limit)

    Date formats:
      Relative: 3d (3 days ago), 3m (3 months ago), 1y (1 year ago)
      Absolute: 2024-01-01, 2024-06-15

    Examples:
      bun src/cli/index.ts fetch-trades BTC
      bun src/cli/index.ts fetch-trades BTC --kind future --concurrency 5
      bun src/cli/index.ts fetch-trades BTC --kind option --min-expiration 3m
      bun src/cli/index.ts fetch-trades BTC --max-seq 10000000

  fetch-deliveries <index>... [--start-date <date>] [--end-date <date>]
    Fetch delivery (settlement) prices

    Examples:
      bun src/cli/index.ts fetch-deliveries btc_usd
      bun src/cli/index.ts fetch-deliveries btc_usd eth_usd

  fetch-volatility <currency>...
    Fetch historical volatility data

    Examples:
      bun src/cli/index.ts fetch-volatility BTC
      bun src/cli/index.ts fetch-volatility BTC ETH

  fetch-all <currency> [options]
    Complete pipeline: instruments → trades → deliveries → volatility

    Options:
      --kind <type>           Filter by: option, future (default: both)
      --concurrency <n>       Parallel fetches (default: 3)
      --skip-deliveries       Skip delivery price fetching
      --skip-volatility       Skip historical volatility fetching
      --min-expiration <date> Only fetch options expiring after date (e.g., 3m, 6m, 2024-01-01)
      --max-expiration <date> Only fetch options expiring before date
      --use-queue             Use BunQueue for async, retryable execution

    Examples:
      bun src/cli/index.ts fetch-all BTC
      bun src/cli/index.ts fetch-all BTC --use-queue  # Queue mode
      bun src/cli/index.ts fetch-all ETH --kind option --concurrency 5
      bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m

  convert-to-raw-parquet <currency>
    Convert JSONL to raw Parquet (Silver layer - no enrichment)
    Stage 2 of medallion architecture: Bronze → Silver

    Options:
      --output-dir <path>     Output directory for raw Parquet files (default: ./data/bronze)

    Examples:
      bun src/cli/index.ts convert-to-raw-parquet BTC
      bun src/cli/index.ts convert-to-raw-parquet ETH --output-dir ./output/silver

  merge-to-parquet <currency> [--min-expiration <date>] [--max-expiration <date>]
    Convert JSONL trades to enriched Parquet files (Gold layer)
    Computes Greeks, moneyness, and merges with delivery prices

    Options:
      --min-expiration <date> Only merge options expiring after date (e.g., 3m, 6m, 2024-01-01)
      --max-expiration <date> Only merge options expiring before date
      --output-dir <path>     Output directory for Parquet files (default: ./data/parquet)

    Date formats:
      Relative: 3d (3 days ago), 3m (3 months ago), 1y (1 year ago)
      Absolute: 2024-01-01, 2024-06-15

    Examples:
      bun src/cli/index.ts merge-to-parquet BTC
      bun src/cli/index.ts merge-to-parquet BTC --min-expiration 3m
      bun src/cli/index.ts merge-to-parquet ETH --min-expiration 2024-01-01 --max-expiration 2024-12-31

  enrich-with-duckdb <currency>
    Enqueue enrichment job to add Greeks to raw Parquet files using DuckDB
    10-100x faster than TypeScript, retryable via BunQueue

    Options:
      --input-dir <path>      Input directory for bronze Parquet (default: ./data/bronze)
      --output-dir <path>     Output directory for silver Parquet (default: ./data/silver)
      --max-memory <size>     DuckDB memory limit (default: 4GB)
      --threads <n>           Number of threads (default: CPU cores)

    Examples:
      bun src/cli/index.ts enrich-with-duckdb BTC
      bun src/cli/index.ts enrich-with-duckdb BTC --max-memory 8GB --threads 8
      bun src/cli/index.ts enrich-with-duckdb ETH --output-dir ./data/enriched
      bun src/cli/index.ts queue-dashboard  # Monitor progress

  stats [currency]
    Show download statistics

    Examples:
      bun src/cli/index.ts stats
      bun src/cli/index.ts stats BTC

  queue-worker
    Start queue worker to process jobs in background

    Examples:
      bun src/cli/index.ts queue-worker

  queue-status
    Show status of all jobs in the queue

    Examples:
      bun src/cli/index.ts queue-status

  queue-dashboard
    Start BunQueue server (required for dashboard)
    Then open dashboard with: bunx bunqueue-dashboard

    Examples:
      bun src/cli/index.ts queue-dashboard
      # In another terminal: bunx bunqueue-dashboard

  help
    Show this help message
  `);
}

async function fetchInstrumentsCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-instruments <currency> [--kind <type>] [--expired] [--min-expiration <date>] [--max-expiration <date>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kind = parsed.flags["kind"] as "option" | "future" | "spot" | undefined;
  const expired = parsed.flags["expired"] !== false; // Default true

  // Parse expiration date filters
  let minExpiration: number | undefined;
  let maxExpiration: number | undefined;

  if (parsed.flags["min-expiration"]) {
    try {
      minExpiration = parseDate(parsed.flags["min-expiration"] as string);
    } catch (error) {
      console.error(`Error parsing --min-expiration: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  if (parsed.flags["max-expiration"]) {
    try {
      maxExpiration = parseDate(parsed.flags["max-expiration"] as string);
    } catch (error) {
      console.error(`Error parsing --max-expiration: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  const client = new DeribitClient();
  const database = new Database();
  const storage = new ParquetStorage();

  try {
    console.log(`\nFetching ${currency} instruments from API...`);

    const apiStart = Date.now();
    let instruments = await client.getInstruments(currency, kind, expired);
    const apiDuration = ((Date.now() - apiStart) / 1000).toFixed(1);

    console.log(`✓ Found ${instruments.length} instruments (${apiDuration}s)\n`);

    // Filter by expiration date if provided
    if (minExpiration !== undefined || maxExpiration !== undefined) {
      const beforeFilter = instruments.length;

      instruments = instruments.filter((inst) => {
        // Only filter instruments with expiration timestamps (options, futures)
        if (!inst.expiration_timestamp) {
          return true; // Keep perpetuals/spot
        }

        if (minExpiration !== undefined && inst.expiration_timestamp < minExpiration) {
          return false;
        }

        if (maxExpiration !== undefined && inst.expiration_timestamp > maxExpiration) {
          return false;
        }

        return true;
      });

      const formatDate = (ts: number) => new Date(ts).toISOString().split('T')[0];
      console.log(`📅 Filtered by expiration date:`);
      if (minExpiration && maxExpiration) {
        console.log(`   ${formatDate(minExpiration)} to ${formatDate(maxExpiration)}`);
      } else if (minExpiration) {
        console.log(`   Expiring after ${formatDate(minExpiration)}`);
      } else if (maxExpiration) {
        console.log(`   Expiring before ${formatDate(maxExpiration!)}`);
      }
      console.log(`   ${beforeFilter} → ${instruments.length} instruments\n`);
    }

    console.log(`Writing instruments to storage...`);

    const writeStart = Date.now();

    // Write to Parquet file (archival/export format)
    await storage.writeInstruments(currency, instruments);

    // Clean up stale instruments from SQLite (remove instruments not in the latest fetch)
    const instrumentNames = instruments.map(i => i.instrument_name);
    const deletedCount = database.deleteInstrumentsNotIn(currency, kind, instrumentNames);
    if (deletedCount > 0) {
      console.log(`🧹 Cleaned up ${deletedCount} stale instruments from database`);
    }

    // Write new instruments to SQLite (for fast querying by fetchers)
    database.upsertInstruments(instruments.map(inst => ({
      instrument_name: inst.instrument_name,
      kind: inst.kind,
      base_currency: inst.base_currency,
      expiration_timestamp: inst.expiration_timestamp,
      strike: inst.strike,
      option_type: inst.option_type,
      is_active: inst.is_active,
      settlement_period: inst.settlement_period,
    })));

    const writeDuration = ((Date.now() - writeStart) / 1000).toFixed(1);

    console.log(`✓ Wrote ${instruments.length} instruments to Parquet and SQLite (${writeDuration}s)\n`);

    // Show breakdown
    const byKind: Record<string, number> = {};
    for (const inst of instruments) {
      byKind[inst.kind] = (byKind[inst.kind] || 0) + 1;
    }

    console.log("Breakdown:");
    for (const [kind, count] of Object.entries(byKind)) {
      console.log(`  ${kind}: ${count}`);
    }

    console.log(`\nNext: bun src/cli/index.ts fetch-trades ${currency}`);
  } finally {
    database.close();
  }
}

async function fetchTradesCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-trades <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>] [--max-expiration <date>] [--max-seq <n>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const chunkSize = parsed.flags["chunk-size"] ? parseInt(parsed.flags["chunk-size"] as string) : 10000;
  const maxSeq = parsed.flags["max-seq"] ? parseInt(parsed.flags["max-seq"] as string) : undefined;

  // Parse expiration date filters
  let minExpiration: number | undefined;
  let maxExpiration: number | undefined;

  if (parsed.flags["min-expiration"]) {
    try {
      minExpiration = parseDate(parsed.flags["min-expiration"] as string);
    } catch (error) {
      console.error(`Error parsing --min-expiration: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  if (parsed.flags["max-expiration"]) {
    try {
      maxExpiration = parseDate(parsed.flags["max-expiration"] as string);
    } catch (error) {
      console.error(`Error parsing --max-expiration: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  const client = new DeribitClient();
  const database = new Database();
  const jsonlStorage = new JSONLStorage();
  const parquetStorage = new ParquetStorage();

  try {
    const overallStart = Date.now();

    // Fetch futures
    if (!kindFilter || kindFilter === "future") {
      const futureFetcher = new FutureFetcher({
        client,
        database,
        jsonlStorage,
        parquetStorage,
        chunkSize,
        concurrency,
        maxSeq,
      });

      const futureResult = await futureFetcher.fetchAllFutures(currency);

      console.log(`\n✓ Futures: ${futureResult.totalTrades} trades from ${futureResult.fetched} instruments\n`);
    }

    // Fetch options
    if (!kindFilter || kindFilter === "option") {
      const optionFetcher = new OptionFetcher({
        client,
        database,
        jsonlStorage,
        parquetStorage,
        chunkSize,
        concurrency,
        maxSeq,
      });

      // Get instrument count upfront for progress bar
      // Note: Filtering by maxSeq happens inside fetchAllOptions() during preparation
      const instrumentNames = database.getIncompleteOptions(
        currency,
        minExpiration,
        maxExpiration
      );

      // Fetch options with simple logging (no progress bar)
      const optionResult = await optionFetcher.fetchAllOptions(currency, undefined, minExpiration, maxExpiration);
      console.log(`\n✓ Options: ${optionResult.totalTrades} trades from ${optionResult.fetched} instruments (${optionResult.completed} completed)\n`);
    }

    const duration = ((Date.now() - overallStart) / 1000).toFixed(2);
    console.log(`\n━━━ Fetch Complete ━━━`);
    console.log(`Duration: ${duration}s\n`);
  } finally {
    database.close();
    await jsonlStorage.closeAll();
  }
}

async function fetchDeliveriesCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-deliveries <index>... [--start-date <date>] [--end-date <date>]");
    process.exit(1);
  }

  const indices = parsed.positional;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 2;

  const client = new DeribitClient();
  const database = new Database();
  const storage = new ParquetStorage();
  const fetcher = new DeliveryFetcher({
    client,
    database,
    storage,
    batchSize: 100,
  });

  try {
    console.log(`\nFetching delivery prices for ${indices.length} indices...\n`);

    const results = await fetcher.fetchMultipleIndices(
      indices,
      undefined,
      undefined,
      concurrency,
      (progress) => {
        // Show progress updates as batches are processed
        const duration = ((Date.now() - progress.startTime) / 1000).toFixed(1);
        console.log(`  ${progress.indexName}: ${progress.totalRecords} records (${progress.batchesProcessed} batches) [${duration}s]`);
      }
    );

    const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

    console.log(`\n✓ Fetched ${totalRecords} delivery prices`);
  } finally {
    database.close();
  }
}

async function fetchVolatilityCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-volatility <currency>...");
    process.exit(1);
  }

  const currencies = parsed.positional.map(c => c.toUpperCase());
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 2;

  const client = new DeribitClient();
  const database = new Database();
  const storage = new ParquetStorage();
  const fetcher = new VolatilityFetcher({
    client,
    database,
    storage,
  });

  try {
    console.log(`\nFetching historical volatility for ${currencies.length} currencies...\n`);

    const results = await fetcher.fetchMultipleCurrencies(
      currencies,
      concurrency,
      (progress) => {
        const duration = ((Date.now() - progress.startTime) / 1000).toFixed(1);
        console.log(`  ${progress.currency}: ${progress.totalRecords} records [${duration}s]`);
      }
    );

    const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

    console.log(`\n✓ Fetched ${totalRecords} volatility records`);
  } finally {
    database.close();
  }
}

async function fetchAllCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-all <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>] [--max-expiration <date>] [--max-seq <n>] [--skip-deliveries] [--skip-volatility]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const skipDeliveries = parsed.flags["skip-deliveries"] === true;
  const skipVolatility = parsed.flags["skip-volatility"] === true;
  const minExpiration = parsed.flags["min-expiration"] as string | undefined;
  const maxExpiration = parsed.flags["max-expiration"] as string | undefined;
  const maxSeq = parsed.flags["max-seq"] as string | undefined;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Complete ${currency} Historical Data Fetch`);
  console.log(`  Mode: Queue (async, retryable)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const overallStart = Date.now();

  // Queue-based execution (only mode)
  {
    // Queue-based execution
    const { QueueManager } = await import("../infrastructure/queue.ts");
    const queue = QueueManager.getQueue();

    console.log(`📋 Enqueuing jobs...\n`);

    // Step 1: Fetch instruments (expired = true for historical data)
    const instrumentsJob = await queue.add("fetch-instruments", {
      currency,
      kind: kindFilter,
      expired: true,  // Fetch expired instruments for historical analysis
      minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
      maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
    });
    console.log(`✓ Enqueued: fetch-instruments (${instrumentsJob.id})`);

    // Step 2: Fetch trades (depends on instruments)
    const tradesJob = await queue.add("fetch-trades", {
      currency,
      kind: kindFilter,
      expired: true,  // Fetch expired instruments for historical analysis
      concurrency,
      minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
      maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
      maxSeq: maxSeq ? parseInt(maxSeq) : undefined,
    });
    console.log(`✓ Enqueued: fetch-trades (${tradesJob.id})`);

    // Step 2.5: Fetch dated futures (for forward prices in Greeks)
    const futuresJob = await queue.add("fetch-dated-futures", {
      currency,
      concurrency,
    });
    console.log(`✓ Enqueued: fetch-dated-futures (${futuresJob.id})`);

    // Step 3: Fetch deliveries
    if (!skipDeliveries) {
      const indexName = `${currency.toLowerCase()}_usd`;
      const deliveriesJob = await queue.add("fetch-deliveries", {
        indices: [indexName],
      });
      console.log(`✓ Enqueued: fetch-deliveries (${deliveriesJob.id})`);
    }

    // Step 4: Fetch volatility
    if (!skipVolatility) {
      const volatilityJob = await queue.add("fetch-volatility", {
        currencies: [currency],
      });
      console.log(`✓ Enqueued: fetch-volatility (${volatilityJob.id})`);
    }

    console.log(`\n✓ All jobs enqueued!`);
    console.log(`\nMonitor progress:`);
    console.log(`  bun src/cli/index.ts queue-dashboard`);
    console.log(`  bunx bunqueue-dashboard\n`);
  }
}

async function convertToRawParquetCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: convert-to-raw-parquet <currency> [--output-dir <path>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const outputDir = parsed.flags["output-dir"] as string | undefined;

  const database = new Database();
  const storage = new JSONLStorage();

  try {
    const converter = new ParquetConverter({
      database,
      jsonlStorage: storage,
      rawOutputDir: outputDir,
    });

    const result = await converter.convertAllInstruments(currency);

    console.log(`\n━━━ Conversion Summary ━━━`);
    console.log(`Total processed: ${result.total}`);
    console.log(`Converted: ${result.converted}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Total trades: ${result.totalTrades.toLocaleString()}\n`);
  } finally {
    database.close();
  }
}

async function mergeToParquetCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: merge-to-parquet <currency> [--min-expiration <date>] [--max-expiration <date>] [--output-dir <path>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const outputDir = parsed.flags["output-dir"] as string | undefined;

  // Parse date filters
  let minExpiration: number | undefined;
  let maxExpiration: number | undefined;

  if (parsed.flags["min-expiration"]) {
    try {
      minExpiration = parseDate(parsed.flags["min-expiration"] as string);
    } catch (error) {
      console.error(`Invalid --min-expiration: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (parsed.flags["max-expiration"]) {
    try {
      maxExpiration = parseDate(parsed.flags["max-expiration"] as string);
    } catch (error) {
      console.error(`Invalid --max-expiration: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const database = new Database();
  const storage = new JSONLStorage();

  try {
    const merger = new ParquetMerger({
      database,
      jsonlStorage: storage,
      outputDir,
    });

    await merger.mergeCurrency(
      currency,
      (progress) => {
        // Show progress updates every 1000 trades
        const duration = ((Date.now() - progress.startTime) / 1000).toFixed(1);
        console.log(`  ${progress.instrumentName}: ${progress.enrichedTrades}/${progress.totalTrades} trades [${duration}s]`);
      },
      minExpiration,
      maxExpiration
    );
  } finally {
    database.close();
  }
}

async function enrichWithDuckDBCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: enrich-with-duckdb <currency> [--input-dir <path>] [--output-dir <path>] [--max-memory <size>] [--threads <n>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const inputDir = parsed.flags["input-dir"] as string | undefined;
  const outputDir = parsed.flags["output-dir"] as string | undefined;
  const maxMemory = parsed.flags["max-memory"] as string | undefined;
  const threads = parsed.flags["threads"] ? parseInt(parsed.flags["threads"] as string) : undefined;

  console.log(`\n━━━ Enqueueing DuckDB Enrichment: ${currency} ━━━`);
  console.log(`Input:  ${inputDir ?? './data/bronze'}`);
  console.log(`Output: ${outputDir ?? './data/silver'}`);
  console.log(`Memory: ${maxMemory ?? '4GB'}`);
  console.log(`Threads: ${threads ?? 'auto'}\n`);

  // Enqueue enrichment job
  const { QueueManager } = await import("../infrastructure/queue.ts");
  const queue = QueueManager.getQueue();

  const job = await queue.add("enrich-duckdb", {
    currency,
    inputDir,
    outputDir,
    maxMemory,
    threads,
  });

  console.log(`✓ Enrichment job enqueued (ID: ${job.id})`);
  console.log(`\nMonitor progress:`);
  console.log(`  bun src/cli/index.ts queue-dashboard  # http://localhost:6790\n`);
}

async function pipelineCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: pipeline <currency> [options]");
    console.error("\nOptions: same as bronze command");
    console.error("\nExample: bun src/cli/index.ts pipeline BTC --kind option --min-expiration 3m");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();

  console.log(`\n━━━ Running Pipeline: ${currency} (Bronze → Silver) ━━━\n`);

  // Step 1: Bronze layer (fetch raw data)
  console.log(`📥 Step 1/2: Bronze layer (fetching raw data)...`);
  await fetchAllCommand(args);

  // Step 2: Silver layer (enrich with Greeks)
  console.log(`\n🧮 Step 2/2: Silver layer (enriching with Greeks)...`);
  await enrichWithDuckDBCommand([currency]);

  console.log(`\n━━━ Pipeline Complete ━━━`);
  console.log(`Bronze: data/bronze/instruments/${currency}/`);
  console.log(`Silver: data/silver/${currency}.parquet`);
  console.log(`\nMonitor jobs:`);
  console.log(`  bun src/cli/index.ts queue-dashboard  # http://localhost:6790\n`);
}

async function statsCommand(args: string[]) {
  const parsed = parseArgs(args);
  const currency = parsed.positional[0]?.toUpperCase();

  const database = new Database();
  const storage = new JSONLStorage();

  try {
    console.log(`\n━━━ Storage Statistics ━━━\n`);

    // Database stats
    const instruments = currency
      ? database.getInstruments(currency)
      : database.getInstruments("BTC").concat(database.getInstruments("ETH"));

    console.log(`Instruments: ${instruments.length}`);

    const futures = instruments.filter(i => i.kind === "future");
    const options = instruments.filter(i => i.kind === "option");

    console.log(`  Futures: ${futures.length}`);
    console.log(`  Options: ${options.length}\n`);

    // JSONL stats
    const jsonlStats = await storage.getStats();

    const totalSize = jsonlStats.reduce((sum, s) => sum + s.size, 0);
    const totalTrades = jsonlStats.reduce((sum, s) => sum + s.tradeCount, 0);

    console.log(`JSONL Files: ${jsonlStats.length}`);
    console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Total trades: ${totalTrades.toLocaleString()}\n`);

    if (jsonlStats.length > 0 && jsonlStats.length <= 20) {
      console.log(`Top files:`);
      const sorted = jsonlStats.sort((a, b) => b.size - a.size).slice(0, 10);
      for (const stat of sorted) {
        console.log(`  ${stat.instrument}: ${(stat.size / 1024).toFixed(1)} KB, ${stat.tradeCount} trades`);
      }
    }
  } finally {
    database.close();
  }
}

async function queueWorkerCommand() {
  console.log(`\n🔄 Starting BunQueue Worker...\n`);
  console.log(`Workers will process jobs from: ./data/queue.db`);
  console.log(`Concurrency: 3 (configured in QueueManager)`);
  console.log(`Retry: 3 attempts with exponential backoff\n`);
  console.log(`Listening for jobs... Press Ctrl+C to stop\n`);

  const { QueueManager } = await import("../infrastructure/queue.ts");
  const queue = QueueManager.getQueue();

  console.log(`✓ Queue initialized and workers started`);
  console.log(`✓ Ready to process jobs\n`);

  // Keep process alive to process jobs
  process.on('SIGINT', async () => {
    console.log(`\n\n🛑 Shutting down worker...`);
    await QueueManager.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log(`\n\n🛑 Received SIGTERM, shutting down...`);
    await QueueManager.close();
    process.exit(0);
  });

  // Keep process alive - BunQueue will process jobs in background
  // Using setInterval instead of Promise to keep event loop active
  const keepAlive = setInterval(() => {
    // Do nothing, just keep process alive
  }, 1000);

  // Wait forever
  await new Promise<never>(() => {});
}

async function queueStatusCommand() {
  console.log(`\n━━━ BunQueue Status ━━━\n`);
  console.log(`Queue database: ./data/queue.db`);
  console.log(`\nTo view detailed queue status, use the dashboard:`);
  console.log(`  bun src/cli/index.ts queue-dashboard\n`);
  console.log(`Or run BunQueue CLI directly:`);
  console.log(`  bunx bunqueue stats --data-path ./data/queue.db\n`);
}

async function queueDashboardCommand() {
  console.log(`\n🚀 Launching BunQueue Server...\n`);
  console.log(`Server will run on:`);
  console.log(`  TCP: localhost:6789`);
  console.log(`  HTTP: localhost:6790\n`);
  console.log(`Then open dashboard:`);
  console.log(`  bunx bunqueue-dashboard\n`);

  const proc = Bun.spawn(
    ["bunx", "bunqueue", "start", "--data-path", "./data/queue.db"],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }
  );

  await proc.exited;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0] as Command;
  const commandArgs = args.slice(1);

  switch (command) {
    case "fetch-instruments":
    case "fetch-trades":
    case "fetch-deliveries":
    case "fetch-volatility":
    case "convert-to-raw-parquet":
    case "merge-to-parquet":
    case "stats":
      console.error(`\n⚠️  Command "${command}" is deprecated (removed with SQLite database).`);
      console.error(`\nUse instead:`);
      console.error(`  bun src/cli/index.ts fetch-all <currency>\n`);
      process.exit(1);
      break;
    case "bronze":
      await fetchAllCommand(commandArgs);
      break;
    case "silver":
      await enrichWithDuckDBCommand(commandArgs);
      break;
    case "pipeline":
      await pipelineCommand(commandArgs);
      break;
    case "fetch-all":
      console.warn("\n⚠️  'fetch-all' is deprecated. Use 'bronze' instead.\n");
      await fetchAllCommand(commandArgs);
      break;
    case "enrich-with-duckdb":
      console.warn("\n⚠️  'enrich-with-duckdb' is deprecated. Use 'silver' instead.\n");
      await enrichWithDuckDBCommand(commandArgs);
      break;
    case "queue-worker":
      await queueWorkerCommand();
      break;
    case "queue-status":
      await queueStatusCommand();
      break;
    case "queue-dashboard":
      await queueDashboardCommand();
      break;
    case "help":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
