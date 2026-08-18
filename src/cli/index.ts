#!/usr/bin/env bun

import { DeribitClient } from "../infrastructure/deribit-client.ts";
import { Database } from "../infrastructure/database.ts";
import { JSONLStorage } from "../infrastructure/jsonl-storage.ts";
import { FutureFetcher } from "../application/fetchers/future-fetcher.ts";
import { OptionFetcher } from "../application/fetchers/option-fetcher.ts";
import { DeliveryFetcher } from "../application/fetchers/delivery-fetcher.ts";

const COMMANDS = ["fetch-instruments", "fetch-trades", "fetch-deliveries", "fetch-all", "stats", "help"] as const;
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
Deribit Historical Data Fetcher (Seq-Based Architecture)

Usage: bun src/cli/index.ts <command> [options]

Commands:

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

    Date formats:
      Relative: 3d (3 days ago), 3m (3 months ago), 1y (1 year ago)
      Absolute: 2024-01-01, 2024-06-15

    Examples:
      bun src/cli/index.ts fetch-trades BTC
      bun src/cli/index.ts fetch-trades BTC --kind future --concurrency 5
      bun src/cli/index.ts fetch-trades BTC --kind option --min-expiration 3m
      bun src/cli/index.ts fetch-trades ETH --kind option --min-expiration 2024-01-01

  fetch-deliveries <index>... [--start-date <date>] [--end-date <date>]
    Fetch delivery (settlement) prices

    Examples:
      bun src/cli/index.ts fetch-deliveries btc_usd
      bun src/cli/index.ts fetch-deliveries btc_usd eth_usd

  fetch-all <currency> [options]
    Complete pipeline: instruments → trades → deliveries

    Options:
      --kind <type>           Filter by: option, future (default: both)
      --concurrency <n>       Parallel fetches (default: 3)
      --skip-deliveries       Skip delivery price fetching
      --min-expiration <date> Only fetch options expiring after date (e.g., 3m, 6m, 2024-01-01)
      --max-expiration <date> Only fetch options expiring before date

    Examples:
      bun src/cli/index.ts fetch-all BTC
      bun src/cli/index.ts fetch-all ETH --kind option --concurrency 5
      bun src/cli/index.ts fetch-all BTC --kind option --min-expiration 3m
      bun src/cli/index.ts fetch-all BTC --min-expiration 2024-06-01 --max-expiration 2024-08-31

  stats [currency]
    Show download statistics

    Examples:
      bun src/cli/index.ts stats
      bun src/cli/index.ts stats BTC

  help
    Show this help message
  `);
}

async function fetchInstrumentsCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-instruments <currency> [--kind <type>] [--expired]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kind = parsed.flags["kind"] as "option" | "future" | "spot" | undefined;
  const expired = parsed.flags["expired"] !== false; // Default true

  const client = new DeribitClient();
  const database = new Database();

  try {
    console.log(`\nFetching ${currency} instruments...`);

    const instruments = await client.getInstruments(currency, kind, expired);

    console.log(`✓ Found ${instruments.length} instruments`);

    // Store in database
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

    console.log(`✓ Stored ${instruments.length} instruments in database\n`);

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
    console.error("Usage: fetch-trades <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>] [--max-expiration <date>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const chunkSize = parsed.flags["chunk-size"] ? parseInt(parsed.flags["chunk-size"] as string) : 10000;

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
  const storage = new JSONLStorage();

  try {
    const overallStart = Date.now();

    // Fetch futures
    if (!kindFilter || kindFilter === "future") {
      const futureFetcher = new FutureFetcher({
        client,
        database,
        storage,
        chunkSize,
        concurrency,
      });

      const futureResult = await futureFetcher.fetchAllFutures(currency);

      console.log(`\n✓ Futures: ${futureResult.totalTrades} trades from ${futureResult.fetched} instruments\n`);
    }

    // Fetch options
    if (!kindFilter || kindFilter === "option") {
      const optionFetcher = new OptionFetcher({
        client,
        database,
        storage,
        chunkSize,
        concurrency,
      });

      const optionResult = await optionFetcher.fetchAllOptions(
        currency,
        undefined,
        minExpiration,
        maxExpiration
      );

      console.log(`\n✓ Options: ${optionResult.totalTrades} trades from ${optionResult.fetched} instruments (${optionResult.completed} completed)\n`);
    }

    const duration = ((Date.now() - overallStart) / 1000).toFixed(2);
    console.log(`\n━━━ Fetch Complete ━━━`);
    console.log(`Duration: ${duration}s\n`);
  } finally {
    await storage.closeAll();
    database.close();
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
  const fetcher = new DeliveryFetcher({
    client,
    database,
    batchSize: 100,
    dbBatchSize: 1000,
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

async function fetchAllCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-all <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>] [--max-expiration <date>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const skipDeliveries = parsed.flags["skip-deliveries"] === true;
  const minExpiration = parsed.flags["min-expiration"] as string | undefined;
  const maxExpiration = parsed.flags["max-expiration"] as string | undefined;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Complete ${currency} Historical Data Fetch`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const overallStart = Date.now();

  // Step 1: Fetch instruments
  console.log(`[1/3] Fetching instruments...`);
  await fetchInstrumentsCommand([currency, ...(kindFilter ? [`--kind`, kindFilter] : [])]);

  // Step 2: Fetch trades
  console.log(`\n[2/3] Fetching trades...`);
  const tradeArgs = [
    currency,
    ...(kindFilter ? [`--kind`, kindFilter] : []),
    `--concurrency`, String(concurrency),
    ...(minExpiration ? [`--min-expiration`, minExpiration] : []),
    ...(maxExpiration ? [`--max-expiration`, maxExpiration] : []),
  ];
  await fetchTradesCommand(tradeArgs);

  // Step 3: Fetch deliveries
  if (!skipDeliveries) {
    console.log(`\n[3/3] Fetching delivery prices...`);
    const indexName = `${currency.toLowerCase()}_usd`;
    await fetchDeliveriesCommand([indexName]);
  } else {
    console.log(`\n[3/3] Skipping delivery prices (--skip-deliveries)`);
  }

  const duration = ((Date.now() - overallStart) / 1000).toFixed(2);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ✅ Complete! Duration: ${duration}s`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
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
      await fetchInstrumentsCommand(commandArgs);
      break;
    case "fetch-trades":
      await fetchTradesCommand(commandArgs);
      break;
    case "fetch-deliveries":
      await fetchDeliveriesCommand(commandArgs);
      break;
    case "fetch-all":
      await fetchAllCommand(commandArgs);
      break;
    case "stats":
      await statsCommand(commandArgs);
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
