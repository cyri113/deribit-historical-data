#!/usr/bin/env bun

import { DeribitClient } from "../infrastructure/deribit-client.ts";
import { ParquetStorage } from "../infrastructure/parquet-storage.ts";

const COMMANDS = ["bronze", "silver", "gold", "pipeline", "queue-worker", "queue-status", "help"] as const;
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

      // Check if next arg exists and is not a flag
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

// Date parsing helper
function parseDate(dateStr: string): number {
  // Relative dates: 3d, 3m, 1y
  const relativeMatch = dateStr.match(/^(\d+)([dmy])$/);
  if (relativeMatch) {
    const [, amount, unit] = relativeMatch;
    const now = Date.now();
    const multiplier = unit === "d" ? 24 * 60 * 60 * 1000 : unit === "m" ? 30 * 24 * 60 * 60 * 1000 : 365 * 24 * 60 * 60 * 1000;
    return now - parseInt(amount!) * multiplier;
  }

  // Absolute dates: 2024-01-01
  return new Date(dateStr).getTime();
}

function printHelp() {
  console.log(`
Deribit Historical Data Pipeline

Usage: bun src/cli/index.ts <command> [args]

Commands:

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

  gold <currency> [options]
    Add trading metrics to silver data (Gold layer)
    Adds: strike_delta, days_to_expiry, vol_regime

    Options:
      --input-dir <path>      Input directory for silver Parquet (default: ./data/silver)
      --output-dir <path>     Output directory for gold Parquet (default: ./data/gold)
      --max-memory <size>     DuckDB memory limit (default: 4GB)
      --threads <n>           Number of threads (default: CPU cores)

    Examples:
      bun src/cli/index.ts gold BTC
      bun src/cli/index.ts gold ETH --max-memory 8GB

  pipeline <currency> [options]
    Run complete pipeline: bronze → silver → gold (end-to-end)

    Options:
      Same as bronze command

    Examples:
      bun src/cli/index.ts pipeline BTC --kind option --min-expiration 3m
      bun src/cli/index.ts pipeline ETH

Queue Management:

  queue-worker
    Start queue worker to process jobs in background

    Examples:
      bun src/cli/index.ts queue-worker

  queue-status
    Show status of all jobs in the queue

    Examples:
      bun src/cli/index.ts queue-status

  help
    Show this help message
  `);
}

async function bronzeCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: bronze <currency> [--kind <type>] [--concurrency <n>] [--min-expiration <date>] [--max-expiration <date>] [--skip-deliveries] [--skip-volatility]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const skipDeliveries = parsed.flags["skip-deliveries"] === true;
  const skipVolatility = parsed.flags["skip-volatility"] === true;
  const minExpiration = parsed.flags["min-expiration"] as string | undefined;
  const maxExpiration = parsed.flags["max-expiration"] as string | undefined;

  console.log(`\n━━━ Bronze Layer: ${currency} ━━━\n`);

  const { getQueue } = await import("../infrastructure/queue.ts");
  const queue = getQueue();

  console.log(`📋 Enqueuing jobs...\n`);

  // Step 1: Fetch instruments
  const instrumentsJob = await queue.add("fetch-instruments", {
    currency,
    kind: kindFilter,
    expired: true,
    minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
    maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
  });
  console.log(`✓ Enqueued: fetch-instruments (${instrumentsJob.id})`);

  // Step 2: Fetch trades
  const tradesJob = await queue.add("fetch-trades", {
    currency,
    kind: kindFilter,
    expired: true,
    concurrency,
    minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
    maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
  });
  console.log(`✓ Enqueued: fetch-trades (${tradesJob.id})`);

  // Step 3: Fetch dated futures (for forward prices)
  const futuresJob = await queue.add("fetch-dated-futures", {
    currency,
    concurrency,
  });
  console.log(`✓ Enqueued: fetch-dated-futures (${futuresJob.id})`);

  // Step 4: Fetch deliveries (optional)
  if (!skipDeliveries) {
    const indexName = `${currency.toLowerCase()}_usd`;
    const deliveriesJob = await queue.add("fetch-deliveries", {
      indices: [indexName],
    });
    console.log(`✓ Enqueued: fetch-deliveries (${deliveriesJob.id})`);
  }

  // Step 5: Fetch volatility (optional)
  if (!skipVolatility) {
    const volatilityJob = await queue.add("fetch-volatility", {
      currencies: [currency],
    });
    console.log(`✓ Enqueued: fetch-volatility (${volatilityJob.id})`);
  }

  console.log(`\n✓ All jobs enqueued!`);
  console.log(`\nMonitor progress:`);
  console.log(`  bun src/cli/index.ts queue-dashboard\n`);
}

