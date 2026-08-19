import type { DeribitClient } from "../../infrastructure/deribit-client.ts";
import type { Database } from "../../infrastructure/database.ts";
import { JSONLStorage } from "../../infrastructure/jsonl-storage.ts";
import { ParquetStorage } from "../../infrastructure/parquet-storage.ts";

export interface OptionFetcherConfig {
  client: DeribitClient;
  database: Database;
  jsonlStorage: JSONLStorage;
  parquetStorage: ParquetStorage;
  chunkSize?: number; // Default 10000
  concurrency?: number; // Max parallel option fetches
  maxSeq?: number; // Skip options with more than this many trades
}

export interface OptionFetchProgress {
  instrumentName: string;
  lastNo: number;
  totalTrades: number;
  lastSeq?: number; // Total trades that exist for this instrument (from API)
  status: string;
  startTime: number;
  endTime?: number;
}

/**
 * Option Fetcher - Streaming with lazy chunk enqueue
 *
 * Design Decision #2: Options strategy
 * - Start at last_no + 1 (resume offset)
 * - Fetch chunks sequentially until reaching lastSeq
 * - Stop when lastTradeSeq >= lastSeq
 * - Progress tracked as single resumable offset (last_no)
 *
 * API Behavior:
 * - Deribit API returns trades in DESCENDING order (newest first)
 * - Use Math.max() to find highest trade_seq in response
 * - Loop safety check prevents infinite loops if API returns unexpected data
 */
export class OptionFetcher {
  private client: DeribitClient;
  private database: Database;
  private jsonlStorage: JSONLStorage;
  private parquetStorage: ParquetStorage;
  private chunkSize: number;
  private concurrency: number;
  private maxSeq?: number;

  constructor(config: OptionFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.jsonlStorage = config.jsonlStorage;
    this.parquetStorage = config.parquetStorage;
    this.chunkSize = config.chunkSize ?? 10000;
    this.concurrency = config.concurrency ?? 3;
    this.maxSeq = config.maxSeq;
  }

  /**
   * Convert JSONL to Parquet and delete JSONL file
   * Called when instrument is complete
   */
  private async convertToParquet(instrumentName: string): Promise<void> {
    // Read all trades from JSONL
    const trades = await this.jsonlStorage.readTrades(instrumentName);

    if (trades.length === 0) {
      // No trades to convert, just clean up
      await this.jsonlStorage.deleteFile(instrumentName);
      return;
    }

    // Write to Parquet
    await this.parquetStorage.writeTrades(instrumentName, trades);

    // Delete JSONL file
    await this.jsonlStorage.deleteFile(instrumentName);

    // Update database with new Parquet path
    const parquetPath = this.parquetStorage.getTradeFilePath(instrumentName);
    this.database.updateOptionProgress(
      instrumentName,
      trades[trades.length - 1]!.trade_seq,
      trades.length,
      parquetPath
    );
  }

