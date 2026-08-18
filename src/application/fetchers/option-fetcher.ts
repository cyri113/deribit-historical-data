import type { DeribitClient } from "../../infrastructure/deribit-client.ts";
import type { Database } from "../../infrastructure/database.ts";
import { JSONLStorage } from "../../infrastructure/jsonl-storage.ts";

export interface OptionFetcherConfig {
  client: DeribitClient;
  database: Database;
  storage: JSONLStorage;
  chunkSize?: number; // Default 10000
  concurrency?: number; // Max parallel option fetches
}

export interface OptionFetchProgress {
  instrumentName: string;
  lastNo: number;
  totalTrades: number;
  status: string;
  startTime: number;
  endTime?: number;
}

/**
 * Option Fetcher - Streaming with lazy chunk enqueue
 *
 * Design Decision #2: Options strategy
 * - Start at last_no + 1 (resume offset)
 * - Fetch chunks sequentially, enqueue next chunk in on_success callback
 * - Stop when no more trades (expired instruments only)
 * - Progress tracked as single resumable offset (last_no)
 */
export class OptionFetcher {
  private client: DeribitClient;
  private database: Database;
  private storage: JSONLStorage;
  private chunkSize: number;
  private concurrency: number;

  constructor(config: OptionFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.storage = config.storage;
    this.chunkSize = config.chunkSize ?? 10000;
    this.concurrency = config.concurrency ?? 3;
  }

  /**
   * Fetch trades for an option starting from last_no + 1
   * Streams until no more trades available
   */
  async fetchInstrument(
    instrumentName: string,
    onProgress?: (progress: OptionFetchProgress) => void
  ): Promise<OptionFetchProgress> {
    const startTime = Date.now();

    // Get current progress (creates record if doesn't exist)
    const progress = this.database.getOptionProgress(instrumentName);

    if (progress.status === "completed") {
      console.log(`  ⏭️  ${instrumentName} - already completed`);
      return {
        instrumentName,
        lastNo: progress.last_no,
        totalTrades: progress.trade_count,
        status: "completed",
        startTime,
        endTime: Date.now(),
      };
    }

    let currentSeq = progress.last_no + 1;
    let totalTrades = 0;
    let hasMore = true;

    // Stream chunks until no more trades
    while (hasMore) {
      const endSeq = currentSeq + this.chunkSize - 1;

      try {
        const { trades } = await this.client.getTradesBySeq(
          instrumentName,
          currentSeq,
          endSeq,
          this.chunkSize
        );

        if (trades.length === 0) {
          // No more trades - mark as complete
          hasMore = false;
          this.database.markOptionComplete(instrumentName);
          break;
        }

        // Write to JSONL (Design Decision #5: disk first, DB second)
        await this.storage.appendTrades(instrumentName, trades);
        totalTrades += trades.length;

        // Update progress with MAX guard (Design Decision #5)
        const lastTradeSeq = trades[trades.length - 1]!.trade_seq;
        const jsonlPath = this.storage["getFilePath"](instrumentName);

        this.database.updateOptionProgress(
          instrumentName,
          lastTradeSeq,
          progress.trade_count + totalTrades,
          jsonlPath
        );

        currentSeq = lastTradeSeq + 1;

        if (onProgress) {
          onProgress({
            instrumentName,
            lastNo: lastTradeSeq,
            totalTrades,
            status: "in_progress",
            startTime,
          });
        }

        // Check if this was the last batch
        if (trades.length < this.chunkSize) {
          hasMore = false;
          this.database.markOptionComplete(instrumentName);
        }
      } catch (error) {
        console.error(
          `✗ ${instrumentName} at seq ${currentSeq}: ${error instanceof Error ? error.message : String(error)}`
        );
        // Leave as in_progress for retry
        break;
      }
    }

    const endTime = Date.now();

    return {
      instrumentName,
      lastNo: currentSeq - 1,
      totalTrades,
      status: hasMore ? "in_progress" : "completed",
      startTime,
      endTime,
    };
  }

  /**
   * Fetch multiple options with concurrency limit
   */
  async fetchMultipleInstruments(
    instrumentNames: string[],
    onProgress?: (progress: OptionFetchProgress) => void
  ): Promise<OptionFetchProgress[]> {
    const results: OptionFetchProgress[] = [];
    const queue = [...instrumentNames];
    const inProgress = new Set<Promise<void>>();

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < this.concurrency) {
        const instrumentName = queue.shift()!;

        const promise = (async () => {
          try {
            const progress = await this.fetchInstrument(instrumentName, onProgress);
            results.push(progress);

            const duration = ((progress.endTime! - progress.startTime) / 1000).toFixed(2);
            const statusSymbol = progress.status === "completed" ? "✓" : "⚠️";

            console.log(
              `  ${statusSymbol} ${instrumentName}: ${progress.totalTrades} trades in ${duration}s`
            );
          } catch (error) {
            console.error(
              `  ✗ ${instrumentName}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        })();

        inProgress.add(promise);
        promise.finally(() => inProgress.delete(promise));
      }

      // Wait for at least one to complete
      if (inProgress.size > 0) {
        await Promise.race(inProgress);
      }
    }

    return results;
  }

  /**
   * Fetch all incomplete options for a currency
   */
  async fetchAllOptions(
    currency: string,
    onProgress?: (progress: OptionFetchProgress) => void
  ): Promise<{
    total: number;
    fetched: number;
    completed: number;
    totalTrades: number;
  }> {
    console.log(`\n━━━ Fetching ${currency} Options ━━━\n`);

    // Get incomplete options from DB
    const instrumentNames = this.database.getIncompleteOptions(currency);

    if (instrumentNames.length === 0) {
      console.log(`No incomplete options found. All done!`);
      return { total: 0, fetched: 0, completed: 0, totalTrades: 0 };
    }

    console.log(`Found ${instrumentNames.length} incomplete options\n`);

    const results = await this.fetchMultipleInstruments(instrumentNames, onProgress);

    const completed = results.filter((r) => r.status === "completed").length;
    const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);

    return {
      total: instrumentNames.length,
      fetched: results.length,
      completed,
      totalTrades,
    };
  }
}
