#!/usr/bin/env bun

import { DeribitClient } from "../infrastructure/deribit-client.ts";
import { Database } from "../infrastructure/database.ts";
import { TradeFetcher } from "../application/fetchers/trade-fetcher.ts";
import { DeliveryFetcher } from "../application/fetchers/delivery-fetcher.ts";
import { GreeksCalculator } from "../application/analytics/greeks-calculator.ts";
import { RiskFilters, PresetFilters } from "../application/filters/risk-filters.ts";

const COMMANDS = ["fetch-trades", "fetch-deliveries", "compute-greeks", "apply-filters", "analyze-options", "export-historical", "help"] as const;
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

  analyze-options [instrument] [options]
    Show complete analysis with trades, greeks, and delivery price
    Demonstrates the associations: Instrument → Trades (1:many), Trade → Greeks (1:1),
    Instrument → DeliveryPrice (1:1)

    If no instrument specified, analyzes all option instruments in parallel.

    Options:
      --start-date <date>    Start date filter (YYYY-MM-DD or ISO8601)
      --end-date <date>      End date filter (YYYY-MM-DD or ISO8601)
      --concurrency <n>      Parallel processing (default: 3, for all instruments mode)

    Examples:
      # Single instrument with detailed output
      bun src/cli/index.ts analyze-options BTC-18AUG26-60000-C

      # All instruments with compact output
      bun src/cli/index.ts analyze-options

      # All instruments with higher concurrency
      bun src/cli/index.ts analyze-options --concurrency 5

  export-historical [underlying] [options]
    Export historical (expired) instruments with complete data
    Only includes instruments that have expired and have delivery prices

    Options:
      --format <type>        Output format: json or csv (default: json)
      --output <path>        Output file path (default: stdout)
      --before-date <date>   Only instruments expired before this date

    Examples:
      # Export all historical instruments to JSON
      bun src/cli/index.ts export-historical --output historical.json

      # Export BTC historical instruments to CSV
      bun src/cli/index.ts export-historical BTC --format csv --output btc-historical.csv

      # Export to stdout (pipe to other tools)
      bun src/cli/index.ts export-historical BTC | jq '.[] | select(.optionType == "call")'

      # Only instruments expired before a specific date
      bun src/cli/index.ts export-historical --before-date 2026-08-01 --output aug-expired.json

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

