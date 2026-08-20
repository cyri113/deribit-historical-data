import { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { Database } from "../../infrastructure/database.ts";
import { ParquetStorage } from "../../infrastructure/parquet-storage.ts";
import type { DeribitDeliveryPrice } from "../../domain/models.ts";

export interface DeliveryFetcherConfig {
  client: DeribitClient;
  database: Database;
  storage: ParquetStorage;
  batchSize?: number; // Records per API request
}

export interface DeliveryFetchProgress {
  indexName: string;
  totalRecords: number;
  batchesProcessed: number;
  startTime: number;
  endTime?: number;
}

/**
 * DeliveryFetcher - Fetches historical delivery (settlement) prices and stores in Parquet
 *
 * Handles pagination and writes to Parquet file
 */
export class DeliveryFetcher {
  private client: DeribitClient;
  private database: Database;
  private storage: ParquetStorage;
  private batchSize: number;

  constructor(config: DeliveryFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.storage = config.storage;
    this.batchSize = config.batchSize ?? 100;
  }

  /**
   * Fetch and store all delivery prices for an index
   *
   * @param indexName - e.g., "btc_usd", "eth_usd"
   * @param startDate - Optional start date filter (timestamp)
   * @param endDate - Optional end date filter (timestamp)
   * @param onProgress - Optional progress callback
   * @returns Fetch progress info
   */
  async fetchDeliveryPrices(
    indexName: string,
    startDate?: number,
    endDate?: number,
    onProgress?: (progress: DeliveryFetchProgress) => void
  ): Promise<DeliveryFetchProgress> {
    const progress: DeliveryFetchProgress = {
      indexName,
      totalRecords: 0,
      batchesProcessed: 0,
      startTime: Date.now(),
    };

    const allDeliveryPrices: DeribitDeliveryPrice[] = [];

    try {
      const generator = this.client.getAllDeliveryPrices(
        indexName,
        this.batchSize
      );

      for await (const deribitPrices of generator) {
        // Apply date filtering if specified
        const filtered = deribitPrices.filter((dp) => {
          const timestamp = new Date(dp.date).getTime();
          if (startDate && timestamp < startDate) return false;
          if (endDate && timestamp > endDate) return false;
          return true;
        });

        allDeliveryPrices.push(...filtered);
        progress.totalRecords += filtered.length;
        progress.batchesProcessed++;

        if (onProgress) {
          onProgress({ ...progress });
        }
      }

      // Write all delivery prices to Parquet file
      await this.storage.writeDeliveryPrices(indexName, allDeliveryPrices);

      progress.endTime = Date.now();

      if (onProgress) {
        onProgress({ ...progress });
      }

      return progress;
    } catch (error) {
      // On error, still try to write whatever we have
      if (allDeliveryPrices.length > 0) {
        await this.storage.writeDeliveryPrices(indexName, allDeliveryPrices);
      }
      throw error;
    }
  }

  /**
   * Fetch delivery prices for multiple indices in parallel
   *
   * @param indices - Array of index names (e.g., ["btc_usd", "eth_usd"])
   * @param startDate - Optional start date filter (timestamp)
   * @param endDate - Optional end date filter (timestamp)
   * @param concurrency - Max parallel fetches (default 2)
   * @param onProgress - Optional progress callback
   * @returns Array of fetch progress for each index
   */
  async fetchMultipleIndices(
    indices: string[],
    startDate?: number,
    endDate?: number,
    concurrency: number = 2,
    onProgress?: (progress: DeliveryFetchProgress) => void
  ): Promise<DeliveryFetchProgress[]> {
    const results: DeliveryFetchProgress[] = [];
    const queue = [...indices];
    const inProgress = new Set<Promise<void>>();

    while (queue.length > 0 || inProgress.size > 0) {
      // Start new fetches up to concurrency limit
      while (queue.length > 0 && inProgress.size < concurrency) {
        const indexName = queue.shift()!;

        const promise = this.fetchDeliveryPrices(indexName, startDate, endDate, onProgress)
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
   * Get delivery price for a specific date, fetching if not in DB
   *
   * @param indexName - Index name
   * @param date - Timestamp in milliseconds
   * @returns Delivery price or null if not found
   */
  async getOrFetchDeliveryPrice(
    indexName: string,
    date: number
  ): Promise<number | null> {
    // Check database first
    const cached = this.database.getDeliveryPrice(indexName, date);
    if (cached) {
      return cached.deliveryPrice;
    }

    // Fetch all delivery prices for the index
    await this.fetchDeliveryPrices(indexName);

    // Try again from database
    const fetched = this.database.getDeliveryPrice(indexName, date);
    return fetched?.deliveryPrice ?? null;
  }
}
