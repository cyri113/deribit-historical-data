import parquet from "parquetjs";
import { JSONLStorage } from "./jsonl-storage.ts";
import type { Database } from "./database.ts";
import type { DeribitTrade } from "../domain/models.ts";
import { parseInstrumentName } from "../domain/models.ts";
import { calculateGreeks } from "../domain/black76.ts";
import { calculateMoneyness, calculateIntrinsicValue, calculateMoneynessPercentage } from "../domain/moneyness.ts";
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
   * Enrich a single trade with Greeks and moneyness
   */
  private enrichTrade(
    trade: DeribitTrade,
    instrument: ReturnType<typeof parseInstrumentName>,
    deliveryPrice?: number
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
          trade.iv,
          optionType
        );

        enriched.delta = greeks.delta;
        enriched.gamma = greeks.gamma;
        enriched.vega = greeks.vega;
        enriched.theta = greeks.theta;
        enriched.theoretical_price = greeks.price;
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

    return enriched;
  }

  /**
   * Convert JSONL trades to enriched Parquet for a single instrument
   *
   * @param instrumentName - Instrument to process
   * @param onProgress - Optional progress callback
   * @returns Progress information
   */
  async enrichInstrument(
    instrumentName: string,
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
    const indexName = `${instrument.underlying.toLowerCase()}_usd`;
    const deliveryPrice = this.database.getDeliveryPrice(indexName, instrument.expiration)?.deliveryPrice;

    // Create output file
    const outputPath = this.getOutputPath(instrumentName);
    await this.ensureDir(outputPath);

    // Open Parquet writer
    const writer = await parquet.ParquetWriter.openFile(
      ENRICHED_TRADE_SCHEMA,
      outputPath
    );

    let enrichedCount = 0;

    // Process trades in batches for memory efficiency
    const batchSize = 1000;
    for (let i = 0; i < trades.length; i += batchSize) {
      const batch = trades.slice(i, i + batchSize);

      for (const trade of batch) {
        const enriched = this.enrichTrade(trade, instrument, deliveryPrice);
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
   * @param onProgress - Optional progress callback
   * @returns Array of progress results
   */
  async enrichMultipleInstruments(
    instrumentNames: string[],
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentProgress[]> {
    const results: EnrichmentProgress[] = [];

    for (const instrumentName of instrumentNames) {
      try {
        const progress = await this.enrichInstrument(instrumentName, onProgress);
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

    const results = await this.enrichMultipleInstruments(instrumentNames, onProgress);

    const totalTrades = results.reduce((sum, r) => sum + r.enrichedTrades, 0);

    return {
      total: instrumentNames.length,
      enriched: results.length,
      totalTrades,
    };
  }
}
