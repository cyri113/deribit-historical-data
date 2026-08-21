import { Queue, Worker } from "bunqueue/client";
import type { Job } from "bunqueue/client";
import { DeribitClient } from "./deribit-client.ts";
import { ParquetStorage } from "./parquet-storage.ts";
import { FutureFetcher } from "../application/fetchers/future-fetcher.ts";
import { OptionFetcher } from "../application/fetchers/option-fetcher.ts";
import { FuturesFetcher } from "../application/fetchers/futures-fetcher.ts";
import { DeliveryFetcher } from "../application/fetchers/delivery-fetcher.ts";
import { VolatilityFetcher } from "../application/fetchers/volatility-fetcher.ts";
import { DuckDBEnricher } from "../application/analytics/duckdb-enricher.ts";
import { GoldEnricher } from "../application/analytics/gold-enricher.ts";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Job Data Types
 */
export interface FetchInstrumentsJobData {
  currency: string;
  kind?: "option" | "future" | "spot";
  expired?: boolean;
  minExpiration?: number;
  maxExpiration?: number;
}

export interface FetchTradesJobData {
  currency: string;
  kind?: "option" | "future";
  expired?: boolean;
  concurrency?: number;
  chunkSize?: number;
  minExpiration?: number;
  maxExpiration?: number;
  maxSeq?: number;
}

export interface FetchFutureJobData {
  instrumentName: string;
}

export interface FetchOptionJobData {
  instrumentName: string;
}

export interface FetchDeliveriesJobData {
  indices: string[];
  startDate?: string;
  endDate?: string;
  concurrency?: number;
}

export interface FetchVolatilityJobData {
  currencies: string[];
  concurrency?: number;
}

export interface FetchDatedFuturesJobData {
  currency: string;
  concurrency?: number;
  // Note: Automatically scans option parquet files to determine which futures to fetch
}

export interface EnrichWithDuckDBJobData {
  currency: string;
  inputDir?: string;
  outputDir?: string;
  maxMemory?: string;
  threads?: number;
}

export interface EnrichGoldJobData {
  currency: string;
  inputDir?: string;
  outputDir?: string;
  maxMemory?: string;
  threads?: number;
}

/**
 * Shared dependencies for job handlers
 */
const deps = {
  client: new DeribitClient(),
  parquetStorage: new ParquetStorage(),
};

/**
 * Queue and Worker instances
 */
let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Get or create the queue instance
 */
