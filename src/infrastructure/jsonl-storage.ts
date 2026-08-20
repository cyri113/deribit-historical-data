import type { DeribitTrade } from "../domain/models.ts";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * JSONL Storage - Append-only trade storage
 *
 * Design Decision #3: JSONL as intermediate layer
 * - One JSONL file per instrument (crash-safe, append-only)
 * - Parquet built in separate step with dedup
 *
 * Design Decision #5: Write order - disk first, DB second
 * - Flush JSONL before updating checkpoint DB
 * - Prefer duplicates over gaps
 */
export class JSONLStorage {
  private readonly dataDir: string;
  private fileHandles: Map<string, Bun.FileSink> = new Map();

  constructor(dataDir: string = "./data/jsonl") {
    this.dataDir = dataDir;
  }

  /**
   * Get the file path for an instrument
   */
  private getFilePath(instrumentName: string): string {
    // Organize by underlying currency
    // E.g., BTC-PERPETUAL → data/jsonl/BTC/BTC-PERPETUAL.jsonl
    // E.g., BTC-27MAR26-70000-C → data/jsonl/BTC/BTC-27MAR26-70000-C.jsonl
    const underlying = instrumentName.split("-")[0]!;
    return join(this.dataDir, underlying, `${instrumentName}.jsonl`);
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
   * Get or create a file sink for an instrument
   * Uses Bun.file().writer() for efficient appending
   */
  private async getSink(instrumentName: string): Promise<Bun.FileSink> {
    let sink = this.fileHandles.get(instrumentName);

    if (!sink) {
      const filePath = this.getFilePath(instrumentName);
      await this.ensureDir(filePath);

      // Create append-mode writer
      const file = Bun.file(filePath);
      sink = file.writer();
      this.fileHandles.set(instrumentName, sink);
    }

    return sink;
  }

  /**
   * Append trades to JSONL file (one line per trade)
   *
   * @param instrumentName - Instrument to write trades for
   * @param trades - Array of trades to append
   */
  async appendTrades(instrumentName: string, trades: DeribitTrade[]): Promise<void> {
    if (trades.length === 0) return;

    const sink = await this.getSink(instrumentName);

    for (const trade of trades) {
      // Write one JSON object per line
      const line = JSON.stringify(trade) + "\n";
      sink.write(line);
    }

    // Flush to ensure data hits disk before checkpoint update
    // (Design Decision #5: disk first, DB second)
    await sink.flush();
  }

  /**
   * Read all trades from a JSONL file
   *
   * @param instrumentName - Instrument to read
   * @returns Array of trades, or empty if file doesn't exist
   */
  async readTrades(instrumentName: string): Promise<DeribitTrade[]> {
    const filePath = this.getFilePath(instrumentName);

    if (!existsSync(filePath)) {
      return [];
    }

    const file = Bun.file(filePath);
    const text = await file.text();

    if (!text.trim()) {
      return [];
    }

    // Parse each line as JSON
    const lines = text.trim().split("\n");
    return lines.map((line) => JSON.parse(line) as DeribitTrade);
  }

  /**
   * Count trades in a JSONL file (without loading all into memory)
   *
   * @param instrumentName - Instrument to count
   * @returns Number of trades (lines) in file
   */
  async countTrades(instrumentName: string): Promise<number> {
    const filePath = this.getFilePath(instrumentName);

    if (!existsSync(filePath)) {
      return 0;
    }

    const file = Bun.file(filePath);
    const text = await file.text();

    if (!text.trim()) {
      return 0;
    }

    return text.trim().split("\n").length;
  }

  /**
   * Check if a JSONL file exists for an instrument
   */
  fileExists(instrumentName: string): boolean {
    return existsSync(this.getFilePath(instrumentName));
  }

  /**
   * Get file size in bytes
   */
  async getFileSize(instrumentName: string): Promise<number> {
    const filePath = this.getFilePath(instrumentName);

    if (!existsSync(filePath)) {
      return 0;
    }

    const file = Bun.file(filePath);
    return file.size;
  }

  /**
   * Close all open file handles
   * Should be called on graceful shutdown
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.fileHandles.values()).map((sink) =>
      sink.end()
    );

    await Promise.all(closePromises);
    this.fileHandles.clear();
  }

  /**
   * Close a specific file handle
   */
  async close(instrumentName: string): Promise<void> {
    const sink = this.fileHandles.get(instrumentName);

    if (sink) {
      await sink.end();
      this.fileHandles.delete(instrumentName);
    }
  }

  /**
   * Delete JSONL file for an instrument
   * Used after successful conversion to Parquet
   *
   * @param instrumentName - Instrument to delete JSONL file for
   */
  async deleteFile(instrumentName: string): Promise<void> {
    // Close file handle first
    await this.close(instrumentName);

    const filePath = this.getFilePath(instrumentName);

    if (existsSync(filePath)) {
      await Bun.file(filePath).delete();
    }
  }

  /**
   * Get stats for all JSONL files
   */
  async getStats(): Promise<Array<{ instrument: string; size: number; tradeCount: number }>> {
    const stats: Array<{ instrument: string; size: number; tradeCount: number }> = [];

    // Recursively find all .jsonl files
    const glob = new Bun.Glob("**/*.jsonl");

    for await (const filePath of glob.scan(this.dataDir)) {
      const fullPath = join(this.dataDir, filePath);
      const file = Bun.file(fullPath);
      const text = await file.text();
      const tradeCount = text.trim() ? text.trim().split("\n").length : 0;

      // Extract instrument name from file path
      const instrument = filePath.replace(/^.*\//, "").replace(".jsonl", "");

      stats.push({
        instrument,
        size: file.size,
        tradeCount,
      });
    }

    return stats;
  }
}