async function silverCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: silver <currency> [--input-dir <path>] [--output-dir <path>] [--max-memory <size>] [--threads <n>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const inputDir = parsed.flags["input-dir"] as string | undefined;
  const outputDir = parsed.flags["output-dir"] as string | undefined;
  const maxMemory = parsed.flags["max-memory"] as string | undefined;
  const threads = parsed.flags["threads"] ? parseInt(parsed.flags["threads"] as string) : undefined;

  console.log(`\n━━━ Silver Layer: ${currency} ━━━\n`);

  const { getQueue } = await import("../infrastructure/queue.ts");
  const queue = getQueue();

  const job = await queue.add("enrich-duckdb", {
    currency,
    inputDir,
    outputDir,
    maxMemory,
    threads,
  });

  console.log(`✓ Enqueued: enrich-duckdb (${job.id})`);
  console.log(`\nMonitor progress:`);
  console.log(`  bun src/cli/index.ts queue-dashboard\n`);
}

async function goldCommand(args: string[]) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 1) {
    console.error("Usage: gold <currency> [--input-dir <path>] [--output-dir <path>] [--max-memory <size>] [--threads <n>]");
    process.exit(1);
  }

  const currency = parsed.positional[0]!.toUpperCase();
  const inputDir = parsed.flags["input-dir"] as string | undefined;
  const outputDir = parsed.flags["output-dir"] as string | undefined;
  const maxMemory = parsed.flags["max-memory"] as string | undefined;
  const threads = parsed.flags["threads"] ? parseInt(parsed.flags["threads"] as string) : undefined;

  console.log(`\n━━━ Gold Layer: ${currency} ━━━\n`);

  const { getQueue } = await import("../infrastructure/queue.ts");
  const queue = getQueue();

  const job = await queue.add("enrich-gold", {
    currency,
    inputDir,
    outputDir,
    maxMemory,
    threads,
  });

  console.log(`✓ Enqueued: enrich-gold (${job.id})`);
  console.log(`\nMonitor progress:`);
  console.log(`  bun src/cli/index.ts queue-dashboard\n`);
}

