import { Bunqueue } from "bunqueue/client";
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
 * Queue singleton for managing data fetching jobs
 */
class QueueManager {
  private static instance: Bunqueue | null = null;
  private static sharedDeps: {
    client: DeribitClient;
    parquetStorage: ParquetStorage;
  } | null = null;

  /**
   * Initialize shared dependencies
   */
  private static initDeps() {
    if (!QueueManager.sharedDeps) {
      QueueManager.sharedDeps = {
        client: new DeribitClient(),
        parquetStorage: new ParquetStorage(),
      };
    }
    return QueueManager.sharedDeps;
  }

  /**
   * Get or create the queue instance
   */
  static getQueue(): Bunqueue {
    if (!QueueManager.instance) {
      const deps = QueueManager.initDeps();

      // Ensure data directory exists for queue database
      const queueDbPath = "./data/queue.db";
      const dataDir = dirname(queueDbPath);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      QueueManager.instance = new Bunqueue("deribit-data", {
        embedded: true,
        dataPath: queueDbPath,
        concurrency: 3,
        retry: {
          maxAttempts: 3,
          strategy: "exponential",
        },
        routes: {
          "fetch-instruments": async (job: Job<FetchInstrumentsJobData>) => {
            const { currency, kind, expired, minExpiration, maxExpiration } = job.data;

            console.log(`\n📥 Fetching ${currency} instruments...`);
            const instruments = await deps.client.getInstruments(
              currency,
              kind,
              expired ?? false
            );

            // Apply expiration filters
            // For historical analysis: minExpiration = earliest expiry, maxExpiration = latest expiry
            // Example: --min-expiration 3m means "expired no earlier than 3 months ago"
            let filtered = instruments;
            if (minExpiration) {
              const minTs = typeof minExpiration === 'number' ? minExpiration : new Date(minExpiration).getTime();
              // Filter: expiration_timestamp >= minTs (expired after this date)
              filtered = filtered.filter(i => i.expiration_timestamp && i.expiration_timestamp >= minTs);
            }
            if (maxExpiration) {
              const maxTs = typeof maxExpiration === 'number' ? maxExpiration : new Date(maxExpiration).getTime();
              // Filter: expiration_timestamp <= maxTs (expired before this date)
              filtered = filtered.filter(i => i.expiration_timestamp && i.expiration_timestamp <= maxTs);
            }

            console.log(`✓ Found ${filtered.length} instruments`);

            return { count: filtered.length, currency, kind, instruments: filtered };
          },

          "fetch-trades": async (job: Job<FetchTradesJobData>) => {
            const { currency, kind, minExpiration, maxExpiration, expired } = job.data;

            console.log(`\n📥 Fetching ${currency} instruments and enqueuing trade jobs...`);

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

            // Enqueue individual fetch jobs
            const queue = QueueManager.getQueue();

            for (const future of futures) {
              await queue.add("fetch-future", { instrumentName: future.instrument_name });
            }

            for (const option of options) {
              await queue.add("fetch-option", { instrumentName: option.instrument_name });
            }

            console.log(`✓ Enqueued ${futures.length} futures + ${options.length} options`);
            return { futuresEnqueued: futures.length, optionsEnqueued: options.length };
          },

          "fetch-future": async (job: Job<FetchFutureJobData>) => {
            const { instrumentName } = job.data;

            const futureFetcher = new FutureFetcher({
              client: deps.client,
              parquetStorage: deps.parquetStorage,
            });

            const progress = await futureFetcher.fetchInstrument(instrumentName);
            console.log(`✓ ${instrumentName}: ${progress.totalTrades.toLocaleString()} trades`);

            return { instrumentName, totalTrades: progress.totalTrades };
          },

          "fetch-option": async (job: Job<FetchOptionJobData>) => {
            const { instrumentName } = job.data;

            const optionFetcher = new OptionFetcher({
              client: deps.client,
              parquetStorage: deps.parquetStorage,
            });

            const progress = await optionFetcher.fetchInstrument(instrumentName);
            console.log(`✓ ${instrumentName}: ${progress.totalTrades.toLocaleString()} trades`);

            return { instrumentName, totalTrades: progress.totalTrades };
          },

          "fetch-deliveries": async (job: Job<FetchDeliveriesJobData>) => {
            const { indices, startDate, endDate, concurrency = 3 } = job.data;

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
          },

          "fetch-volatility": async (job: Job<FetchVolatilityJobData>) => {
            const { currencies, concurrency = 3 } = job.data;

            console.log(`\n📥 Fetching historical volatility...`);

            const fetcher = new VolatilityFetcher({
              client: deps.client,
              storage: deps.parquetStorage,
            });

            const results = await fetcher.fetchMultipleCurrencies(
              currencies,
              concurrency
            );
            const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

            console.log(`✓ Fetched ${totalRecords} volatility records`);
            return { totalRecords, currencies: currencies.length };
          },

          "fetch-dated-futures": async (job: Job<FetchDatedFuturesJobData>) => {
            const { currency, concurrency = 3 } = job.data;

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
          },

          "enrich-duckdb": async (job: Job<EnrichWithDuckDBJobData>) => {
            const { currency, inputDir, outputDir, maxMemory, threads } = job.data;

            console.log(`\n🧮 Enriching ${currency} with DuckDB Greeks...`);

            const enricher = new DuckDBEnricher();

            const result = await enricher.enrich(
              currency,
              inputDir,
              outputDir,
              maxMemory,
              threads
            );

            console.log(`✓ Enriched ${result.totalTrades.toLocaleString()} trades`);
            return result;
          },

          "enrich-gold": async (job: Job<EnrichGoldJobData>) => {
            const { currency, inputDir, outputDir, maxMemory, threads } = job.data;

            console.log(`\n📊 Enriching ${currency} with Gold trading metrics...`);

            const enricher = new GoldEnricher();

            const result = await enricher.enrich(
              currency,
              inputDir,
              outputDir,
              maxMemory,
              threads
            );

            console.log(`✓ Enriched ${result.tradeCount.toLocaleString()} trades`);
            return result;
          },
        },
      });

      // Log job lifecycle events
      QueueManager.instance.on("completed", (job, result) => {
        console.log(`✓ Job ${job.name} (${job.id}) completed:`, JSON.stringify(result));
      });

      QueueManager.instance.on("failed", (job, error) => {
        console.error(`✗ Job ${job.name} (${job.id}) failed:`, error);
        console.error(`  Attempt ${job.attemptsMade} of ${job.opts?.attempts || 3}`);
        console.error(`  Error:`, error);
      });

      QueueManager.instance.on("progress", (job, progress) => {
        console.log(`⏳ Job ${job.name} (${job.id}) progress:`, progress);
      });

      QueueManager.instance.on("waiting", (job) => {
        console.log(`⏸️  Job ${job.name} (${job.id}) waiting`);
      });

      QueueManager.instance.on("active", (job) => {
        console.log(`▶️  Job ${job.name} (${job.id}) started`);
      });
    }

    return QueueManager.instance;
  }

  /**
   * Close the queue connection
   */
  static async close(): Promise<void> {
    if (QueueManager.instance) {
      await QueueManager.instance.close();
      QueueManager.instance = null;
    }
    if (QueueManager.sharedDeps) {
      QueueManager.sharedDeps = null;
    }
  }
}

export { QueueManager };
