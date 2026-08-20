import type { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { ParquetStorage } from "../../infrastructure/parquet-storage.ts";
import { existsSync } from "node:fs";

export interface OptionFetcherConfig {
  client: DeribitClient;
  parquetStorage: ParquetStorage;
}

export interface OptionFetchProgress {
  instrumentName: string;
  totalTrades: number;
  skipped?: boolean;
  startTime: number;
  endTime?: number;
}

/**
 * Option Fetcher - Simplified Parquet-based fetching
 *
 * Strategy: Check if Parquet exists → skip if yes, fetch all trades if no
 * No progress tracking, no database - idempotent via filesystem
 */
export class OptionFetcher {
  private client: DeribitClient;
  private parquetStorage: ParquetStorage;

  constructor(config: OptionFetcherConfig) {
    this.client = config.client;
    this.parquetStorage = config.parquetStorage;
  }

  /**
   * Fetch all trades for an option instrument
   * Skips if Parquet file already exists (idempotent)
   */
  async fetchInstrument(
    instrumentName: string,
    onProgress?: (progress: OptionFetchProgress) => void
  ): Promise<OptionFetchProgress> {
    const startTime = Date.now();

    // Check if already fetched (idempotent via filesystem)
    const parquetPath = this.parquetStorage.getTradeFilePath(instrumentName);
    if (existsSync(parquetPath)) {
      console.log(`✓ ${instrumentName} already complete (Parquet exists)`);
      return {
        instrumentName,
        totalTrades: 0,
        skipped: true,
        startTime,
        endTime: Date.now(),
      };
    }

    // Get last_seq to determine total trades
    const lastSeq = await this.client.getLastTradeSeq(instrumentName);

    if (lastSeq === null) {
      console.warn(`⚠️  Could not get last_seq for ${instrumentName} - skipping`);
      return {
        instrumentName,
        totalTrades: 0,
        startTime,
        endTime: Date.now(),
      };
    }

    if (lastSeq === 0) {
      console.log(`✓ ${instrumentName}: no trades (empty)`);
      return {
        instrumentName,
        totalTrades: 0,
        startTime,
        endTime: Date.now(),
      };
    }

    // Fetch all trades [1, lastSeq]
    console.log(`📥 Fetching ${instrumentName} (${lastSeq.toLocaleString()} trades)...`);

    const allTrades = [];
    const generator = this.client.getAllTradesBySeq(instrumentName, 1, lastSeq, 10000);

    for await (const trades of generator) {
      allTrades.push(...trades);

      if (onProgress) {
        onProgress({
          instrumentName,
          totalTrades: allTrades.length,
          startTime,
        });
      }
    }

    if (allTrades.length === 0) {
      console.log(`✓ ${instrumentName}: no trades (empty)`);
      return {
        instrumentName,
        totalTrades: 0,
        startTime,
        endTime: Date.now(),
      };
    }

    // Write directly to Parquet (no JSONL intermediate)
    await this.parquetStorage.writeTrades(instrumentName, allTrades);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`✓ ${instrumentName}: ${allTrades.length.toLocaleString()} trades in ${duration}s`);

    return {
      instrumentName,
      totalTrades: allTrades.length,
      startTime,
      endTime,
    };
  }

  /**
   * Fetch multiple option instruments
   */
  async fetchMultipleInstruments(
    instrumentNames: string[],
    onProgress?: (progress: OptionFetchProgress) => void
  ): Promise<OptionFetchProgress[]> {
    const results: OptionFetchProgress[] = [];

    for (const instrumentName of instrumentNames) {
      try {
        const progress = await this.fetchInstrument(instrumentName, onProgress);
        results.push(progress);
      } catch (error) {
        console.error(
          `✗ ${instrumentName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return results;
  }
}
