import { ParquetWriter, type EnrichmentProgress } from "../../infrastructure/parquet-writer.ts";
import { Database } from "../../infrastructure/database.ts";
import { JSONLStorage } from "../../infrastructure/jsonl-storage.ts";

export interface ParquetMergerConfig {
  database: Database;
  jsonlStorage: JSONLStorage;
  outputDir?: string;
}

export interface MergeResult {
  currency: string;
  totalInstruments: number;
  enrichedInstruments: number;
  totalTrades: number;
  duration: number;
}

/**
 * ParquetMerger - High-level orchestrator for JSONL → Parquet pipeline
 *
 * Design:
 * - Coordinates ParquetWriter with database and storage
 * - Provides batch processing for multiple instruments
 * - Handles progress tracking and error reporting
 */
export class ParquetMerger {
  private writer: ParquetWriter;
  private database: Database;

  constructor(config: ParquetMergerConfig) {
    this.database = config.database;
    this.writer = new ParquetWriter({
      database: config.database,
      jsonlStorage: config.jsonlStorage,
      outputDir: config.outputDir,
    });
  }

  /**
   * Merge a single instrument from JSONL to Parquet
   *
   * @param instrumentName - Instrument to merge
   * @param onProgress - Optional progress callback
   * @returns Enrichment progress
   */
  async mergeInstrument(
    instrumentName: string,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentProgress> {
    return this.writer.enrichInstrument(instrumentName, onProgress);
  }

  /**
   * Merge specific instruments from JSONL to Parquet
   *
   * @param instrumentNames - Array of instruments to merge
   * @param onProgress - Optional progress callback
   * @returns Array of enrichment progress
   */
  async mergeInstruments(
    instrumentNames: string[],
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentProgress[]> {
    return this.writer.enrichMultipleInstruments(instrumentNames, undefined, onProgress);
  }

  /**
   * Merge all completed options for a currency
   *
   * @param currency - Base currency (e.g., "BTC", "ETH")
   * @param onProgress - Optional progress callback
   * @param minExpiration - Optional minimum expiration timestamp (ms)
   * @param maxExpiration - Optional maximum expiration timestamp (ms)
   * @returns Merge result summary
   */
  async mergeCurrency(
    currency: string,
    onProgress?: (progress: EnrichmentProgress) => void,
    minExpiration?: number,
    maxExpiration?: number
  ): Promise<MergeResult> {
    const startTime = Date.now();

    console.log(`\n━━━ Merging ${currency} Options to Parquet ━━━\n`);

    // Get all completed options
    const instrumentNames = this.database.getCompletedOptions(
      currency,
      minExpiration,
      maxExpiration
    );

    if (instrumentNames.length === 0) {
      console.log(`No completed options found.`);
      return {
        currency,
        totalInstruments: 0,
        enrichedInstruments: 0,
        totalTrades: 0,
        duration: 0,
      };
    }

    // Show date filter info if provided
    if (minExpiration || maxExpiration) {
      const formatDate = (ts: number) => new Date(ts).toISOString().split("T")[0];
      if (minExpiration && maxExpiration) {
        console.log(
          `Filtering: ${formatDate(minExpiration!)} to ${formatDate(maxExpiration!)}`
        );
      } else if (minExpiration) {
        console.log(`Filtering: expiring after ${formatDate(minExpiration!)}`);
      } else if (maxExpiration) {
        console.log(`Filtering: expiring before ${formatDate(maxExpiration!)}`);
      }
    }

    console.log(`Found ${instrumentNames.length} completed options\n`);

    // Build global IV history for cross-instrument IV rank
    const globalIVHistory = await this.writer.buildGlobalIVHistory(instrumentNames);

    // Enrich all instruments with global IV rank context
    const results = await this.writer.enrichMultipleInstruments(
      instrumentNames,
      globalIVHistory,
      onProgress
    );

    const totalTrades = results.reduce((sum, r) => sum + r.enrichedTrades, 0);
    const duration = Date.now() - startTime;

    console.log(`\n━━━ Merge Summary ━━━`);
    console.log(`Total instruments: ${instrumentNames.length}`);
    console.log(`Enriched instruments: ${results.length}`);
    console.log(`Total trades: ${totalTrades.toLocaleString()}`);
    console.log(`Duration: ${(duration / 1000).toFixed(2)}s\n`);

    return {
      currency,
      totalInstruments: instrumentNames.length,
      enrichedInstruments: results.length,
      totalTrades,
      duration,
    };
  }

  /**
   * Merge all completed options across all currencies
   *
   * @param currencies - Array of currencies to process (e.g., ["BTC", "ETH", "SOL"])
   * @param onProgress - Optional progress callback
   * @returns Array of merge results per currency
   */
  async mergeAllCurrencies(
    currencies: string[],
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<MergeResult[]> {
    const results: MergeResult[] = [];

    for (const currency of currencies) {
      const result = await this.mergeCurrency(currency, onProgress);
      results.push(result);
    }

    // Overall summary
    const totalInstruments = results.reduce((sum, r) => sum + r.totalInstruments, 0);
    const totalEnriched = results.reduce((sum, r) => sum + r.enrichedInstruments, 0);
    const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);

    console.log(`\n━━━ Overall Summary ━━━`);
    console.log(`Currencies processed: ${currencies.length}`);
    console.log(`Total instruments: ${totalInstruments}`);
    console.log(`Enriched instruments: ${totalEnriched}`);
    console.log(`Total trades: ${totalTrades.toLocaleString()}\n`);

    return results;
  }
}
