import { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { Database } from "../../infrastructure/database.ts";
import { ParquetStorage } from "../../infrastructure/parquet-storage.ts";
import type { DeribitHistoricalVolatility } from "../../domain/models.ts";

export interface VolatilityFetcherConfig {
  client: DeribitClient;
  database: Database;
  storage: ParquetStorage;
}

export interface VolatilityFetchProgress {
  currency: string;
  totalRecords: number;
  startTime: number;
  endTime?: number;
}

/**
 * VolatilityFetcher - Fetches historical volatility data and stores in Parquet
 *
 * Similar to DeliveryFetcher but for volatility data.
 * Historical volatility is a single fetch per currency (no pagination).
 */
export class VolatilityFetcher {
  private client: DeribitClient;
  private database: Database;
  private storage: ParquetStorage;

  constructor(config: VolatilityFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.storage = config.storage;
  }

  /**
   * Fetch and store historical volatility data for a currency
   *
   * @param currency - e.g., "BTC", "ETH"
   * @param onProgress - Optional progress callback
   * @returns Fetch progress info
   */
  async fetchHistoricalVolatility(
    currency: string,
    onProgress?: (progress: VolatilityFetchProgress) => void
  ): Promise<VolatilityFetchProgress> {
    const progress: VolatilityFetchProgress = {
      currency,
      totalRecords: 0,
      startTime: Date.now(),
    };

    try {
      // Fetch all historical volatility data
      const volatilityData = await this.client.getHistoricalVolatility(currency);

      progress.totalRecords = volatilityData.length;

      if (onProgress) {
        onProgress({ ...progress });
      }

      // Write to Parquet file
      await this.storage.writeHistoricalVolatility(currency, volatilityData);

      // Update database metadata
      this.database.upsertVolatilityMetadata(currency, volatilityData.length);

      progress.endTime = Date.now();

      if (onProgress) {
        onProgress({ ...progress });
      }

      return progress;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Fetch historical volatility for multiple currencies in parallel
   *
   * @param currencies - Array of currencies (e.g., ["BTC", "ETH"])
   * @param concurrency - Max parallel fetches (default 2)
   * @param onProgress - Optional progress callback
   * @returns Array of fetch progress for each currency
   */
  async fetchMultipleCurrencies(
    currencies: string[],
    concurrency: number = 2,
    onProgress?: (progress: VolatilityFetchProgress) => void
  ): Promise<VolatilityFetchProgress[]> {
    const results: VolatilityFetchProgress[] = [];
    const queue = [...currencies];
    const inProgress = new Set<Promise<void>>();

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < concurrency) {
        const currency = queue.shift()!;

        const promise = this.fetchHistoricalVolatility(currency, onProgress)
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
}
