import type { DeribitClient } from "../../infrastructure/deribit-client.ts";
import type { Database } from "../../infrastructure/database.ts";
import { JSONLStorage } from "../../infrastructure/jsonl-storage.ts";

export interface FutureFetcherConfig {
  client: DeribitClient;
  database: Database;
  storage: JSONLStorage;
  chunkSize?: number; // Default 10000
  concurrency?: number; // Max parallel chunk fetches
}

export interface FutureFetchProgress {
  instrumentName: string;
  totalChunks: number;
  completedChunks: number;
  pendingChunks: number;
  totalTrades: number;
  startTime: number;
  endTime?: number;
}

/**
 * Future Fetcher - Pre-allocated chunk-based concurrent fetching
 *
 * Design Decision #2: Futures strategy
 * - Fetch last_seq up front
 * - Pre-allocate all chunks [1, last_seq] into fixed ranges
 * - Fetch chunks concurrently (producer-consumer pattern)
 * - Each chunk written to JSONL + checkpoint in DB
 */
export class FutureFetcher {
  private client: DeribitClient;
  private database: Database;
  private storage: JSONLStorage;
  private chunkSize: number;
  private concurrency: number;

  constructor(config: FutureFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.storage = config.storage;
    this.chunkSize = config.chunkSize ?? 10000;
    this.concurrency = config.concurrency ?? 3;
  }

  /**
   * Prepare chunks for a future instrument
   * Gets last_seq and creates chunk records in DB
   */
  async prepareInstrument(instrumentName: string): Promise<{
    lastSeq: number | null;
    chunksCreated: number;
  }> {
    // Get last_seq from API (Design Decision #8: three-state result)
    const lastSeq = await this.client.getLastTradeSeq(instrumentName);

    if (lastSeq === null) {
      // Could not determine - leave incomplete for retry
      console.warn(`⚠️  Could not get last_seq for ${instrumentName} - will retry next run`);
      return { lastSeq: null, chunksCreated: 0 };
    }

    if (lastSeq === 0) {
      // Confirmed empty - mark complete
      console.log(`✓ ${instrumentName}: no trades (empty)`);
      this.database.updateInstrumentLastSeq(instrumentName, 0);
      return { lastSeq: 0, chunksCreated: 0 };
    }

    // Update instrument with last_seq
    this.database.updateInstrumentLastSeq(instrumentName, lastSeq);

    // Create chunks [1, lastSeq]
    this.database.createFutureChunks(instrumentName, lastSeq, this.chunkSize);

    const stats = this.database.getFutureChunkStats(instrumentName);

    console.log(`✓ ${instrumentName}: last_seq=${lastSeq}, chunks=${stats.total}`);

    return { lastSeq, chunksCreated: stats.total };
  }

  /**
   * Fetch a single chunk and write to JSONL
   */
  private async fetchChunk(
    instrumentName: string,
    startSeq: number,
    endSeq: number
  ): Promise<{ tradeCount: number }> {
    let totalTrades = 0;

    // Fetch trades in this seq range
    const generator = this.client.getAllTradesBySeq(
      instrumentName,
      startSeq,
      endSeq,
      this.chunkSize
    );

    for await (const trades of generator) {
      // Write to JSONL (Design Decision #5: disk first, DB second)
      await this.storage.appendTrades(instrumentName, trades);
      totalTrades += trades.length;
    }

    return { tradeCount: totalTrades };
  }