  /**
   * Fetch trades for an option starting from last_no + 1
   * Fetches lastSeq from API, then streams chunks until reaching lastSeq
   *
   * Note: API returns trades in descending order, so we use Math.max() to find
   * the highest trade_seq in each batch and advance from there
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

    // Get lastSeq from API (lazy fetch - only when needed)
    const lastSeq = await this.client.getLastTradeSeq(instrumentName);

    if (lastSeq === null) {
      // Could not determine - leave for retry
      console.warn(`⚠️  ${instrumentName}: Could not get lastSeq - will retry next run`);
      return {
        instrumentName,
        lastNo: progress.last_no,
        totalTrades: 0,
        status: "in_progress",
        startTime,
        endTime: Date.now(),
      };
    }

    if (lastSeq === 0) {
      // Confirmed empty - mark complete immediately
      console.log(`✓ ${instrumentName}: no trades (empty)`);
      this.database.markOptionComplete(instrumentName);
      return {
        instrumentName,
        lastNo: 0,
        totalTrades: 0,
        status: "completed",
        startTime,
        endTime: Date.now(),
      };
    }

    // Check if instrument exceeds max-seq threshold
    if (this.maxSeq !== undefined && lastSeq > this.maxSeq) {
      console.log(`⏭️  ${instrumentName}: ${lastSeq.toLocaleString()} trades (above --max-seq ${this.maxSeq.toLocaleString()}) - SKIPPED`);
      return {
        instrumentName,
        lastNo: progress.last_no,
        totalTrades: 0,
        status: "completed", // Mark as "completed" to skip in future runs
        startTime,
        endTime: Date.now(),
      };
    }

    let currentSeq = progress.last_no + 1;
    let totalTrades = 0;
    let previousSeq = -1; // Track previous iteration to detect infinite loops

    console.log(`🔄 Starting fetch: ${instrumentName} | currentSeq=${currentSeq} | lastSeq=${lastSeq} | last_no=${progress.last_no}`);

    // Stream chunks until we reach lastSeq
    while (currentSeq <= lastSeq) {
      // Safety check: detect if we're stuck in a loop
      if (currentSeq === previousSeq) {
        console.error(`🚨 LOOP DETECTED: currentSeq=${currentSeq} hasn't advanced! Breaking to prevent infinite loop.`);
        break;
      }
      previousSeq = currentSeq;

      // Don't fetch beyond lastSeq
      const endSeq = Math.min(currentSeq + this.chunkSize - 1, lastSeq);

      console.log(`🔁 Loop iteration: currentSeq=${currentSeq} | endSeq=${endSeq} | lastSeq=${lastSeq} | condition=(${currentSeq} <= ${lastSeq})`);

      try {
        const { trades } = await this.client.getTradesBySeq(
          instrumentName,
          currentSeq,
          endSeq,
          this.chunkSize
        );

        if (trades.length === 0) {
          // No trades in this range - shouldn't happen if lastSeq is correct
          console.warn(`⚠️  ${instrumentName}: No trades in range ${currentSeq}-${endSeq}, but lastSeq=${lastSeq}`);
          break;
        }

        // Write to JSONL (disk first, DB second)
        await this.jsonlStorage.appendTrades(instrumentName, trades);
        totalTrades += trades.length;

        // Update progress with MAX guard
        // API returns trades in descending order (newest first), so get the highest seq
        const lastTradeSeq = Math.max(...trades.map(t => t.trade_seq));
        const jsonlPath = this.jsonlStorage.getFilePath(instrumentName);

        console.log(`💾 Batch complete: fetched ${trades.length} trades | lastTradeSeq=${lastTradeSeq} | totalTrades=${progress.trade_count + totalTrades}`);

        this.database.updateOptionProgress(
          instrumentName,
          lastTradeSeq,
          progress.trade_count + totalTrades,
          jsonlPath
        );

        currentSeq = lastTradeSeq + 1;
        console.log(`➡️  Next iteration: currentSeq set to ${currentSeq} (${lastTradeSeq} + 1)`);

        if (onProgress) {
          onProgress({
            instrumentName,
            lastNo: lastTradeSeq,
            totalTrades: progress.trade_count + totalTrades, // Cumulative total including previously fetched
            lastSeq, // Total trades that exist for this instrument
            status: "in_progress",
            startTime,
          });
        }

        // Check if we've reached the last trade
        if (lastTradeSeq >= lastSeq) {
          // We've fetched all trades up to lastSeq - mark complete
          console.log(`✅ Complete: ${instrumentName} | lastTradeSeq=${lastTradeSeq} >= lastSeq=${lastSeq} - converting to Parquet`);
          await this.convertToParquet(instrumentName);
          this.database.markOptionComplete(instrumentName);
          break;
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

    // Check if completed (reached lastSeq)
    const completed = (currentSeq - 1) >= lastSeq;

    return {
      instrumentName,
      lastNo: currentSeq - 1,
      totalTrades,
      status: completed ? "completed" : "in_progress",
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
    const useProgressBar = !!onProgress; // Suppress console logs if progress callback provided
    let completedInstruments = 0; // Track actual completions for debugging

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < this.concurrency) {
        const instrumentName = queue.shift()!;

        const promise = (async () => {
          try {
            const progress = await this.fetchInstrument(instrumentName, onProgress);
            results.push(progress);
            completedInstruments++;

            // Detect if instrument failed (has endTime but status is still "in_progress")
            // This means it encountered an error and broke out of the fetch loop
            const effectiveStatus =
              progress.endTime && progress.status === "in_progress"
                ? "failed"
                : progress.status;

            // Notify progress callback when complete (including failures)
            if (onProgress) {
              onProgress({
                ...progress,
                status: effectiveStatus,
              });
            }

            // Log completion (only if no progress bar)
            if (!useProgressBar) {
              const duration = ((progress.endTime! - progress.startTime) / 1000).toFixed(2);
              const statusSymbol =
                effectiveStatus === "completed" ? "✓" :
                effectiveStatus === "failed" ? "⚠️" :
                "⏳";
              console.log(
                `  ${statusSymbol} ${instrumentName}: ${progress.totalTrades} trades in ${duration}s`
              );
            }
          } catch (error) {
            // Shouldn't normally reach here since fetchInstrument catches errors
            if (!useProgressBar) {
              console.error(
                `  ✗ ${instrumentName}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            // Fire completion callback even for unexpected errors
            if (onProgress) {
              onProgress({
                instrumentName,
                lastNo: 0,
                totalTrades: 0,
                status: "failed",
                startTime: Date.now(),
                endTime: Date.now(),
              });
            }
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
   *
   * @param currency - Base currency (e.g., "BTC", "ETH")
   * @param onProgress - Optional progress callback
   * @param minExpiration - Optional minimum expiration timestamp (ms)
   * @param maxExpiration - Optional maximum expiration timestamp (ms)
   */
  async fetchAllOptions(
    currency: string,
    onProgress?: (progress: OptionFetchProgress) => void,
    minExpiration?: number,
    maxExpiration?: number
  ): Promise<{
    total: number;
    fetched: number;
    completed: number;
    totalTrades: number;
    skipped: number;
  }> {
    console.log(`\n━━━ Fetching ${currency} Options ━━━\n`);

    // Get incomplete options from DB with optional date filtering (NO trade count filtering)
    const allInstrumentNames = this.database.getIncompleteOptions(
      currency,
      minExpiration,
      maxExpiration
    );

    if (allInstrumentNames.length === 0) {
      console.log(`No incomplete options found. All done!`);
      return { total: 0, fetched: 0, completed: 0, totalTrades: 0, skipped: 0 };
    }

    // Show date filter info if provided
    if (minExpiration || maxExpiration) {
      const formatDate = (ts: number) => new Date(ts).toISOString().split('T')[0];
      if (minExpiration && maxExpiration) {
        console.log(`Filtering: ${formatDate(minExpiration!)} to ${formatDate(maxExpiration!)}`);
      } else if (minExpiration) {
        console.log(`Filtering: expiring after ${formatDate(minExpiration!)}`);
      } else if (maxExpiration) {
        console.log(`Filtering: expiring before ${formatDate(maxExpiration!)}`);
      }
    }

    console.log(`Found ${allInstrumentNames.length} incomplete options\n`);
    console.log(`Starting downloads (lastSeq fetched lazily for each instrument)...\n`);

    const results = await this.fetchMultipleInstruments(allInstrumentNames, onProgress);

    const completed = results.filter((r) => r.status === "completed").length;
    const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);
    const skipped = results.filter((r) => r.status === "completed" && r.totalTrades === 0).length; // Count instruments that were skipped/empty

    return {
      total: allInstrumentNames.length,
      fetched: results.length,
      completed,
      totalTrades,
      skipped,
    };
  }
}
