#!/usr/bin/env bun

import { DeribitClient } from "../infrastructure/deribit-client.ts";
import { Database } from "../infrastructure/database.ts";
import { TradeFetcher } from "../application/fetchers/trade-fetcher.ts";
import { DeliveryFetcher } from "../application/fetchers/delivery-fetcher.ts";
import { GreeksCalculator } from "../application/analytics/greeks-calculator.ts";
import { RiskFilters, PresetFilters } from "../application/filters/risk-filters.ts";

const COMMANDS = ["fetch-trades", "fetch-deliveries", "compute-greeks", "apply-filters", "help"] as const;
type Command = typeof COMMANDS[number];

// Argument parsing utilities
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

      // Check if it's a boolean flag or has a value
      if (nextArg && !nextArg.startsWith("--")) {
        flags[flagName] = nextArg;
        i++; // Skip next arg since we consumed it
      } else {
        flags[flagName] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function parseDate(dateStr: string): number {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD or ISO8601`);
  }
  return date.getTime();
}

function isCurrencyCode(str: string): boolean {
  // Currency codes are 2-4 uppercase letters without hyphens
  return /^[A-Z]{2,4}$/.test(str);
}

function printHelp() {
  console.log(`
Deribit Historical Data Pipeline

Usage: bun src/cli/index.ts <command> [options]

Commands:

  fetch-trades <instrument-or-currency> [options]
    Fetch historical trades for one or more instruments

    Options:
      --months <n>           Lookback period in months (required if no dates)
      --start-date <date>    Start date (YYYY-MM-DD or ISO8601)
      --end-date <date>      End date (YYYY-MM-DD or ISO8601, default: now)
      --kind <type>          Filter by: option, future, or spot (currency only)
      --expired              Include expired instruments (currency only)
      --concurrency <n>      Parallel fetches (default: 3)
      --batch-size <n>       API batch size (default: 1000)
      --db-batch-size <n>    DB batch size (default: 5000)

    Examples:
      # Single perpetual future with 3-month lookback
      bun src/cli/index.ts fetch-trades BTC-PERPETUAL --months 3

      # Single option with specific date range
      bun src/cli/index.ts fetch-trades BTC-18AUG26-60000-C --start-date 2026-05-01 --end-date 2026-08-01

      # All BTC instruments (options and futures)
      bun src/cli/index.ts fetch-trades BTC --months 3

      # All BTC options only
      bun src/cli/index.ts fetch-trades BTC --months 3 --kind option

      # Faster parallel fetching for all instruments
      bun src/cli/index.ts fetch-trades BTC --months 6 --concurrency 5

  fetch-deliveries <index>... [options]
    Fetch delivery (settlement) prices for one or more indices

    Options:
      --start-date <date>    Start date filter (YYYY-MM-DD or ISO8601)
      --end-date <date>      End date filter (YYYY-MM-DD or ISO8601)
      --concurrency <n>      Parallel fetches (default: 2)
      --batch-size <n>       API batch size (default: 100)
      --db-batch-size <n>    DB batch size (default: 1000)

    Examples:
      # Single index (all history)
      bun src/cli/index.ts fetch-deliveries btc_usd

      # Filtered by date range
      bun src/cli/index.ts fetch-deliveries btc_usd --start-date 2024-01-01 --end-date 2024-12-31

      # Multiple indices
      bun src/cli/index.ts fetch-deliveries btc_usd eth_usd sol_usd

      # With concurrency
      bun src/cli/index.ts fetch-deliveries btc_usd eth_usd --concurrency 4

  compute-greeks [instrument] [options]
    Compute Black-76 greeks for option trades

    Options:
      --concurrency <n>      Parallel processing (default: 3)

    Examples:
      # Compute greeks for all option instruments
      bun src/cli/index.ts compute-greeks

      # Compute greeks for specific instrument
      bun src/cli/index.ts compute-greeks BTC-18AUG26-60000-C

      # Higher concurrency for faster processing
      bun src/cli/index.ts compute-greeks --concurrency 5

  apply-filters <instrument> <filter-preset>
    Apply risk filters to computed greeks
    Presets: btcConservative, btcAggressive, itmOnly, otmOnly, highDeltaCalls, lowThetaDecay

    Example:
      bun src/cli/index.ts apply-filters BTC-18AUG26-60000-C btcConservative

  help
    Show this help message
  `);
}

async function fetchTradesCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-trades <instrument-or-currency> [options]");
    console.error("Run 'bun src/cli/index.ts help' for more information");
    process.exit(1);
  }

  const target = parsed.positional[0]!;
  const isCurrency = isCurrencyCode(target);

  // Parse time range
  let startTimestamp: number;
  let endTimestamp: number;

  if (parsed.flags["start-date"]) {
    startTimestamp = parseDate(parsed.flags["start-date"] as string);
    endTimestamp = parsed.flags["end-date"]
      ? parseDate(parsed.flags["end-date"] as string)
      : Date.now();
  } else if (parsed.flags["months"]) {
    const months = parseInt(parsed.flags["months"] as string);
    if (isNaN(months) || months <= 0) {
      console.error("Error: --months must be a positive number");
      process.exit(1);
    }
    endTimestamp = Date.now();
    startTimestamp = endTimestamp - months * 30 * 24 * 60 * 60 * 1000;
  } else {
    console.error("Error: Must specify either --months or --start-date");
    process.exit(1);
  }

  // Parse optional flags
  const kind = parsed.flags["kind"] as "option" | "future" | "spot" | undefined;
  if (kind && !["option", "future", "spot"].includes(kind)) {
    console.error("Error: --kind must be one of: option, future, spot");
    process.exit(1);
  }

  const expired = parsed.flags["expired"] === true;
  const concurrency = parsed.flags["concurrency"]
    ? parseInt(parsed.flags["concurrency"] as string)
    : 3;
  const batchSize = parsed.flags["batch-size"]
    ? parseInt(parsed.flags["batch-size"] as string)
    : 1000;
  const dbBatchSize = parsed.flags["db-batch-size"]
    ? parseInt(parsed.flags["db-batch-size"] as string)
    : 5000;

  const client = new DeribitClient();
  const database = new Database();
  const fetcher = new TradeFetcher({
    client,
    database,
    batchSize,
    dbBatchSize,
  });

  try {
    if (isCurrency) {
      // Fetch all instruments for currency
      console.log(`Fetching ${target} instruments...`);
      const instruments = await client.getInstruments(target, kind, expired);
      const activeInstruments = instruments.filter((i) => i.is_active || expired);

      console.log(`Found ${activeInstruments.length} instruments`);
      console.log(
        `Fetching trades from ${new Date(startTimestamp).toISOString()} to ${new Date(endTimestamp).toISOString()}...\n`
      );

      let totalInstruments = 0;
      let totalTrades = 0;
      const overallStart = Date.now();

      // Process in batches with concurrency
      for (let i = 0; i < activeInstruments.length; i += concurrency) {
        const batch = activeInstruments.slice(i, i + concurrency);
        const instrumentNames = batch.map((inst) => inst.instrument_name);

        console.log(
          `\nProcessing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(activeInstruments.length / concurrency)}: ${instrumentNames.join(", ")}`
        );

        const results = await fetcher.fetchMultipleInstruments(
          instrumentNames,
          startTimestamp,
          endTimestamp,
          concurrency,
          (p) => {
            process.stdout.write(
              `\r  ${p.instrument}: ${p.totalTrades} trades, ${p.batchesProcessed} batches`
            );
          }
        );

        for (const result of results) {
          totalTrades += result.totalTrades;
          totalInstruments++;
          const duration = (result.endTime! - result.startTime) / 1000;
          console.log(
            `\n  ✓ ${result.instrument}: ${result.totalTrades} trades in ${duration.toFixed(2)}s`
          );
        }
      }

      const totalDuration = (Date.now() - overallStart) / 1000;
      console.log(`\n\n=== Summary ===`);
      console.log(`Instruments: ${totalInstruments}/${activeInstruments.length}`);
      console.log(`Total trades: ${totalTrades}`);
      console.log(`Duration: ${totalDuration.toFixed(2)}s`);
      console.log(`Avg per instrument: ${(totalDuration / totalInstruments).toFixed(2)}s`);
    } else {
      // Fetch single instrument
      console.log(
        `Fetching trades for ${target} from ${new Date(startTimestamp).toISOString()} to ${new Date(endTimestamp).toISOString()}...`
      );

      const progress = await fetcher.fetchTrades(
        target,
        startTimestamp,
        endTimestamp,
        (p) => {
          console.log(
            `Progress: ${p.totalTrades} trades fetched, ${p.batchesProcessed} batches processed`
          );
        }
      );

      console.log(`\nCompleted!`);
      console.log(`Total trades: ${progress.totalTrades}`);
      console.log(`Batches: ${progress.batchesProcessed}`);
      console.log(
        `Duration: ${((progress.endTime! - progress.startTime) / 1000).toFixed(2)}s`
      );
    }
  } finally {
    database.close();
  }
}

async function fetchDeliveriesCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: fetch-deliveries <index>... [options]");
    console.error("Examples: btc_usd, eth_usd, sol_usd");
    console.error("Run 'bun src/cli/index.ts help' for more information");
    process.exit(1);
  }

  const indices = parsed.positional;

  // Parse date range
  let startDate: number | undefined;
  let endDate: number | undefined;

  if (parsed.flags["start-date"]) {
    startDate = parseDate(parsed.flags["start-date"] as string);
  }

  if (parsed.flags["end-date"]) {
    endDate = parseDate(parsed.flags["end-date"] as string);
  }

  // Parse optional flags
  const concurrency = parsed.flags["concurrency"]
    ? parseInt(parsed.flags["concurrency"] as string)
    : 2;
  const batchSize = parsed.flags["batch-size"]
    ? parseInt(parsed.flags["batch-size"] as string)
    : 100;
  const dbBatchSize = parsed.flags["db-batch-size"]
    ? parseInt(parsed.flags["db-batch-size"] as string)
    : 1000;

  const client = new DeribitClient();
  const database = new Database();
  const fetcher = new DeliveryFetcher({
    client,
    database,
    batchSize,
    dbBatchSize,
  });

  try {
    const dateRangeMsg = startDate || endDate
      ? ` (${startDate ? new Date(startDate).toISOString().split('T')[0] : 'all'} to ${endDate ? new Date(endDate).toISOString().split('T')[0] : 'now'})`
      : ' (all history)';

    if (indices.length === 1) {
      // Single index
      const indexName = indices[0]!;
      console.log(`Fetching delivery prices for ${indexName}${dateRangeMsg}...`);

      const progress = await fetcher.fetchDeliveryPrices(indexName, startDate, endDate, (p) => {
        console.log(
          `Progress: ${p.totalRecords} delivery prices fetched, ${p.batchesProcessed} batches processed`
        );
      });

      console.log(`\nCompleted!`);
      console.log(`Total delivery prices: ${progress.totalRecords}`);
      console.log(`Batches: ${progress.batchesProcessed}`);
      console.log(
        `Duration: ${((progress.endTime! - progress.startTime) / 1000).toFixed(2)}s`
      );
    } else {
      // Multiple indices
      console.log(`Fetching delivery prices for ${indices.length} indices${dateRangeMsg}...\n`);
      const overallStart = Date.now();

      const results = await fetcher.fetchMultipleIndices(
        indices,
        startDate,
        endDate,
        concurrency,
        (p) => {
          console.log(
            `${p.indexName}: ${p.totalRecords} records, ${p.batchesProcessed} batches`
          );
        }
      );

      let totalRecords = 0;
      for (const result of results) {
        totalRecords += result.totalRecords;
        const duration = (result.endTime! - result.startTime) / 1000;
        console.log(
          `✓ ${result.indexName}: ${result.totalRecords} records in ${duration.toFixed(2)}s`
        );
      }

      const totalDuration = (Date.now() - overallStart) / 1000;
      console.log(`\n=== Summary ===`);
      console.log(`Indices: ${results.length}`);
      console.log(`Total records: ${totalRecords}`);
      console.log(`Duration: ${totalDuration.toFixed(2)}s`);
    }
  } finally {
    database.close();
  }
}

async function computeGreeksCommand(args: string[]) {
  const parsed = parseArgs(args);

  const database = new Database();
  const calculator = new GreeksCalculator({ database });

  try {
    // If specific instrument provided, compute for that one only
    if (parsed.positional.length > 0) {
      const instrument = parsed.positional[0]!;
      console.log(`Computing greeks for ${instrument}...`);

      const progress = await calculator.calculateForInstrument(
        instrument,
        undefined,
        undefined,
        (p) => {
          console.log(
            `Progress: ${p.totalCalculated} greeks calculated, ${p.batchesProcessed} batches processed`
          );
        }
      );

      console.log(`\nCompleted!`);
      console.log(`Total greeks calculated: ${progress.totalCalculated}`);
      console.log(`Batches: ${progress.batchesProcessed}`);
      console.log(
        `Duration: ${((progress.endTime! - progress.startTime) / 1000).toFixed(2)}s`
      );

      // Show summary
      const summary = calculator.getGreeksSummary(instrument);
      if (summary) {
        console.log(`\nGreeks Summary:`);
        console.log(
          `Delta: ${summary.delta.min.toFixed(4)} to ${summary.delta.max.toFixed(4)} (avg: ${summary.delta.avg.toFixed(4)})`
        );
        console.log(
          `Gamma: ${summary.gamma.min.toFixed(6)} to ${summary.gamma.max.toFixed(6)} (avg: ${summary.gamma.avg.toFixed(6)})`
        );
        console.log(
          `Vega: ${summary.vega.min.toFixed(4)} to ${summary.vega.max.toFixed(4)} (avg: ${summary.vega.avg.toFixed(4)})`
        );
        console.log(
          `Theta: ${summary.theta.min.toFixed(4)} to ${summary.theta.max.toFixed(4)} (avg: ${summary.theta.avg.toFixed(4)})`
        );
      }
    } else {
      // Compute for all instruments
      console.log(`Computing greeks for all instruments...`);

      const instruments = database.getDistinctInstruments();

      // Filter to only option instruments
      const optionInstruments = instruments.filter((name) => {
        const parts = name.split("-");
        return parts.length === 4; // BTC-DATE-STRIKE-TYPE format
      });

      if (optionInstruments.length === 0) {
        console.log("No option instruments found with trade data.");
        return;
      }

      console.log(`Found ${optionInstruments.length} option instruments\n`);

      const concurrency = parsed.flags["concurrency"]
        ? parseInt(parsed.flags["concurrency"] as string)
        : 3;

      let totalCalculated = 0;
      let successCount = 0;
      let failCount = 0;
      const startTime = Date.now();

      // Process in parallel batches
      for (let i = 0; i < optionInstruments.length; i += concurrency) {
        const batch = optionInstruments.slice(i, i + concurrency);

        const promises = batch.map(async (instrument) => {
          try {
            console.log(
              `[${i + batch.indexOf(instrument) + 1}/${optionInstruments.length}] Processing ${instrument}...`
            );

            const progress = await calculator.calculateForInstrument(
              instrument,
              undefined,
              undefined
            );

            totalCalculated += progress.totalCalculated;
            successCount++;
            const duration = (progress.endTime! - progress.startTime) / 1000;
            console.log(
              `  ✓ ${instrument}: ${progress.totalCalculated} greeks in ${duration.toFixed(2)}s`
            );
          } catch (error) {
            failCount++;
            console.error(
              `  ✗ ${instrument}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        });

        await Promise.all(promises);
      }

      const totalDuration = (Date.now() - startTime) / 1000;
      console.log(`\n=== Summary ===`);
      console.log(`Instruments processed: ${successCount}/${optionInstruments.length}`);
      console.log(`Failed: ${failCount}`);
      console.log(`Total greeks calculated: ${totalCalculated}`);
      console.log(`Duration: ${totalDuration.toFixed(2)}s`);
      console.log(
        `Avg per instrument: ${(totalDuration / successCount).toFixed(2)}s`
      );
    }
  } finally {
    database.close();
  }
}

