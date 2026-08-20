import parquet from "parquetjs";
import { JSONLStorage } from "./jsonl-storage.ts";
import type { Database } from "./database.ts";
import type { DeribitTrade } from "../domain/models.ts";
import { parseInstrumentName } from "../domain/models.ts";
import { calculateGreeks } from "../domain/black76.ts";
import { calculateMoneyness, calculateIntrinsicValue, calculateMoneynessPercentage } from "../domain/moneyness.ts";
import {
  calculateAnnualizedYield,
  calculateIVRank,
  calculateExpectedValue
} from "../domain/trading-metrics.ts";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Parquet Schema for enriched trade data
 *
 * Combines:
 * - Raw trade data from JSONL
 * - Computed Greeks (Black-76)
 * - Moneyness classification
 * - Delivery price at expiry
 * - Trading metrics (annualized yield, IV rank, expected value)
 */
const ENRICHED_TRADE_SCHEMA = new parquet.ParquetSchema({
  // Trade data
  trade_id: { type: "UTF8" },
  trade_seq: { type: "INT64" },
  instrument_name: { type: "UTF8" },
  timestamp: { type: "TIMESTAMP_MILLIS" },
  price: { type: "DOUBLE" },
  amount: { type: "DOUBLE" },
  direction: { type: "UTF8" },
  tick_direction: { type: "INT32" },

  // Market data
  index_price: { type: "DOUBLE" },
  mark_price: { type: "DOUBLE", optional: true },
  implied_volatility: { type: "DOUBLE", optional: true },

  // Instrument details
  strike: { type: "DOUBLE" },
  expiration_timestamp: { type: "TIMESTAMP_MILLIS" },
  option_type: { type: "UTF8" }, // 'call' or 'put'
  time_to_expiry_years: { type: "DOUBLE" },

  // Greeks (computed)
  delta: { type: "DOUBLE", optional: true },
  gamma: { type: "DOUBLE", optional: true },
  vega: { type: "DOUBLE", optional: true },
  theta: { type: "DOUBLE", optional: true },
  theoretical_price: { type: "DOUBLE", optional: true },

  // Moneyness (at expiry)
  delivery_price: { type: "DOUBLE", optional: true },
  moneyness: { type: "UTF8", optional: true }, // 'ITM', 'ATM', 'OTM'
  intrinsic_value: { type: "DOUBLE", optional: true },
  moneyness_percentage: { type: "DOUBLE", optional: true },

  // Trading Metrics
  // 1. Annualized Premium Yield
  annualized_premium_yield: { type: "DOUBLE", optional: true }, // Percentage

  // 2. IV Rank (52-Week Percentile)
  iv_rank_52w: { type: "DOUBLE", optional: true }, // Percentile (0-100)
  iv_52w_high: { type: "DOUBLE", optional: true },
  iv_52w_low: { type: "DOUBLE", optional: true },
  iv_52w_mean: { type: "DOUBLE", optional: true },
  iv_52w_stddev: { type: "DOUBLE", optional: true },

  // 3. Expected Value (Stress Scenarios)
  expected_value_btc: { type: "DOUBLE", optional: true },
  win_probability: { type: "DOUBLE", optional: true }, // Percentage (0-100)
  max_loss_btc: { type: "DOUBLE", optional: true },
  max_gain_btc: { type: "DOUBLE", optional: true },
  sharpe_ratio: { type: "DOUBLE", optional: true },
});

export interface ParquetWriterConfig {
  database: Database;
  jsonlStorage: JSONLStorage;
  outputDir?: string; // Default: ./data/parquet
}

export interface EnrichmentProgress {
  instrumentName: string;
  totalTrades: number;
  enrichedTrades: number;
  startTime: number;
  endTime?: number;
}

/**
 * GlobalIVHistoryData - Efficient storage for cross-instrument IV history
 *
 * Stores each IV once and computes historical lookback windows on-demand.
 * This avoids massive data duplication (storing same IV billions of times).
 *
 * Memory savings: Stores 2.26M IVs once (~18 MB) instead of pre-computing
 * historical arrays for every bucket (157 GB with duplicates).
 */
