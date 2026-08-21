import { initializeDuckDB, getDuckDBConnection, closeDuckDB, executeSQLQuery, executeSQLStatement } from "../../infrastructure/duckdb-connection.ts";
import { generateGreeksEnrichmentQuery, generateBulkGreeksEnrichmentQuery } from "../../infrastructure/duckdb-greeks.ts";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface DuckDBEnricherConfig {
  inputDir?: string;   // Default: ./data/parquet-raw
  outputDir?: string;  // Default: ./data/parquet-duckdb
  maxMemory?: string;  // Default: 4GB
  threads?: number;    // Default: CPU cores
}

export interface EnrichmentResult {
  instrumentName: string;
  inputFile: string;
  outputFile: string;
  tradeCount: number;
  duration: number;
  error?: string;
}

export interface EnrichmentProgress {
  instrumentName: string;
  currentInstrument: number;
  totalInstruments: number;
  startTime: number;
}

/**
 * DuckDB Enricher - Parallel Greeks Computation using SQL
 *
 * Advantages over TypeScript row-by-row:
 * - Memory efficient: streams instead of loading all data
 * - Parallel: uses all CPU cores automatically
 * - Vectorized: SIMD optimizations in DuckDB
 * - Direct Parquet: no intermediate format
 * - 10-100x faster for large datasets
 */
export class DuckDBEnricher {
  private inputDir: string;
  private outputDir: string;
  private maxMemory: string;
  private threads?: number;

  constructor(config: DuckDBEnricherConfig = {}) {
    this.inputDir = config.inputDir ?? "./data/parquet-raw";
    this.outputDir = config.outputDir ?? "./data/parquet-duckdb";
    this.maxMemory = config.maxMemory ?? "4GB";
    this.threads = config.threads;
  }

  /**
   * Initialize DuckDB with configuration
   */
  async initialize(): Promise<void> {
    await initializeDuckDB({
      maxMemory: this.maxMemory,
      threads: this.threads,
    });
  }