async function applyFiltersCommand(args: string[]) {
  if (args.length < 2) {
    console.error("Usage: apply-filters <instrument> <filter-preset>");
    console.error(
      "Available presets: btcConservative, btcAggressive, itmOnly, otmOnly, highDeltaCalls, lowThetaDecay"
    );
    process.exit(1);
  }

  const [instrument, presetName] = args;

  const filter = (PresetFilters as any)[presetName!];
  if (!filter) {
    console.error(`Unknown filter preset: ${presetName}`);
    console.error(
      "Available presets: btcConservative, btcAggressive, itmOnly, otmOnly, highDeltaCalls, lowThetaDecay"
    );
    process.exit(1);
  }

  console.log(`Applying ${filter.name} filter to ${instrument}...`);

  const database = new Database();
  const riskFilters = new RiskFilters({ database });

  try {
    const stats = riskFilters.getFilterStats(instrument!,filter);

    console.log(`\nFilter Results:`);
    console.log(`Total greeks: ${stats.total}`);
    console.log(`Passed: ${stats.passed}`);
    console.log(`Failed: ${stats.failed}`);
    console.log(`Pass rate: ${(stats.passRate * 100).toFixed(2)}%`);

    // Show some examples
    const results = riskFilters.filterInstrument(instrument!, filter);
    const failed = results.filter((r) => !r.passed).slice(0, 5);

    if (failed.length > 0) {
      console.log(`\nExample failures (first 5):`);
      for (const result of failed) {
        console.log(`  Timestamp: ${new Date(result.timestamp).toISOString()}`);
        console.log(`  Failed checks: ${result.failedChecks.join(", ")}`);
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
    case "fetch-trades":
      await fetchTradesCommand(commandArgs);
      break;
    case "fetch-deliveries":
      await fetchDeliveriesCommand(commandArgs);
      break;
    case "compute-greeks":
      await computeGreeksCommand(commandArgs);
      break;
    case "apply-filters":
      await applyFiltersCommand(commandArgs);
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