async function analyzeOptionsCommand(args: string[]) {
  const { positional, flags } = parseArgs(args);

  const startTimestamp = flags["start-date"] ? parseDate(flags["start-date"] as string) : undefined;
  const endTimestamp = flags["end-date"] ? parseDate(flags["end-date"] as string) : undefined;

  const database = new Database();

  try {
    // If specific instrument provided, analyze that one only with detailed output
    if (positional.length > 0) {
      const instrument = positional[0]!;
      console.log(`Analyzing ${instrument}...`);

      const analysis = database.getCompleteAnalysis(
        instrument,
        startTimestamp,
        endTimestamp
      );

      console.log(`\nInstrument: ${analysis.instrumentName}`);

      if (analysis.deliveryPrice) {
        console.log(`\nDelivery Price (at expiration):`);
        console.log(`  Date: ${new Date(analysis.deliveryPrice.date).toISOString()}`);
        console.log(`  Price: ${analysis.deliveryPrice.deliveryPrice}`);
      } else {
        console.log(`\nDelivery Price: Not available (non-option or not expired)`);
      }

      console.log(`\nTrades: ${analysis.trades.length}`);

      const tradesWithGreeks = analysis.trades.filter(t => t.greeks);
      console.log(`Trades with Greeks: ${tradesWithGreeks.length}`);

      if (analysis.trades.length > 0) {
        console.log(`\nSample Trades (first 5):`);

        for (const trade of analysis.trades.slice(0, 5)) {
          console.log(`\n  Trade ID: ${trade.id}`);
          console.log(`  Timestamp: ${new Date(trade.timestamp).toISOString()}`);
          console.log(`  Price: ${trade.price}`);
          console.log(`  Amount: ${trade.amount}`);
          console.log(`  Direction: ${trade.direction}`);
          console.log(`  Index Price: ${trade.indexPrice}`);

          if (trade.greeks) {
            console.log(`  Greeks:`);
            console.log(`    Delta: ${trade.greeks.delta.toFixed(4)}`);
            console.log(`    Gamma: ${trade.greeks.gamma.toFixed(6)}`);
            console.log(`    Vega: ${trade.greeks.vega.toFixed(4)}`);
            console.log(`    Theta: ${trade.greeks.theta.toFixed(4)}`);
          } else {
            console.log(`  Greeks: Not calculated`);
          }
        }
      }

      console.log(`\nSummary:`);
      console.log(`  Total trades: ${analysis.trades.length}`);
      console.log(`  Trades with greeks: ${tradesWithGreeks.length}`);
      console.log(`  Coverage: ${analysis.trades.length > 0 ? ((tradesWithGreeks.length / analysis.trades.length) * 100).toFixed(2) : 0}%`);
    } else {
      // Analyze all instruments with compact output
      console.log(`Analyzing all instruments...`);

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

      const concurrency = flags["concurrency"]
        ? parseInt(flags["concurrency"] as string)
        : 3;

      let totalTrades = 0;
      let totalTradesWithGreeks = 0;
      let totalInstrumentsWithDelivery = 0;
      let successCount = 0;
      let failCount = 0;
      const startTime = Date.now();

      // Process in parallel batches
      for (let i = 0; i < optionInstruments.length; i += concurrency) {
        const batch = optionInstruments.slice(i, i + concurrency);

        const promises = batch.map(async (instrument) => {
          try {
            const analysis = database.getCompleteAnalysis(
              instrument,
              startTimestamp,
              endTimestamp
            );

            const tradesWithGreeks = analysis.trades.filter(t => t.greeks);
            const coverage = analysis.trades.length > 0
              ? ((tradesWithGreeks.length / analysis.trades.length) * 100).toFixed(0)
              : 0;

            console.log(
              `[${i + batch.indexOf(instrument) + 1}/${optionInstruments.length}] ${instrument}: ${analysis.trades.length} trades, ${coverage}% greeks coverage${analysis.deliveryPrice ? ', has delivery' : ''}`
            );

            return {
              success: true,
              trades: analysis.trades.length,
              tradesWithGreeks: tradesWithGreeks.length,
              hasDelivery: analysis.deliveryPrice !== null,
            };
          } catch (error) {
            console.error(`[${i + batch.indexOf(instrument) + 1}/${optionInstruments.length}] ${instrument}: Error - ${error}`);
            return { success: false, trades: 0, tradesWithGreeks: 0, hasDelivery: false };
          }
        });

        const results = await Promise.all(promises);

        for (const result of results) {
          if (result.success) {
            successCount++;
            totalTrades += result.trades;
            totalTradesWithGreeks += result.tradesWithGreeks;
            if (result.hasDelivery) totalInstrumentsWithDelivery++;
          } else {
            failCount++;
          }
        }
      }

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);

      console.log(`\n=== Analysis Complete ===`);
      console.log(`Duration: ${duration}s`);
      console.log(`Instruments analyzed: ${successCount}`);
      console.log(`Instruments failed: ${failCount}`);
      console.log(`Total trades: ${totalTrades}`);
      console.log(`Trades with greeks: ${totalTradesWithGreeks}`);
      console.log(`Overall greeks coverage: ${totalTrades > 0 ? ((totalTradesWithGreeks / totalTrades) * 100).toFixed(2) : 0}%`);
      console.log(`Instruments with delivery prices: ${totalInstrumentsWithDelivery}`);
    }
  } finally {
    database.close();
  }
}