export class GlobalIVHistoryData {
  private bucketedData: Map<number, number[]>;
  private sortedBuckets: number[];
  private fiftyTwoWeeksMs = 52 * 7 * 24 * 60 * 60 * 1000;

  constructor(bucketedData: Map<number, number[]>) {
    this.bucketedData = bucketedData;
    this.sortedBuckets = Array.from(bucketedData.keys()).sort((a, b) => a - b);
  }

  /**
   * Get historical IVs for a specific time bucket (computed on-demand)
   *
   * Returns all IVs from the 52 weeks BEFORE the given bucket.
   * This is called once per trade during enrichment.
   *
   * @param bucket - Time bucket to get historical IVs for
   * @returns Array of historical IVs from past 52 weeks
   */
  getHistoricalIVs(bucket: number): number[] {
    const lookbackStart = bucket - this.fiftyTwoWeeksMs;
    const historicalIVs: number[] = [];

    // Collect IVs from all buckets in the 52-week lookback window
    for (const b of this.sortedBuckets) {
      if (b >= bucket) break; // Stop when we reach the current bucket
      if (b >= lookbackStart) {
        historicalIVs.push(...this.bucketedData.get(b)!);
      }
    }

    return historicalIVs;
  }
}

/**
 * ParquetWriter - Converts JSONL trades to enriched Parquet files
 *
 * Design:
 * - Read trades from JSONL (source of truth)
 * - Compute Greeks using Black-76 model
 * - Calculate moneyness at expiry
 * - Write everything to columnar Parquet format
 * - One Parquet file per instrument
 */
export class ParquetWriter {
  private database: Database;
  private jsonlStorage: JSONLStorage;
  private outputDir: string;

  constructor(config: ParquetWriterConfig) {
    this.database = config.database;
    this.jsonlStorage = config.jsonlStorage;
    this.outputDir = config.outputDir ?? "./data/parquet";
  }

  /**
   * Get output file path for an instrument
   */
  private getOutputPath(instrumentName: string): string {
    // Organize by underlying currency
    // E.g., BTC-27MAR26-70000-C → data/parquet/BTC/BTC-27MAR26-70000-C.parquet
    const underlying = instrumentName.split("-")[0]!;
    return join(this.outputDir, underlying, `${instrumentName}.parquet`);
  }

  /**
   * Ensure directory exists for a file path
   */
  private async ensureDir(filePath: string): Promise<void> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Round timestamp to nearest time bucket for IV history grouping
   *
   * Reduces memory usage by grouping trades into hourly buckets instead of
   * tracking IV history for every individual trade timestamp.
   *
   * @param timestamp - Original timestamp in milliseconds
   * @param bucketSizeMs - Bucket size in milliseconds (default: 1 hour)
   * @returns Bucketed timestamp (rounded down to nearest bucket)
   */
  private bucketTimestamp(timestamp: number, bucketSizeMs: number = 3600000): number {
    return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
  }

  /**
   * Build global IV history map from ALL instruments
   *
   * Creates a rolling 52-week IV history that includes IVs from ALL instruments,
   * not just the current one. This provides statistically robust IV rank calculation.
   *
   * @param instrumentNames - All instruments to include in global history
   * @returns GlobalIVHistoryData for efficient on-demand IV lookups
   */
  public async buildGlobalIVHistory(
    instrumentNames: string[]
  ): Promise<GlobalIVHistoryData> {
    console.log(`Building global IV history from ${instrumentNames.length} instruments...`);

    // Collect and bucket all IV data by hourly intervals
    // Each IV is stored exactly once (no duplication)
    const bucketedData = new Map<number, number[]>();

    for (const instrumentName of instrumentNames) {
      try {
        const trades = await this.jsonlStorage.readTrades(instrumentName);
        for (const trade of trades) {
          if (trade.iv !== undefined && trade.iv !== null) {
            const bucket = this.bucketTimestamp(trade.timestamp);
            if (!bucketedData.has(bucket)) {
              bucketedData.set(bucket, []);
            }
            bucketedData.get(bucket)!.push(trade.iv);
          }
        }
      } catch (error) {
        // Skip instruments with no trades or read errors
        continue;
      }
    }

    const totalIVs = Array.from(bucketedData.values()).reduce((sum, ivs) => sum + ivs.length, 0);
    console.log(`Collected ${totalIVs} IV data points into ${bucketedData.size} hourly buckets`);
    console.log(`Memory-efficient storage: each IV stored once, lookups computed on-demand\n`);

    // Return GlobalIVHistoryData for on-demand historical IV computation
    return new GlobalIVHistoryData(bucketedData);
  }