  /**
   * Fetch all pending chunks for an instrument concurrently
   */
  async fetchInstrument(
    instrumentName: string,
    onProgress?: (progress: FutureFetchProgress) => void
  ): Promise<FutureFetchProgress> {
    const startTime = Date.now();

    // Get incomplete chunks
    const chunks = this.database.getIncompleteFutureChunks(instrumentName);

    if (chunks.length === 0) {
      const stats = this.database.getFutureChunkStats(instrumentName);
      return {
        instrumentName,
        totalChunks: stats.total,
        completedChunks: stats.done,
        pendingChunks: 0,
        totalTrades: 0,
        startTime,
        endTime: Date.now(),
      };
    }

    let completedChunks = 0;
    let totalTrades = 0;

    const stats = this.database.getFutureChunkStats(instrumentName);

    // Process chunks with concurrency limit
    const queue = [...chunks];
    const inProgress = new Set<Promise<void>>();

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new chunk fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < this.concurrency) {
        const chunk = queue.shift()!;

        const promise = (async () => {
          try {
            const result = await this.fetchChunk(
              instrumentName,
              chunk.chunk_start_seq,
              chunk.chunk_end_seq
            );

            // Mark chunk as done in DB (after JSONL flush)
            const jsonlPath = this.storage["getFilePath"](instrumentName);
            this.database.markFutureChunkDone(
              instrumentName,
              chunk.chunk_start_seq,
              chunk.chunk_end_seq,
              result.tradeCount,
              jsonlPath
            );

            completedChunks++;
            totalTrades += result.tradeCount;

            if (onProgress) {
              onProgress({
                instrumentName,
                totalChunks: stats.total,
                completedChunks: stats.done + completedChunks,
                pendingChunks: stats.pending - completedChunks,
                totalTrades,
                startTime,
              });
            }
          } catch (error) {
            console.error(
              `✗ Chunk [${chunk.chunk_start_seq}, ${chunk.chunk_end_seq}]: ${error instanceof Error ? error.message : String(error)}`
            );
            // Chunk remains incomplete for retry
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

    const endTime = Date.now();

    return {
      instrumentName,
      totalChunks: stats.total,
      completedChunks: stats.done + completedChunks,
      pendingChunks: chunks.length - completedChunks,
      totalTrades,
      startTime,
      endTime,
    };
  }

  /**
   * Fetch multiple future instruments
   */
  async fetchMultipleInstruments(
    instrumentNames: string[],
    onProgress?: (progress: FutureFetchProgress) => void
  ): Promise<FutureFetchProgress[]> {
    const results: FutureFetchProgress[] = [];

    for (const instrumentName of instrumentNames) {
      console.log(`\n📥 Fetching ${instrumentName}...`);

      try {
        const progress = await this.fetchInstrument(instrumentName, onProgress);
        results.push(progress);

        const duration = ((progress.endTime! - progress.startTime) / 1000).toFixed(2);
        console.log(
          `✓ ${instrumentName}: ${progress.totalTrades} trades, ${progress.completedChunks}/${progress.totalChunks} chunks in ${duration}s`
        );
      } catch (error) {
        console.error(
          `✗ ${instrumentName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return results;
  }

  /**
   * Complete pipeline: prepare + fetch for a currency
   */
  async fetchAllFutures(
    currency: string,
    onProgress?: (progress: FutureFetchProgress) => void
  ): Promise<{
    prepared: number;
    fetched: number;
    totalTrades: number;
  }> {
    console.log(`\n━━━ Fetching ${currency} Futures ━━━\n`);

    // Get future instruments from DB
    const instruments = this.database.getInstruments(currency, "future");

    if (instruments.length === 0) {
      console.log(`No future instruments found. Run fetch-instruments first.`);
      return { prepared: 0, fetched: 0, totalTrades: 0 };
    }

    console.log(`Found ${instruments.length} future instruments\n`);

    // Step 1: Prepare all instruments (get last_seq, create chunks)
    console.log(`[1/2] Preparing instruments...`);
    let preparedCount = 0;

    for (const inst of instruments) {
      const { lastSeq } = await this.prepareInstrument(inst.instrument_name);
      if (lastSeq !== null) {
        preparedCount++;
      }
    }

    console.log(`\n✓ Prepared ${preparedCount}/${instruments.length} instruments\n`);

    // Step 2: Fetch all instruments (concurrent chunks)
    console.log(`[2/2] Fetching trades...`);

    const results = await this.fetchMultipleInstruments(
      instruments.map((i) => i.instrument_name),
      onProgress
    );

    const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);

    return {
      prepared: preparedCount,
      fetched: results.length,
      totalTrades,
    };
  }
}
