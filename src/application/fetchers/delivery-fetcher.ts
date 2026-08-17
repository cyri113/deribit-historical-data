import { DeribitClient } from "../../infrastructure/deribit-client.ts";
import { Database } from "../../infrastructure/database.ts";
import type { DeliveryPrice } from "../../domain/models.ts";

export interface DeliveryFetcherConfig {
  client: DeribitClient;
  database: Database;
  batchSize?: number; // Records per API request
  dbBatchSize?: number; // Records per DB transaction
}

export interface DeliveryFetchProgress {
  indexName: string;
  totalRecords: number;
  batchesProcessed: number;
  startTime: number;
  endTime?: number;
}

/**
 * DeliveryFetcher - Fetches historical delivery (settlement) prices and stores in DB
 *
 * Handles pagination and batch database writes
 */
export class DeliveryFetcher {
  private client: DeribitClient;
  private database: Database;
  private batchSize: number;
  private dbBatchSize: number;

  constructor(config: DeliveryFetcherConfig) {
    this.client = config.client;
    this.database = config.database;
    this.batchSize = config.batchSize ?? 100;
    this.dbBatchSize = config.dbBatchSize ?? 1000;
  }

  /**
   * Fetch and store all delivery prices for an index
   *
   * @param indexName - e.g., "btc_usd", "eth_usd"
   * @param onProgress - Optional progress callback
   * @returns Fetch progress info
   */
  async fetchDeliveryPrices(
    indexName: string,
    onProgress?: (progress: DeliveryFetchProgress) => void
  ): Promise<DeliveryFetchProgress> {
    const progress: DeliveryFetchProgress = {
      indexName,
      totalRecords: 0,
      batchesProcessed: 0,
      startTime: Date.now(),
    };

    let deliveryBuffer: DeliveryPrice[] = [];

    try {
      const generator = this.client.getAllDeliveryPrices(
        indexName,
        this.batchSize
      );

      for await (const deribitPrices of generator) {
        // Convert to domain models
        const deliveryPrices: DeliveryPrice[] = deribitPrices.map((dp) => ({
          indexName,
          date: dp.date,
          deliveryPrice: dp.delivery_price,
        }));

        deliveryBuffer.push(...deliveryPrices);
        progress.totalRecords += deliveryPrices.length;

        // Flush to database when buffer is full
        if (deliveryBuffer.length >= this.dbBatchSize) {
          this.database.insertDeliveryPrices(deliveryBuffer);
          progress.batchesProcessed++;
          deliveryBuffer = [];

          if (onProgress) {
            onProgress({ ...progress });
          }
        }
      }

      // Flush remaining records
      if (deliveryBuffer.length > 0) {
        this.database.insertDeliveryPrices(deliveryBuffer);
        progress.batchesProcessed++;
      }

      progress.endTime = Date.now();

      if (onProgress) {
        onProgress({ ...progress });
      }

      return progress;
    } catch (error) {
      // Flush buffer on error to avoid data loss
      if (deliveryBuffer.length > 0) {
        this.database.insertDeliveryPrices(deliveryBuffer);
      }
      throw error;
    }
  }

  /**
   * Fetch delivery prices for multiple indices in parallel
   *
   * @param indices - Array of index names (e.g., ["btc_usd", "eth_usd"])
   * @param concurrency - Max parallel fetches (default 2)
   * @param onProgress - Optional progress callback
   * @returns Array of fetch progress for each index
   */
  async fetchMultipleIndices(
    indices: string[],
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

        const promise = this.fetchDeliveryPrices(indexName, onProgress)
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