  /**
   * Enrich a single trade with Greeks, moneyness, and trading metrics
   */
  private enrichTrade(
    trade: DeribitTrade,
    instrument: ReturnType<typeof parseInstrumentName>,
    deliveryPrice?: number,
    globalIVHistory?: GlobalIVHistoryData
  ): Record<string, any> {
    const { strike, expiration, optionType } = instrument!;

    // Calculate time to expiry in years
    const timeToExpiry = Math.max(
      0,
      (expiration - trade.timestamp) / (365.25 * 24 * 60 * 60 * 1000)
    );

    // Base enriched trade
    const enriched: Record<string, any> = {
      trade_id: trade.trade_id,
      trade_seq: trade.trade_seq,
      instrument_name: trade.instrument_name,
      timestamp: trade.timestamp,
      price: trade.price,
      amount: trade.amount,
      direction: trade.direction,
      tick_direction: trade.tick_direction,
      index_price: trade.index_price,
      mark_price: trade.mark_price ?? null,
      implied_volatility: trade.iv ?? null,
      strike,
      expiration_timestamp: expiration,
      option_type: optionType,
      time_to_expiry_years: timeToExpiry,
    };

    // Compute Greeks if we have implied volatility
    if (trade.iv && trade.iv > 0) {
      try {
        const greeks = calculateGreeks(
          trade.index_price, // Forward price = index price for crypto
          strike,
          timeToExpiry,
          trade.iv / 100, // Convert percentage to decimal (e.g., 19.06% → 0.1906)
          optionType
        );

        enriched.delta = greeks.delta;
        enriched.gamma = greeks.gamma;
        enriched.vega = greeks.vega;
        enriched.theta = greeks.theta;
        // Convert theoretical price from USD to BTC (Deribit quotes options in BTC)
        enriched.theoretical_price = greeks.price / trade.index_price;
      } catch (error) {
        // Greeks calculation failed (e.g., invalid inputs)
        enriched.delta = null;
        enriched.gamma = null;
        enriched.vega = null;
        enriched.theta = null;
        enriched.theoretical_price = null;
      }
    } else {
      enriched.delta = null;
      enriched.gamma = null;
      enriched.vega = null;
      enriched.theta = null;
      enriched.theoretical_price = null;
    }

    // Add moneyness if we have delivery price
    if (deliveryPrice !== undefined) {
      try {
        enriched.delivery_price = deliveryPrice;
        enriched.moneyness = calculateMoneyness(strike, deliveryPrice, optionType);
        enriched.intrinsic_value = calculateIntrinsicValue(strike, deliveryPrice, optionType);
        enriched.moneyness_percentage = calculateMoneynessPercentage(strike, deliveryPrice, optionType);
      } catch (error) {
        enriched.delivery_price = deliveryPrice;
        enriched.moneyness = null;
        enriched.intrinsic_value = null;
        enriched.moneyness_percentage = null;
      }
    } else {
      enriched.delivery_price = null;
      enriched.moneyness = null;
      enriched.intrinsic_value = null;
      enriched.moneyness_percentage = null;
    }

    // Trading Metrics

    // 1. Annualized Premium Yield
    const daysToExpiry = timeToExpiry * 365.25;
    if (trade.price > 0 && daysToExpiry > 0) {
      try {
        const yieldMetrics = calculateAnnualizedYield(
          trade.price,
          strike,
          trade.index_price,
          daysToExpiry
        );
        enriched.annualized_premium_yield = yieldMetrics?.annualized_premium_yield ?? null;
      } catch (error) {
        enriched.annualized_premium_yield = null;
      }
    } else {
      enriched.annualized_premium_yield = null;
    }

    // 2. IV Rank (52-Week Percentile) - using GLOBAL IV history
    if (trade.iv && globalIVHistory) {
      const bucketedTimestamp = this.bucketTimestamp(trade.timestamp);
      const historicalIVs = globalIVHistory.getHistoricalIVs(bucketedTimestamp);
      if (historicalIVs.length > 0) {
        try {
          const ivRankStats = calculateIVRank(trade.iv, historicalIVs);
          enriched.iv_rank_52w = ivRankStats.iv_rank_52w;
          enriched.iv_52w_high = ivRankStats.iv_52w_high;
          enriched.iv_52w_low = ivRankStats.iv_52w_low;
          enriched.iv_52w_mean = ivRankStats.iv_52w_mean;
          enriched.iv_52w_stddev = ivRankStats.iv_52w_stddev;
        } catch (error) {
          enriched.iv_rank_52w = null;
          enriched.iv_52w_high = null;
          enriched.iv_52w_low = null;
          enriched.iv_52w_mean = null;
          enriched.iv_52w_stddev = null;
        }
      } else {
        enriched.iv_rank_52w = null;
        enriched.iv_52w_high = null;
        enriched.iv_52w_low = null;
        enriched.iv_52w_mean = null;
        enriched.iv_52w_stddev = null;
      }
    } else {
      enriched.iv_rank_52w = null;
      enriched.iv_52w_high = null;
      enriched.iv_52w_low = null;
      enriched.iv_52w_mean = null;
      enriched.iv_52w_stddev = null;
    }

    // 3. Expected Value (Stress Scenarios)
    if (trade.price > 0) {
      try {
        const evMetrics = calculateExpectedValue(
          trade.price,
          strike,
          trade.index_price,
          optionType
        );
        enriched.expected_value_btc = evMetrics.expected_value_btc;
        enriched.win_probability = evMetrics.win_probability;
        enriched.max_loss_btc = evMetrics.max_loss_btc;
        enriched.max_gain_btc = evMetrics.max_gain_btc;
        enriched.sharpe_ratio = evMetrics.sharpe_ratio;
      } catch (error) {
        enriched.expected_value_btc = null;
        enriched.win_probability = null;
        enriched.max_loss_btc = null;
        enriched.max_gain_btc = null;
        enriched.sharpe_ratio = null;
      }
    } else {
      enriched.expected_value_btc = null;
      enriched.win_probability = null;
      enriched.max_loss_btc = null;
      enriched.max_gain_btc = null;
      enriched.sharpe_ratio = null;
    }

    return enriched;
  }