export function getQueue(): Queue {
  if (!queue) {
    // Ensure data directory exists for queue database
    const queueDbPath = "./data/queue.db";
    const dataDir = dirname(queueDbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    queue = new Queue("deribit-data", {
      embedded: true,
      dataPath: queueDbPath,
    });
  }
  return queue;
}

/**
 * Get or create the worker instance
 */
export function getWorker(): Worker {
  if (!worker) {
    const queueDbPath = "./data/queue.db";

    worker = new Worker("deribit-data", async (job: Job) => {
      // Route to appropriate handler based on job name
      switch (job.name) {
        case "fetch-instruments": {
          const data = job.data as FetchInstrumentsJobData;
          const { currency, kind, expired, minExpiration, maxExpiration } = data;

          console.log(`\n📥 Fetching ${currency} instruments...`);
          const instruments = await deps.client.getInstruments(currency, kind, expired ?? false);

          // Apply expiration filters
          let filtered = instruments;
          if (minExpiration) {
            const minTs = typeof minExpiration === 'number' ? minExpiration : new Date(minExpiration).getTime();
            filtered = filtered.filter(i => i.expiration_timestamp && i.expiration_timestamp >= minTs);
          }
          if (maxExpiration) {
            const maxTs = typeof maxExpiration === 'number' ? maxExpiration : new Date(maxExpiration).getTime();
            filtered = filtered.filter(i => i.expiration_timestamp && i.expiration_timestamp <= maxTs);
          }

          console.log(`✓ Found ${filtered.length} instruments`);
          return { count: filtered.length, currency, kind, instruments: filtered };
        }

        case "fetch-trades": {
          const data = job.data as FetchTradesJobData;
          const { currency, kind, minExpiration, maxExpiration, expired, concurrency = 3 } = data;

          console.log(`\n📥 Fetching ${currency} instruments and downloading all trades...`);

          // Fetch instruments from API (with expired flag for historical data)
          let instruments = await deps.client.getInstruments(currency, kind, expired ?? true);

          // Filter to ONLY expired instruments (history API returns both expired and active)
          const now = Date.now();
          instruments = instruments.filter(i => i.expiration_timestamp && i.expiration_timestamp <= now);

          // Apply additional expiration date filters
          if (minExpiration) {
            const minTs = typeof minExpiration === 'number' ? minExpiration : new Date(minExpiration).getTime();
            instruments = instruments.filter(i => i.expiration_timestamp && i.expiration_timestamp >= minTs);
          }
          if (maxExpiration) {
            const maxTs = typeof maxExpiration === 'number' ? maxExpiration : new Date(maxExpiration).getTime();
            instruments = instruments.filter(i => i.expiration_timestamp && i.expiration_timestamp <= maxTs);
          }

          const futures = instruments.filter(i => i.kind === "future");
          const options = instruments.filter(i => i.kind === "option");

          console.log(`Found ${futures.length} futures + ${options.length} options to fetch`);

          // Fetch all instruments directly (not via child jobs)
          let totalTrades = 0;
          let completed = 0;
          let failed = 0;

          // Process in batches for concurrency
          const allInstruments = [...futures, ...options];
          for (let i = 0; i < allInstruments.length; i += concurrency) {
            const batch = allInstruments.slice(i, i + concurrency);

            await Promise.all(batch.map(async (instrument) => {
              try {
                if (instrument.kind === "future") {
                  const futureFetcher = new FutureFetcher({
                    client: deps.client,
                    parquetStorage: deps.parquetStorage,
                  });
                  const result = await futureFetcher.fetchInstrument(instrument.instrument_name);
                  totalTrades += result.totalTrades;
                } else {
                  const optionFetcher = new OptionFetcher({
                    client: deps.client,
                    parquetStorage: deps.parquetStorage,
                  });
                  const result = await optionFetcher.fetchInstrument(instrument.instrument_name);
                  totalTrades += result.totalTrades;
                }
                completed++;
              } catch (error) {
                failed++;
                console.error(`✗ Failed to fetch ${instrument.instrument_name}:`, error instanceof Error ? error.message : error);
              }

              const total = completed + failed;
              if (total % 100 === 0 || total === allInstruments.length) {
                console.log(`Progress: ${total}/${allInstruments.length} instruments (${completed} ok, ${failed} failed, ${totalTrades.toLocaleString()} trades)`);
              }
            }));
          }

          console.log(`✓ Downloaded ${completed}/${allInstruments.length} instruments (${failed} failed, ${totalTrades.toLocaleString()} trades)`);
          return { instrumentsDownloaded: completed, failed, totalTrades };
        }

        case "fetch-future": {
          const data = job.data as FetchFutureJobData;
          const { instrumentName } = data;

          const futureFetcher = new FutureFetcher({
            client: deps.client,
            parquetStorage: deps.parquetStorage,
          });

          const progress = await futureFetcher.fetchInstrument(instrumentName);
          console.log(`✓ ${instrumentName}: ${progress.totalTrades.toLocaleString()} trades`);

          return { instrumentName, totalTrades: progress.totalTrades };
        }

        case "fetch-option": {
          const data = job.data as FetchOptionJobData;
          const { instrumentName } = data;

          const optionFetcher = new OptionFetcher({
            client: deps.client,
            parquetStorage: deps.parquetStorage,
          });

          const progress = await optionFetcher.fetchInstrument(instrumentName);
          console.log(`✓ ${instrumentName}: ${progress.totalTrades.toLocaleString()} trades`);

          return { instrumentName, totalTrades: progress.totalTrades };
        }

        case "fetch-deliveries": {
          const data = job.data as FetchDeliveriesJobData;
          const { indices, startDate, endDate, concurrency = 3 } = data;

          console.log(`\n📥 Fetching delivery prices...`);

          const fetcher = new DeliveryFetcher({
            client: deps.client,
            storage: deps.parquetStorage,
          });

          const results = await fetcher.fetchMultipleIndices(
            indices,
            startDate ? new Date(startDate).getTime() : undefined,
            endDate ? new Date(endDate).getTime() : undefined,
            concurrency
          );
          const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

          console.log(`✓ Fetched ${totalRecords} delivery price records`);
          return { totalRecords, indices: indices.length };
        }

        case "fetch-volatility": {
          const data = job.data as FetchVolatilityJobData;
          const { currencies, concurrency = 3 } = data;

          console.log(`\n📥 Fetching historical volatility...`);

          const fetcher = new VolatilityFetcher({
            client: deps.client,
            storage: deps.parquetStorage,
          });

          const results = await fetcher.fetchMultipleCurrencies(currencies, concurrency);
          const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

          console.log(`✓ Fetched ${totalRecords} volatility records`);
          return { totalRecords, currencies: currencies.length };
        }

        case "fetch-dated-futures": {
          const data = job.data as FetchDatedFuturesJobData;
          const { currency, concurrency = 3 } = data;

          console.log(`\n📥 Fetching dated futures for forward prices...`);

          const fetcher = new FuturesFetcher({
            client: deps.client,
            parquetStorage: deps.parquetStorage,
          });

          // Scan existing option parquet files to extract required futures
          const { readdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const optionsDir = join(deps.parquetStorage.getTradeFilePath(`${currency}-dummy`), "..");

          let optionInstruments: string[] = [];
          try {
            const files = readdirSync(optionsDir);
            optionInstruments = files
              .filter(f => f.endsWith(".parquet"))
              .map(f => f.replace(".parquet", ""));
            console.log(`Scanned ${optionInstruments.length} option instruments`);
          } catch (error) {
            console.warn(`⚠️  Could not scan options directory: ${error}`);
            return { currency, totalTrades: 0, futuresCount: 0 };
          }

          if (optionInstruments.length === 0) {
            console.log(`No options found - skipping futures fetch`);
            return { currency, totalTrades: 0, futuresCount: 0 };
          }

          // Extract unique dated futures from option instruments
          const datedFutures = fetcher.extractDatedFutures(optionInstruments);
          console.log(`Found ${datedFutures.length} unique dated futures contracts`);

          // Fetch each dated futures contract
          let totalTrades = 0;
          for (const futuresInstrument of datedFutures) {
            const result = await fetcher.fetchInstrument(futuresInstrument);
            if (!result.skipped) {
              totalTrades += result.totalTrades;
            }
          }

          console.log(`✓ Fetched ${totalTrades.toLocaleString()} futures trades`);
          return { currency, totalTrades, futuresCount: datedFutures.length };
        }

        case "enrich-duckdb": {
          const data = job.data as EnrichWithDuckDBJobData;
          const { currency, inputDir, outputDir, maxMemory, threads } = data;

          console.log(`\n🧮 Enriching ${currency} with DuckDB Greeks...`);

          const enricher = new DuckDBEnricher();

          const result = await enricher.enrich(currency, inputDir, outputDir, maxMemory, threads);

          console.log(`✓ Enriched ${result.totalTrades.toLocaleString()} trades`);
          return result;
        }

        case "enrich-gold": {
          const data = job.data as EnrichGoldJobData;
          const { currency, inputDir, outputDir, maxMemory, threads } = data;

          console.log(`\n📊 Enriching ${currency} with Gold trading metrics...`);

          const enricher = new GoldEnricher();

          const result = await enricher.enrich(currency, inputDir, outputDir, maxMemory, threads);

          console.log(`✓ Enriched ${result.tradeCount.toLocaleString()} trades`);
          return result;
        }

        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    }, {
      embedded: true,
      dataPath: queueDbPath,
      concurrency: 3,
    });

    // Log job lifecycle events
    worker.on("completed", (job, result) => {
      // Log completion without dumping entire result object
      const summary = typeof result === 'object' && result !== null
        ? Object.keys(result).reduce((acc, key) => {
            const value = result[key];
            // Show counts/numbers, skip large arrays
            if (Array.isArray(value)) {
              acc[key] = `[${value.length} items]`;
            } else if (typeof value === 'object' && value !== null) {
              acc[key] = '[object]';
            } else {
              acc[key] = value;
            }
            return acc;
          }, {} as any)
        : result;
      console.log(`✓ Job ${job.name} (${job.id}) completed:`, summary);
    });

    worker.on("failed", (job, error) => {
      console.error(`✗ Job ${job.name} (${job.id}) failed:`, error);
    });

    worker.on("progress", (job, progress) => {
      console.log(`⏳ Job ${job.name} (${job.id}) progress:`, progress);
    });
  }

  return worker;
}

/**
 * Close queue and worker connections
 */
export async function close(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