async function exportHistoricalCommand(args: string[]) {
  const { positional, flags } = parseArgs(args);

  const underlying = positional.length > 0 ? positional[0] : undefined;
  const format = flags["format"] ? (flags["format"] as string) : "json";
  const outputPath = flags["output"] ? (flags["output"] as string) : undefined;
  const beforeDate = flags["before-date"] ? parseDate(flags["before-date"] as string) : undefined;

  if (!["json", "csv"].includes(format)) {
    console.error(`Invalid format: ${format}. Supported formats: json, csv`);
    process.exit(1);
  }

  const database = new Database();

  try {
    console.log(`Fetching historical ${underlying || "all"} instruments...`);
    const startTime = Date.now();

    const data = database.getHistoricalInstrumentsWithData(underlying, beforeDate);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`\nFound ${data.length} expired instruments with complete data`);
    console.log(`Fetch time: ${duration}s`);

    if (data.length === 0) {
      console.log("\nNo historical data found. Make sure you have:");
      console.log("1. Fetched trades for expired instruments");
      console.log("2. Fetched delivery prices");
      console.log("3. Computed greeks");
      return;
    }

    // Calculate statistics
    const totalTrades = data.reduce((sum, inst) => sum + inst.trades.length, 0);
    const totalTradesWithGreeks = data.reduce(
      (sum, inst) => sum + inst.trades.filter((t) => t.greeks).length,
      0
    );
    const greeksCoverage = totalTrades > 0 ? ((totalTradesWithGreeks / totalTrades) * 100).toFixed(2) : "0.00";

    console.log(`\nStatistics:`);
    console.log(`  Total instruments: ${data.length}`);
    console.log(`  Total trades: ${totalTrades}`);
    console.log(`  Trades with greeks: ${totalTradesWithGreeks}`);
    console.log(`  Greeks coverage: ${greeksCoverage}%`);
    console.log(`  Date range: ${new Date(data[data.length - 1]!.expiration).toISOString()} to ${new Date(data[0]!.expiration).toISOString()}`);

    // Export data
    if (format === "json") {
      const jsonOutput = JSON.stringify(data, null, 2);

      if (outputPath) {
        await Bun.write(outputPath, jsonOutput);
        console.log(`\nExported to ${outputPath}`);
      } else {
        console.log("\n" + jsonOutput);
      }
    } else if (format === "csv") {
      // Flatten data for CSV export
      const csvRows: string[] = [];

      // Header
      csvRows.push([
        "instrument_name",
        "strike",
        "expiration",
        "option_type",
        "delivery_price",
        "moneyness",
        "trade_count",
        "greeks_coverage",
      ].join(","));

      // Data rows
      for (const inst of data) {
        const tradesWithGreeks = inst.trades.filter((t) => t.greeks).length;
        const coverage = inst.trades.length > 0
          ? ((tradesWithGreeks / inst.trades.length) * 100).toFixed(2)
          : "0.00";

        // Calculate moneyness
        const deliveryPrice = inst.deliveryPrice.deliveryPrice;
        const strike = inst.strike;
        let moneyness = "ATM";
        if (inst.optionType === "call") {
          moneyness = deliveryPrice > strike ? "ITM" : deliveryPrice < strike ? "OTM" : "ATM";
        } else {
          moneyness = deliveryPrice < strike ? "ITM" : deliveryPrice > strike ? "OTM" : "ATM";
        }

        csvRows.push([
          inst.instrumentName,
          inst.strike.toString(),
          new Date(inst.expiration).toISOString(),
          inst.optionType,
          inst.deliveryPrice.deliveryPrice.toString(),
          moneyness,
          inst.trades.length.toString(),
          coverage,
        ].join(","));
      }

      const csvOutput = csvRows.join("\n");

      if (outputPath) {
        await Bun.write(outputPath, csvOutput);
        console.log(`\nExported to ${outputPath}`);
      } else {
        console.log("\n" + csvOutput);
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
    case "analyze-options":
      await analyzeOptionsCommand(commandArgs);
      break;
    case "export-historical":
      await exportHistoricalCommand(commandArgs);
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
