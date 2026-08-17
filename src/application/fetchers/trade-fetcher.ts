import { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { Database } from "../../infrastructure/database.ts";
import { convertDeribitTradeToTrade } from "../../domain/models.ts";

export interface TradeFetcherConfig {
  client: DeribitClient;
  database: Database;
  batchSize?: number; // Trades per API request
  dbBatchSize?: number; // Trades per DB transaction
}

export interface FetchProgress {
  instrument: string;
  totalTrades: number;
  batchesProcessed: number;
  startTime: number;
  endTime?: number;
}

/**
 * TradeFetcher - Fetches historical trade data from Deribit and stores in DB
 *
 * Handles pagination, batching, and progress tracking
 */
export class TradeFetcher {
  private client: DeribitClient;
  private database: Database;
  private batchSize: number;
  private dbBatchSize: number;

  constructor(config: TradeFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.batchSize = config.batchSize ?? 1000;
    this.dbBatchSize = config.dbBatchSize ?? 5000;
  }

  /**
   * Fetch and store trades for a single instrument
   *
   * @param instrumentName - e.g., "BTC-29MAR24-50000-C"
   * @param startTimestamp - Start time in milliseconds
   * @param endTimestamp - End time in milliseconds
   * @param onProgress - Optional progress callback
   * @returns Fetch progress info
   */
  async fetchTrades(
    instrumentName: string,
    startTimestamp: number,
    endTimestamp: number,
    onProgress?: (progress: FetchProgress) => void
  ): Promise<FetchProgress> {
    const progress: FetchProgress = {
      instrument: instrumentName,
      totalTrades: 0,
      batchesProcessed: 0,
      startTime: Date.now(),
    };

    let tradeBuffer: ReturnType<typeof convertDeribitTradeToTrade>[] = [];

    try {
      const generator = this.client.getAllTrades(
        instrumentName,
        startTimestamp,
        endTimestamp,
        this.batchSize
      );

      for await (const deribitTrades of generator) {
        // Convert to domain models
        const trades = deribitTrades.map(convertDeribitTradeToTrade);
        tradeBuffer.push(...trades);
        progress.totalTrades += trades.length;

        // Flush to database when buffer is full
        if (tradeBuffer.length >= this.dbBatchSize) {
          this.database.insertTrades(tradeBuffer);
          progress.batchesProcessed++;
          tradeBuffer = [];

          if (onProgress) {
            onProgress({ ...progress });
          }
        }
      }

      // Flush remaining trades
      if (tradeBuffer.length > 0) {
        this.database.insertTrades(tradeBuffer);
        progress.batchesProcessed++;
      }

      progress.endTime = Date.now();

      if (onProgress) {
        onProgress({ ...progress });
      }

      return progress;
    } catch (error) {
      // Flush buffer on error to avoid data loss
      if (tradeBuffer.length > 0) {
        this.database.insertTrades(tradeBuffer);
      }
      throw error;
    }
  }

  /**
   * Fetch trades for multiple instruments in parallel
   *
   * @param instruments - Array of instrument names
   * @param startTimestamp - Start time in milliseconds
   * @param endTimestamp - End time in milliseconds
   * @param concurrency - Max parallel fetches (default 3)
   * @param onProgress - Optional progress callback
   * @returns Array of fetch progress for each instrument
   */
  async fetchMultipleInstruments(
    instruments: string[],
    startTimestamp: number,
    endTimestamp: number,
    concurrency: number = 3,
    onProgress?: (progress: FetchProgress) => void
  ): Promise<FetchProgress[]> {
    const results: FetchProgress[] = [];
    const queue = [...instruments];
    const inProgress = new Set<Promise<void>>();

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < concurrency) {
        const instrument = queue.shift()!;

        const promise = this.fetchTrades(
          instrument,
          startTimestamp,
          endTimestamp,
          onProgress
        )
          .then((progress) => {
            results.push(progress);
          })
          .finally(() => {
            inProgress.delete(promise);
          });

        inProgress.add(promise);
      }

      // Wait for at least one to complete
      if (inProgress.size > 0) {
        await Promise.race(inProgress);
      }
    }

    return results;
  }

  /**
   * Fetch trades for a lookback window (e.g., last 3 months)
   *
   * @param instrumentName - Instrument to fetch
   * @param lookbackMonths - Months to look back from now
   * @param onProgress - Optional progress callback
   * @returns Fetch progress
   */
  async fetchRecentTrades(
    instrumentName: string,
    lookbackMonths: number,
    onProgress?: (progress: FetchProgress) => void
  ): Promise<FetchProgress> {
    const endTimestamp = Date.now();
    const startTimestamp =
      endTimestamp - lookbackMonths * 30 * 24 * 60 * 60 * 1000;

    return this.fetchTrades(
      instrumentName,
      startTimestamp,
      endTimestamp,
      onProgress
    );
  }
}