async function pipelineCommand(args: string[]) {
  const parsed = parseArgs(args);
  const currency = parsed.positional[0]!.toUpperCase();
  const kindFilter = parsed.flags["kind"] as "option" | "future" | undefined;
  const concurrency = parsed.flags["concurrency"] ? parseInt(parsed.flags["concurrency"] as string) : 3;
  const skipDeliveries = parsed.flags["skip-deliveries"] === true;
  const skipVolatility = parsed.flags["skip-volatility"] === true;
  const minExpiration = parsed.flags["min-expiration"] as string | undefined;
  const maxExpiration = parsed.flags["max-expiration"] as string | undefined;

  console.log(`\n━━━ Running Pipeline: ${currency} (Bronze → Silver → Gold) ━━━\n`);

  const { getQueue, getWorker } = await import("../infrastructure/queue.ts");
  const { FlowProducer } = await import("bunqueue/client");

  // Start worker first
  console.log(`Starting worker...\n`);
  const queue = getQueue();
  const worker = getWorker();

  const flow = new FlowProducer({ embedded: true, dataPath: "./data/queue.db" });

  console.log(`📋 Creating pipeline flow with job dependencies...\n`);

  // Bronze layer children (run in parallel)
  const bronzeChildren: any[] = [];

  bronzeChildren.push({
    name: "fetch-instruments",
    queueName: "deribit-data",
    data: {
      currency,
      kind: kindFilter,
      expired: true,
      minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
      maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
    },
  });

  bronzeChildren.push({
    name: "fetch-trades",
    queueName: "deribit-data",
    data: {
      currency,
      kind: kindFilter,
      expired: true,
      concurrency,
      minExpiration: minExpiration ? parseDate(minExpiration) : undefined,
      maxExpiration: maxExpiration ? parseDate(maxExpiration) : undefined,
    },
  });

  bronzeChildren.push({
    name: "fetch-dated-futures",
    queueName: "deribit-data",
    data: {
      currency,
      concurrency,
    },
  });

  if (!skipDeliveries) {
    bronzeChildren.push({
      name: "fetch-deliveries",
      queueName: "deribit-data",
      data: {
        indices: [`${currency.toLowerCase()}_usd`],
      },
    });
  }

  if (!skipVolatility) {
    bronzeChildren.push({
      name: "fetch-volatility",
      queueName: "deribit-data",
      data: {
        currencies: [currency],
      },
    });
  }

  // Create flow: Gold (parent) → Silver (parent) → Bronze children
  const pipelineFlow = await flow.add({
    name: "enrich-gold",
    queueName: "deribit-data",
    data: { currency },
    children: [
      {
        name: "enrich-duckdb",
        queueName: "deribit-data",
        data: { currency },
        children: bronzeChildren,
      },
    ],
  });

  console.log(`✓ Created pipeline flow with ${1 + 1 + bronzeChildren.length} jobs:`);
  console.log(`  Gold (${pipelineFlow.job.id})`);
  console.log(`    ↳ Silver (${pipelineFlow.children?.[0]?.job.id})`);
  for (const child of pipelineFlow.children?.[0]?.children || []) {
    console.log(`        ↳ Bronze: ${child.job.name} (${child.job.id})`);
  }

  await flow.close();

  console.log(`\n━━━ Processing jobs... ━━━\n`);

  // Keep process alive - worker will process jobs
  await new Promise(() => {}); // Never resolves
}

async function queueWorkerCommand() {
  const { getQueue, getWorker } = await import("../infrastructure/queue.ts");

  console.log("Starting BunQueue worker...");
  console.log("Press Ctrl+C to stop.\n");

  // Initialize queue and worker
  const queue = getQueue();
  const worker = getWorker();

  console.log("✓ Queue worker ready and processing jobs\n");

  // Keep the process alive
  await new Promise(() => {}); // Never resolves - keeps process running
}

async function queueStatusCommand() {
  const { getQueue } = await import("../infrastructure/queue.ts");
  const queue = getQueue();

  const counts = await queue.getJobCountsAsync();

  console.log("\n━━━ Queue Status ━━━\n");
  console.log(`Waiting:   ${counts.waiting || 0}`);
  console.log(`Active:    ${counts.active || 0}`);
  console.log(`Completed: ${counts.completed || 0}`);
  console.log(`Failed:    ${counts.failed || 0}`);
  console.log(`Delayed:   ${counts.delayed || 0}`);

  if (counts.waiting && counts.waiting > 0 && counts.active === 0) {
    console.log(`\n⚠️  Jobs are waiting but none are active. Start a worker:`);
    console.log(`   bun src/cli/index.ts queue-worker`);
  }
  console.log();
}


async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0] as Command;
  const commandArgs = args.slice(1);

  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  switch (command) {
    case "bronze":
      await bronzeCommand(commandArgs);
      break;
    case "silver":
      await silverCommand(commandArgs);
      break;
    case "gold":
      await goldCommand(commandArgs);
      break;
    case "pipeline":
      await pipelineCommand(commandArgs);
      break;
    case "queue-worker":
      await queueWorkerCommand();
      break;
    case "queue-status":
      await queueStatusCommand();
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