  /**
   * Enrich a single instrument's Parquet file with Greeks
   */
  async enrichInstrument(
    instrumentName: string,
    onProgress?: (progress: Partial<EnrichmentProgress>) => void
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();
    const inputFile = join(this.inputDir, instrumentName.split("-")[0]!, `${instrumentName}.parquet`);
    const outputFile = join(this.outputDir, instrumentName.split("-")[0]!, `${instrumentName}.parquet`);

    try {
      if (onProgress) {
        onProgress({ instrumentName, startTime });
      }

      // Ensure output directory exists
      const outputDir = dirname(outputFile);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Generate enrichment SQL
      const sql = generateGreeksEnrichmentQuery({
        inputPath: inputFile,
        outputPath: outputFile,
      });

      // Execute using DuckDB
      await executeSQLStatement(sql);

      // Count trades in output (DuckDB returns BigInt, convert to number)
      const countSQL = `SELECT COUNT(*) as count FROM read_parquet('${outputFile}')`;
      const countResult = await executeSQLQuery<{ count: bigint | number }>(countSQL);
      const countValue = countResult[0]?.count ?? 0;
      const tradeCount = typeof countValue === 'bigint' ? Number(countValue) : countValue;

      const duration = Date.now() - startTime;

      return {
        instrumentName,
        inputFile,
        outputFile,
        tradeCount,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        instrumentName,
        inputFile,
        outputFile,
        tradeCount: 0,
        duration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Enrich all instruments for a currency - SINGLE FILE OUTPUT
   *
   * NEW ARCHITECTURE:
   * - Input:  data/parquet-raw/BTC/*.parquet (3,478 small files)
   * - Output: data/parquet-duckdb/BTC.parquet (1 large file with all trades)
   *
   * BENEFITS:
   * - Single DuckDB query reads ALL files, computes Greeks, writes once
   * - 10-100x faster than per-file processing
   * - Better compression (across all data)
   * - Optimized for analytics (read one file, not thousands)
   * - Standard data lakehouse pattern
   */
  async enrichCurrency(
    currency: string,
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentResult[]> {
    console.log(`\n━━━ DuckDB Enrichment: ${currency} (Bulk Processing → Single File) ━━━\n`);

    const overallStart = Date.now();
    const inputPattern = join(this.inputDir, currency, "*.parquet");
    const outputFile = join(this.outputDir, `${currency}.parquet`);

    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    try {
      console.log(`Input:  ${inputPattern}`);
      console.log(`Output: ${outputFile}\n`);

      // Count input files/trades first
      console.log(`Scanning input files...`);
      const statsQuery = `
        SELECT
          COUNT(DISTINCT filename) as file_count,
          COUNT(*) as trade_count,
          COUNT(DISTINCT regexp_extract(filename, '/([^/]+)\\.parquet$', 1)) as instrument_count
        FROM read_parquet('${inputPattern}', filename=true)
      `;
      const stats = await executeSQLQuery<{ file_count: bigint, trade_count: bigint, instrument_count: bigint }>(statsQuery);
      const fileCount = Number(stats[0]?.file_count ?? 0);
      const inputTradeCount = Number(stats[0]?.trade_count ?? 0);
      const instrumentCount = Number(stats[0]?.instrument_count ?? 0);

      if (fileCount === 0) {
        console.log(`No Parquet files found matching: ${inputPattern}`);
        return [];
      }

      console.log(`Found ${fileCount} files, ${instrumentCount} instruments, ${inputTradeCount.toLocaleString()} trades`);

      // Check if futures data exists
      const futuresPattern = join(this.inputDir, "..", "futures", `${currency}-*.parquet`);
      const futuresCheckQuery = `SELECT COUNT(*) as count FROM read_parquet('${futuresPattern}')`;
      let hasFuturesData = false;
      try {
        const futuresCheck = await executeSQLQuery<{ count: bigint }>(futuresCheckQuery);
        const futuresCount = Number(futuresCheck[0]?.count ?? 0);
        hasFuturesData = futuresCount > 0;
        if (hasFuturesData) {
          console.log(`✓ Found ${futuresCount.toLocaleString()} futures trades for forward pricing`);
        } else {
          console.log(`⚠️  No futures data found - using spot index price (less accurate)`);
        }
      } catch {
        console.log(`⚠️  No futures data found - using spot index price (less accurate)`);
      }

      console.log(`\nEnriching ALL data in single vectorized SQL query...`);

      // Generate and execute bulk enrichment SQL
      const sql = generateBulkGreeksEnrichmentQuery({
        inputPattern,
        futuresPattern: hasFuturesData ? futuresPattern : undefined,
        outputPath: outputFile,
      });

      await executeSQLStatement(sql);

      // Verify output
      const outputCountQuery = `SELECT COUNT(*) as count FROM read_parquet('${outputFile}')`;
      const outputCount = await executeSQLQuery<{ count: bigint | number }>(outputCountQuery);
      const outputTradeCount = typeof outputCount[0]?.count === 'bigint'
        ? Number(outputCount[0].count)
        : (outputCount[0]?.count ?? 0);

      const duration = Date.now() - overallStart;
      const throughput = Math.round(outputTradeCount / (duration / 1000));

      console.log(`\n━━━ Enrichment Complete ━━━`);
      console.log(`Output file: ${outputFile}`);
      console.log(`Instruments: ${instrumentCount}`);
      console.log(`Total trades: ${outputTradeCount.toLocaleString()}`);
      console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
      console.log(`Throughput: ${throughput.toLocaleString()} trades/sec\n`);

      // Return single result for the currency
      return [{
        instrumentName: currency,
        inputFile: inputPattern,
        outputFile,
        tradeCount: outputTradeCount,
        duration,
      }];
    } catch (error) {
      console.error(`Failed to enrich ${currency}:`, error);
      throw error;
    }
  }

  /**
   * Enrich specific instruments
   */
  async enrichInstruments(
    instrumentNames: string[],
    onProgress?: (progress: EnrichmentProgress) => void
  ): Promise<EnrichmentResult[]> {
    console.log(`\n━━━ DuckDB Enrichment: ${instrumentNames.length} Instruments ━━━\n`);

    const results: EnrichmentResult[] = [];
    const overallStart = Date.now();

    for (let i = 0; i < instrumentNames.length; i++) {
      const instrumentName = instrumentNames[i]!;

      if (onProgress) {
        onProgress({
          instrumentName,
          currentInstrument: i + 1,
          totalInstruments: instrumentNames.length,
          startTime: overallStart,
        });
      }

      console.log(`[${i + 1}/${instrumentNames.length}] Processing ${instrumentName}...`);

      const result = await this.enrichInstrument(instrumentName);

      if (result.error) {
        console.log(`  ✗ Error: ${result.error}`);
      } else {
        console.log(`  ✓ ${result.tradeCount} trades enriched in ${(result.duration / 1000).toFixed(2)}s`);
      }

      results.push(result);
    }

    const totalDuration = (Date.now() - overallStart) / 1000;
    const totalTrades = results.reduce((sum, r) => sum + r.tradeCount, 0);
    const successCount = results.filter(r => !r.error).length;

    console.log(`\n━━━ Enrichment Complete ━━━`);
    console.log(`Instruments: ${successCount}/${instrumentNames.length} successful`);
    console.log(`Total trades: ${totalTrades.toLocaleString()}`);
    console.log(`Duration: ${totalDuration.toFixed(2)}s`);
    console.log(`Throughput: ${(totalTrades / totalDuration).toFixed(0)} trades/sec\n`);

    return results;
  }

  /**
   * Enrich a currency - wrapper method for BunQueue compatibility
   */
  async enrich(
    currency: string,
    inputDir?: string,
    outputDir?: string,
    maxMemory?: string,
    threads?: number
  ): Promise<{ totalTrades: number; successCount: number; failedCount: number }> {
    // Update config if provided
    if (inputDir) this.inputDir = inputDir;
    if (outputDir) this.outputDir = outputDir;
    if (maxMemory) this.maxMemory = maxMemory;
    if (threads !== undefined) this.threads = threads;

    // Initialize DuckDB
    await this.initialize();

    // Enrich all instruments
    const results = await this.enrichCurrency(currency);

    // Cleanup
    await this.cleanup();

    // Return summary
    const totalTrades = results.reduce((sum, r) => sum + r.tradeCount, 0);
    const successCount = results.filter(r => !r.error).length;
    const failedCount = results.filter(r => r.error).length;

    return { totalTrades, successCount, failedCount };
  }

  /**
   * Cleanup DuckDB resources
   */
  async cleanup(): Promise<void> {
    await closeDuckDB();
  }
}
