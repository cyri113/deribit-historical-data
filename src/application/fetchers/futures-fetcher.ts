import type { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { ParquetStorage } from "../../infrastructure/parquet-storage.ts";
import { existsSync } from "node:fs";

export interface FuturesFetcherConfig {
  client: DeribitClient;
  parquetStorage: ParquetStorage;
}

export interface FuturesFetchProgress {
  instrumentName: string;
  totalTrades: number;
  skipped?: boolean;
  startTime: number;
  endTime?: number;
}

/**
 * Futures Fetcher - Fetch dated futures for forward price data
 *
 * Strategy: Check if Parquet exists → skip if yes, fetch all trades if no
 * Fetches dated futures (e.g., BTC-10AUG26) to provide forward prices for options Greeks
 */
export class FuturesFetcher {
  private client: DeribitClient;
  private parquetStorage: ParquetStorage;

  constructor(config: FuturesFetcherConfig) {
    this.client = config.client;
    this.parquetStorage = config.parquetStorage;
  }

  /**
   * Fetch all trades for a dated futures instrument
   * Skips if Parquet file already exists (idempotent)
   */
  async fetchInstrument(
    instrumentName: string,
    onProgress?: (progress: FuturesFetchProgress) => void
  ): Promise<FuturesFetchProgress> {
    const startTime = Date.now();

    // Check if already fetched (idempotent via filesystem)
    const parquetPath = this.parquetStorage.getFuturesFilePath(instrumentName);
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
    }

    if (onProgress) {
      onProgress({
        instrumentName,
        totalTrades: allTrades.length,
        startTime,
      });
    }

    // Write to Parquet
    await this.parquetStorage.writeFuturesTrades(instrumentName, allTrades);

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(
      `✓ ${instrumentName}: ${allTrades.length.toLocaleString()} trades (${duration.toFixed(1)}s)`
    );

    return {
      instrumentName,
      totalTrades: allTrades.length,
      startTime,
      endTime,
    };
  }

  /**
   * Extract unique dated futures instruments from option instrument names
   * E.g., [BTC-10AUG26-60000-C, BTC-10AUG26-61000-P] → [BTC-10AUG26]
   */
  extractDatedFutures(optionInstruments: string[]): string[] {
    const futuresSet = new Set<string>();

    for (const instrument of optionInstruments) {
      // Extract BTC-10AUG26 or BTC-3JUN26 from BTC-10AUG26-60000-C or BTC-3JUN26-70000-P
      const match = instrument.match(/^([A-Z]+-\d{1,2}[A-Z]{3}\d{2})-/);
      if (match) {
        futuresSet.add(match[1]);
      }
    }

    return Array.from(futuresSet).sort();
  }
}
