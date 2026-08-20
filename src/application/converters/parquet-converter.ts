import parquet from "parquetjs";
import type { Database } from "../../infrastructure/database.ts";
import { JSONLStorage } from "../../infrastructure/jsonl-storage.ts";
import type { DeribitTrade } from "../../domain/models.ts";
import { parseInstrumentName } from "../../domain/models.ts";
import { RAW_TRADE_SCHEMA } from "../../infrastructure/schemas.ts";
import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ParquetConverterConfig {
  database: Database;
  jsonlStorage: JSONLStorage;
  rawOutputDir?: string; // Default: ./data/parquet-raw
}

export interface ConversionProgress {
  instrumentName: string;
  totalTrades: number;
  status: "completed" | "failed" | "skipped";
  startTime: number;
  endTime?: number;
  error?: string;
}

/**
 * ParquetConverter - Stage 2: JSONL → Raw Parquet (Silver Layer)
 *
 * Design Decision:
 * - No enrichment (Greeks, IV rank, etc.) - just raw trade data
 * - Typed, columnar storage for efficient DuckDB queries
 * - Baseline for Stage 3 enrichment pipeline
 * - One raw Parquet file per instrument
 *
 * Memory efficiency:
 * - Processes one instrument at a time
 * - Batched writes to Parquet (1000 rows)
 * - No cross-instrument dependencies
 */
export class ParquetConverter {
  private database: Database;
  private jsonlStorage: JSONLStorage;
  private rawOutputDir: string;

  constructor(config: ParquetConverterConfig) {
    this.database = config.database;
    this.jsonlStorage = config.jsonlStorage;
    this.rawOutputDir = config.rawOutputDir ?? "./data/parquet-raw";
  }