  /**
   * Convert JSONL trades to enriched Parquet for a single instrument
   *
   * @param instrumentName - Instrument to process
   * @param globalIVHistory - Optional global IV history map (for cross-instrument IV rank)
   * @param onProgress - Optional progress callback
   * @returns Progress information
   */
  async enrichInstrument(
    instrumentName: string,
    globalIVHistory?: GlobalIVHistoryData,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentProgress> {
    const startTime = Date.now();

    // Parse instrument
    const instrument = parseInstrumentName(instrumentName);
    if (!instrument || instrument.instrumentType !== "option") {
      throw new Error(
        `Invalid option instrument: ${instrumentName} (must be an option, not future/perpetual)`
      );
    }

    // Read trades from JSONL
    const trades = await this.jsonlStorage.readTrades(instrumentName);

    if (trades.length === 0) {
      console.log(`  ⏭️  ${instrumentName} - no trades found`);
      return {
        instrumentName,
        totalTrades: 0,
        enrichedTrades: 0,
        startTime,
        endTime: Date.now(),
      };
    }

    // Get delivery price (if expired)
    // Use getDeliveryPriceForInstrument which handles date normalization
    // (options expire at 08:00 UTC but delivery prices are stored at midnight UTC)
    const deliveryPrice = this.database.getDeliveryPriceForInstrument(instrumentName)?.deliveryPrice;

    // Create output file
    const outputPath = this.getOutputPath(instrumentName);
    await this.ensureDir(outputPath);

    // Open Parquet writer
    const writer = await parquet.ParquetWriter.openFile(
      ENRICHED_TRADE_SCHEMA,
      outputPath
    );

    let enrichedCount = 0;

    // Enrich trades with all metrics (Greeks, moneyness, trading metrics)
    const batchSize = 1000;
    for (let i = 0; i < trades.length; i += batchSize) {
      const batch = trades.slice(i, i + batchSize);

      for (const trade of batch) {
        // Enrich trade with Greeks, moneyness, and trading metrics
        // globalIVHistory provides cross-instrument IV rank context
        const enriched = this.enrichTrade(trade, instrument, deliveryPrice, globalIVHistory);
        await writer.appendRow(enriched);
        enrichedCount++;

        // Report progress every 1000 trades
        if (enrichedCount % 1000 === 0 && onProgress) {
          onProgress({
            instrumentName,
            totalTrades: trades.length,
            enrichedTrades: enrichedCount,
            startTime,
          });
        }
      }
    }

    // Close writer
    await writer.close();

    const endTime = Date.now();

    return {
      instrumentName,
      totalTrades: trades.length,
      enrichedTrades: enrichedCount,
      startTime,
      endTime,
    };
  }

  /**
   * Enrich multiple instruments with progress tracking
   *
   * @param instrumentNames - Array of instruments to process
   * @param globalIVHistory - Optional global IV history map (for cross-instrument IV rank)
   * @param onProgress - Optional progress callback
   * @returns Array of progress results
   */
  async enrichMultipleInstruments(
    instrumentNames: string[],
    globalIVHistory?: GlobalIVHistoryData,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentProgress[]> {
    const results: EnrichmentProgress[] = [];

    for (const instrumentName of instrumentNames) {
      try {
        const progress = await this.enrichInstrument(instrumentName, globalIVHistory, onProgress);
        results.push(progress);

        const duration = ((progress.endTime! - progress.startTime) / 1000).toFixed(2);
        console.log(
          `  ✓ ${instrumentName}: ${progress.enrichedTrades} trades enriched in ${duration}s`
        );
      } catch (error) {
        console.error(
          `  ✗ ${instrumentName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return results;
  }

  /**
   * Enrich all instruments for a currency
   *
   * Builds a global IV history from ALL instruments first, then enriches each
   * instrument with cross-instrument IV rank context.
   *
   * @param currency - Base currency (e.g., "BTC", "ETH")
   * @param onProgress - Optional progress callback
   * @returns Summary statistics
   */
  async enrichAllInstruments(
    currency: string,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<{
    total: number;
    enriched: number;
    totalTrades: number;
  }> {
    console.log(`\n━━━ Enriching ${currency} Options to Parquet ━━━\n`);

    // Get all completed options from database
    const instrumentNames = this.database.getCompletedOptions(currency);

    if (instrumentNames.length === 0) {
      console.log(`No completed options found.`);
      return { total: 0, enriched: 0, totalTrades: 0 };
    }

    console.log(`Found ${instrumentNames.length} completed options\n`);

    // Build global IV history from ALL instruments (cross-instrument context)
    const globalIVHistory = await this.buildGlobalIVHistory(instrumentNames);

    // Enrich each instrument with global IV rank context
    const results = await this.enrichMultipleInstruments(instrumentNames, globalIVHistory, onProgress);

    const totalTrades = results.reduce((sum, r) => sum + r.enrichedTrades, 0);

    return {
      total: instrumentNames.length,
      enriched: results.length,
      totalTrades,
    };
  }
}