  /**
   * Get output file path for raw Parquet
   */
  private getRawOutputPath(instrumentName: string): string {
    // Organize by underlying currency
    // E.g., BTC-27MAR26-70000-C → data/parquet-raw/BTC/BTC-27MAR26-70000-C.parquet
    const underlying = instrumentName.split("-")[0]!;
    return join(this.rawOutputDir, underlying, `${instrumentName}.parquet`);
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
   * Check if JSONL file has been modified since last conversion
   */
  private needsReconversion(
    jsonlPath: string,
    lastConvertedModTime: number
  ): boolean {
    try {
      const stats = statSync(jsonlPath);
      return stats.mtimeMs > lastConvertedModTime;
    } catch {
      // File doesn't exist or can't be read - needs conversion
      return true;
    }
  }

  /**
   * Convert raw trade to schema-compliant record (no enrichment)
   */
  private convertTrade(
    trade: DeribitTrade,
    instrument: ReturnType<typeof parseInstrumentName>
  ): Record<string, any> {
    const { strike, expiration, optionType } = instrument!;

    // Calculate time to expiry in years
    const timeToExpiry = Math.max(
      0,
      (expiration - trade.timestamp) / (365.25 * 24 * 60 * 60 * 1000)
    );

    return {
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
  }

  /**
   * Convert JSONL trades to raw Parquet for a single instrument
   *
   * @param instrumentName - Instrument to process
   * @returns Conversion progress
   */
  async convertInstrument(instrumentName: string): Promise<ConversionProgress> {
    const startTime = Date.now();

    try {
      // Parse instrument
      const instrument = parseInstrumentName(instrumentName);
      if (!instrument || instrument.instrumentType !== "option") {
        return {
          instrumentName,
          totalTrades: 0,
          status: "failed",
          startTime,
          endTime: Date.now(),
          error: `Invalid option instrument: ${instrumentName}`,
        };
      }

      // Get JSONL path
      const jsonlPath = this.jsonlStorage["getFilePath"](instrumentName);

      // Check if conversion needed
      const existingStatus = this.database.getRawParquetStatus(instrumentName);
      if (existingStatus) {
        const needsUpdate = this.needsReconversion(
          jsonlPath,
          existingStatus.jsonl_last_modified
        );
        if (!needsUpdate) {
          return {
            instrumentName,
            totalTrades: existingStatus.trade_count,
            status: "skipped",
            startTime,
            endTime: Date.now(),
          };
        }
      }

      // Read trades from JSONL
      const trades = await this.jsonlStorage.readTrades(instrumentName);

      if (trades.length === 0) {
        return {
          instrumentName,
          totalTrades: 0,
          status: "skipped",
          startTime,
          endTime: Date.now(),
        };
      }

      // Create output file
      const rawOutputPath = this.getRawOutputPath(instrumentName);
      await this.ensureDir(rawOutputPath);

      // Open Parquet writer
      const writer = await parquet.ParquetWriter.openFile(
        RAW_TRADE_SCHEMA,
        rawOutputPath
      );

      // Write trades in batches
      const batchSize = 1000;
      for (let i = 0; i < trades.length; i += batchSize) {
        const batch = trades.slice(i, i + batchSize);

        for (const trade of batch) {
          const rawRecord = this.convertTrade(trade, instrument);
          await writer.appendRow(rawRecord);
        }
      }

      await writer.close();

      // Get JSONL modification time
      const jsonlModTime = statSync(jsonlPath).mtimeMs;

      // Mark as converted in database
      this.database.markRawParquetConverted(
        instrumentName,
        jsonlPath,
        rawOutputPath,
        trades.length,
        jsonlModTime
      );

      return {
        instrumentName,
        totalTrades: trades.length,
        status: "completed",
        startTime,
        endTime: Date.now(),
      };
    } catch (error) {
      return {
        instrumentName,
        totalTrades: 0,
        status: "failed",
        startTime,
        endTime: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Convert multiple instruments with progress tracking
   *
   * @param instrumentNames - Array of instruments to process
   * @param onProgress - Optional progress callback
   * @returns Array of conversion results
   */
  async convertMultipleInstruments(
    instrumentNames: string[],
    onProgress?: (progress: ConversionProgress) => void
  ): Promise<ConversionProgress[]> {
    const results: ConversionProgress[] = [];

    for (const instrumentName of instrumentNames) {
      const progress = await this.convertInstrument(instrumentName);
      results.push(progress);

      // Fire progress callback
      if (onProgress) {
        onProgress(progress);
      }

      // Log result
      if (progress.status === "completed") {
        const duration = ((progress.endTime! - progress.startTime) / 1000).toFixed(2);
        console.log(
          `  ✓ ${instrumentName}: ${progress.totalTrades} trades converted in ${duration}s`
        );
      } else if (progress.status === "skipped") {
        console.log(`  ⏭️  ${instrumentName} - skipped (already converted)`);
      } else if (progress.status === "failed") {
        console.error(`  ✗ ${instrumentName}: ${progress.error}`);
      }
    }

    return results;
  }

  /**
   * Convert all instruments needing conversion for a currency
   *
   * This checks:
   * 1. Instruments that haven't been converted yet
   * 2. Instruments where JSONL has been modified since last conversion
   *
   * @param currency - Base currency (e.g., "BTC", "ETH")
   * @param onProgress - Optional progress callback
   * @returns Summary statistics
   */
  async convertAllInstruments(
    currency: string,
    onProgress?: (progress: ConversionProgress) => void
  ): Promise<{
    total: number;
    converted: number;
    skipped: number;
    failed: number;
    totalTrades: number;
  }> {
    console.log(`\n━━━ Converting ${currency} Options to Raw Parquet ━━━\n`);

    // Get instruments needing conversion from database
    const instrumentNames = this.database.getInstrumentsNeedingConversion(currency);

    if (instrumentNames.length === 0) {
      console.log(`No instruments need conversion. All up to date!`);
      return { total: 0, converted: 0, skipped: 0, failed: 0, totalTrades: 0 };
    }

    console.log(`Found ${instrumentNames.length} instruments to process\n`);

    const results = await this.convertMultipleInstruments(instrumentNames, onProgress);

    const converted = results.filter((r) => r.status === "completed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const totalTrades = results
      .filter((r) => r.status === "completed")
      .reduce((sum, r) => sum + r.totalTrades, 0);

    return {
      total: instrumentNames.length,
      converted,
      skipped,
      failed,
      totalTrades,
    };
  }
}
