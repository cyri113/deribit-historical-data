import parquet from "parquetjs";
import { DELIVERY_PRICE_SCHEMA, HISTORICAL_VOLATILITY_SCHEMA, INSTRUMENT_SCHEMA, RAW_TRADE_SCHEMA, FUTURES_TRADE_SCHEMA } from "./schemas.ts";
import type { DeribitTrade, DeribitDeliveryPrice, DeribitInstrument, DeribitHistoricalVolatility } from "../domain/models.ts";
import { parseInstrumentName } from "../domain/models.ts";
import { mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * ParquetStorage - Silver Layer Storage (Direct Parquet Ingestion)
 *
 * Replaces JSONL + SQLite with pure Parquet storage.
 * Writes data directly from API to Parquet files.
 */

export interface ParquetStorageConfig {
  baseDir?: string; // Default: ./data/bronze
}

export class ParquetStorage {
  private baseDir: string;

  constructor(config?: ParquetStorageConfig) {
    this.baseDir = config?.baseDir ?? "./data/bronze";
  }

  /**
   * Ensure directory exists
   */
  private async ensureDir(filePath: string): Promise<void> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Write a Parquet file atomically: write to a `.tmp` sibling path, then
   * rename into place only after the writer closes successfully.
   *
   * Without this, a fetch interrupted mid-write (SIGKILL, OOM, power loss,
   * Ctrl-C) while `writer.appendRow`/`writer.close()` is still running for a
   * large instrument (10,000+ rows) leaves a truncated/corrupt file at the
   * exact path fetchers' skip-if-exists check looks at (`existsSync`) --
   * that instrument is then silently treated as "already fetched" and
   * permanently skipped on every future run, a survivorship-bias mechanism
   * indistinguishable from a legitimately-complete file. A `rename` is
   * atomic on the same filesystem, so a reader/skip-check never observes a
   * partially-written final file: it's either absent (interrupted, will
   * retry) or complete (rename only happens after `close()` succeeds).
   *
   * If a stale `.tmp` file from a prior interrupted run exists at this path,
   * it's removed before starting -- it's dead partial data, not something to
   * resume from (parquetjs has no true append/resume support; see
   * appendTrades below).
   */
  private async writeAtomic(
    filePath: string,
    write: (tempPath: string) => Promise<void>
  ): Promise<void> {
    const tempPath = `${filePath}.tmp`;

    if (existsSync(tempPath)) {
      await unlink(tempPath);
    }

    try {
      await write(tempPath);
      await rename(tempPath, filePath);
    } catch (error) {
      // Clean up the partial temp file so it can't be mistaken for a
      // resumable/complete artifact on a later run.
      if (existsSync(tempPath)) {
        await unlink(tempPath).catch(() => {});
      }
      throw error;
    }
  }

  // ========================================
  // Trade Storage (Option/Future)
  // ========================================

  /**
   * Get trade file path
   */
  getTradeFilePath(instrumentName: string): string {
    // E.g., BTC-27MAR26-70000-C → data/bronze/instruments/BTC/BTC-27MAR26-70000-C.parquet
    const underlying = instrumentName.split("-")[0]!;
    return join(this.baseDir, "instruments", underlying, `${instrumentName}.parquet`);
  }

  /**
   * Write trades to Parquet file (bulk write, no append logic)
   * Used for JSONL → Parquet conversion where we write all trades at once
   *
   * @param instrumentName - Instrument to write trades for
   * @param trades - Array of trades to write
   */
  async writeTrades(instrumentName: string, trades: DeribitTrade[]): Promise<void> {
    if (trades.length === 0) return;

    const filePath = this.getTradeFilePath(instrumentName);
    await this.ensureDir(filePath);

    // Parse instrument metadata once
    const instrument = parseInstrumentName(instrumentName);
    if (!instrument) {
      throw new Error(`Invalid instrument: ${instrumentName}`);
    }

    // For futures/perpetuals, some fields are null
    const strike = instrument.instrumentType === "option" ? instrument.strike : null;
    const expiration = instrument.instrumentType !== "perpetual" ? instrument.expiration : null;
    const optionType = instrument.instrumentType === "option" ? instrument.optionType : null;

    // Write all trades to file atomically (temp path, rename on success) --
    // see writeAtomic doc comment for why this matters for this dataset.
    await this.writeAtomic(filePath, async (tempPath) => {
      const writer = await parquet.ParquetWriter.openFile(RAW_TRADE_SCHEMA, tempPath);

      for (const trade of trades) {
        const timeToExpiry = expiration
          ? Math.max(0, (expiration - trade.timestamp) / (365.25 * 24 * 60 * 60 * 1000))
          : null;

        await writer.appendRow({
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
        });
      }

      await writer.close();
    });
  }

  /**
   * Append trades to Parquet file
   *
   * NOTE: parquetjs doesn't support true append mode - it overwrites files.
   * So we read existing trades, merge with new ones, and rewrite the entire file.
   *
   * @param instrumentName - Instrument to write trades for
   * @param trades - Array of trades to append
   */
  async appendTrades(instrumentName: string, trades: DeribitTrade[]): Promise<void> {
    if (trades.length === 0) return;

    const filePath = this.getTradeFilePath(instrumentName);
    await this.ensureDir(filePath);

    // Parse instrument metadata once
    const instrument = parseInstrumentName(instrumentName);
    if (!instrument) {
      throw new Error(`Invalid instrument: ${instrumentName}`);
    }

    // For futures/perpetuals, some fields are null
    const strike = instrument.instrumentType === "option" ? instrument.strike : null;
    const expiration = instrument.instrumentType !== "perpetual" ? instrument.expiration : null;
    const optionType = instrument.instrumentType === "option" ? instrument.optionType : null;

    // Merge with existing trades if file exists
    let allTrades = trades;

    if (existsSync(filePath)) {
      // Read existing trades
      const existingTrades = await this.readTrades(instrumentName);

      // Create a Set of existing trade_seqs for deduplication
      const existingSeqs = new Set(existingTrades.map(t => t.trade_seq));

      // Filter out any duplicates from new trades
      const newUniqueTrades = trades.filter(t => !existingSeqs.has(t.trade_seq));

      // Merge and sort by trade_seq
      allTrades = [...existingTrades, ...newUniqueTrades].sort((a, b) => a.trade_seq - b.trade_seq);
    }

    // Write all trades to file atomically. This matters even more here than
    // in writeTrades: appendTrades rewrites the WHOLE file (existing +
    // merged trades) at the same path parquetjs would otherwise open
    // in-place, so an interruption mid-write wouldn't just leave a truncated
    // new file -- without atomic replace it would DESTROY the previously-
    // complete existing data it just read via readTrades() above, replacing
    // it with a partial rewrite. Writing to a temp path and renaming only on
    // success means an interruption leaves the original file untouched.
    await this.writeAtomic(filePath, async (tempPath) => {
      const writer = await parquet.ParquetWriter.openFile(RAW_TRADE_SCHEMA, tempPath);

      for (const trade of allTrades) {
        const timeToExpiry = expiration
          ? Math.max(0, (expiration - trade.timestamp) / (365.25 * 24 * 60 * 60 * 1000))
          : null;

        await writer.appendRow({
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
        });
      }

      await writer.close();
    });
  }

  /**
   * Read trades from Parquet file
   */
  async readTrades(instrumentName: string): Promise<DeribitTrade[]> {
    const filePath = this.getTradeFilePath(instrumentName);

    if (!existsSync(filePath)) {
      return [];
    }

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();

    const trades: DeribitTrade[] = [];
    let row = await cursor.next();

    while (row) {
      trades.push({
        trade_id: row.trade_id,
        trade_seq: Number(row.trade_seq), // Convert BigInt to number
        instrument_name: row.instrument_name,
        timestamp: row.timestamp instanceof Date ? row.timestamp.getTime() : row.timestamp,
        price: row.price,
        amount: row.amount,
        direction: row.direction as "buy" | "sell",
        tick_direction: row.tick_direction,
        index_price: row.index_price,
        mark_price: row.mark_price ?? undefined,
        iv: row.implied_volatility ?? undefined,
      });

      row = await cursor.next();
    }

    await reader.close();
    return trades;
  }

  // ========================================
  // Futures Trade Storage (for Forward Prices)
  // ========================================

  /**
   * Get futures trade file path
   */
  getFuturesFilePath(instrumentName: string): string {
    // E.g., BTC-10AUG26 → data/bronze/futures/BTC-10AUG26.parquet
    return join(this.baseDir, "futures", `${instrumentName}.parquet`);
  }

  /**
   * Check if futures trades exist for an instrument
   */
  async futuresExist(instrumentName: string): Promise<boolean> {
    const filePath = this.getFuturesFilePath(instrumentName);
    return existsSync(filePath);
  }

  /**
   * Write futures trades to Parquet file
   */
  async writeFuturesTrades(
    instrumentName: string,
    trades: DeribitTrade[]
  ): Promise<void> {
    if (trades.length === 0) return;

    const filePath = this.getFuturesFilePath(instrumentName);
    await this.ensureDir(filePath);

    await this.writeAtomic(filePath, async (tempPath) => {
      const writer = await parquet.ParquetWriter.openFile(FUTURES_TRADE_SCHEMA, tempPath);

      for (const trade of trades) {
        await writer.appendRow({
          trade_id: trade.trade_id,
          trade_seq: trade.trade_seq,
          instrument_name: trade.instrument_name,
          timestamp: trade.timestamp,
          price: trade.price, // This is the forward price!
          amount: trade.amount,
          direction: trade.direction,
          tick_direction: trade.tick_direction,
          index_price: trade.index_price,
          mark_price: trade.mark_price ?? null,
        });
      }

      await writer.close();
    });
  }

  /**
   * Read futures trades from Parquet file
   */
  async readFuturesTrades(instrumentName: string): Promise<DeribitTrade[]> {
    const filePath = this.getFuturesFilePath(instrumentName);

    if (!existsSync(filePath)) {
      return [];
    }

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();

    const trades: DeribitTrade[] = [];
    let row = await cursor.next();

    while (row) {
      trades.push({
        trade_id: row.trade_id,
        trade_seq: Number(row.trade_seq),
        instrument_name: row.instrument_name,
        timestamp: row.timestamp,
        price: row.price,
        amount: row.amount,
        direction: row.direction as "buy" | "sell",
        tick_direction: row.tick_direction,
        index_price: row.index_price,
        mark_price: row.mark_price ?? undefined,
      });

      row = await cursor.next();
    }

    await reader.close();
    return trades;
  }

  // ========================================
  // Delivery Price Storage
  // ========================================

  /**
   * Get delivery price file path
   */
  private getDeliveryFilePath(indexName: string): string {
    // E.g., btc_usd → data/bronze/deliveries/btc_usd.parquet
    return join(this.baseDir, "deliveries", `${indexName}.parquet`);
  }

  /**
   * Write delivery prices to Parquet file
   *
   * @param indexName - Index name (e.g., "btc_usd")
   * @param deliveryPrices - Array of delivery prices
   */
  async writeDeliveryPrices(
    indexName: string,
    deliveryPrices: DeribitDeliveryPrice[]
  ): Promise<void> {
    if (deliveryPrices.length === 0) return;

    const filePath = this.getDeliveryFilePath(indexName);
    await this.ensureDir(filePath);

    const writer = await parquet.ParquetWriter.openFile(DELIVERY_PRICE_SCHEMA, filePath);

    for (const dp of deliveryPrices) {
      // Parse date to timestamp (midnight UTC)
      const timestamp = new Date(dp.date + "T00:00:00.000Z").getTime();

      await writer.appendRow({
        index_name: indexName,
        date: dp.date,
        delivery_price: dp.delivery_price,
        timestamp,
      });
    }

    await writer.close();
  }

  /**
   * Read delivery prices from Parquet file
   */
  async readDeliveryPrices(indexName: string): Promise<Array<{
    index_name: string;
    date: string;
    delivery_price: number;
    timestamp: number;
  }>> {
    const filePath = this.getDeliveryFilePath(indexName);

    if (!existsSync(filePath)) {
      return [];
    }

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();

    const deliveryPrices: Array<{
      index_name: string;
      date: string;
      delivery_price: number;
      timestamp: number;
    }> = [];

    let row = await cursor.next();

    while (row) {
      deliveryPrices.push({
        index_name: row.index_name,
        date: row.date,
        delivery_price: row.delivery_price,
        timestamp: row.timestamp instanceof Date ? row.timestamp.getTime() : row.timestamp,
      });

      row = await cursor.next();
    }

    await reader.close();
    return deliveryPrices;
  }

  // ========================================
  // Historical Volatility Storage
  // ========================================

  /**
   * Get historical volatility file path
   */
  private getHistoricalVolatilityFilePath(currency: string): string {
    // E.g., BTC → data/bronze/volatility/BTC.parquet
    return join(this.baseDir, "volatility", `${currency}.parquet`);
  }

  /**
   * Write historical volatility data to Parquet file
   *
   * @param currency - Currency (e.g., "BTC", "ETH")
   * @param volatilityData - Array of [timestamp, value] tuples
   */
  async writeHistoricalVolatility(
    currency: string,
    volatilityData: DeribitHistoricalVolatility[]
  ): Promise<void> {
    if (volatilityData.length === 0) return;

    const filePath = this.getHistoricalVolatilityFilePath(currency);
    await this.ensureDir(filePath);

    const writer = await parquet.ParquetWriter.openFile(HISTORICAL_VOLATILITY_SCHEMA, filePath);

    for (const [timestamp, value] of volatilityData) {
      await writer.appendRow({
        currency,
        timestamp,
        volatility_value: value,
      });
    }

    await writer.close();
  }

  /**
   * Read historical volatility data from Parquet file
   */
  async readHistoricalVolatility(currency: string): Promise<Array<{
    currency: string;
    timestamp: number;
    volatility_value: number;
  }>> {
    const filePath = this.getHistoricalVolatilityFilePath(currency);

    if (!existsSync(filePath)) {
      return [];
    }

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();

    const volatilityData: Array<{
      currency: string;
      timestamp: number;
      volatility_value: number;
    }> = [];

    let row = await cursor.next();

    while (row) {
      volatilityData.push({
        currency: row.currency,
        timestamp: row.timestamp instanceof Date ? row.timestamp.getTime() : row.timestamp,
        volatility_value: row.volatility_value,
      });

      row = await cursor.next();
    }

    await reader.close();
    return volatilityData;
  }

  // ========================================
  // Instrument Storage
  // ========================================

  /**
   * Get instrument file path
   */
  private getInstrumentFilePath(currency: string): string {
    // E.g., BTC → data/parquet-raw/instruments/BTC.parquet
    return join(this.baseDir, "instruments", `${currency}.parquet`);
  }

  /**
   * Write instruments to Parquet file
   *
   * @param currency - Base currency (e.g., "BTC", "ETH")
   * @param instruments - Array of instruments
   */
  async writeInstruments(
    currency: string,
    instruments: DeribitInstrument[]
  ): Promise<void> {
    if (instruments.length === 0) return;

    const filePath = this.getInstrumentFilePath(currency);
    await this.ensureDir(filePath);

    const writer = await parquet.ParquetWriter.openFile(INSTRUMENT_SCHEMA, filePath);

    for (const inst of instruments) {
      await writer.appendRow({
        instrument_name: inst.instrument_name,
        kind: inst.kind,
        base_currency: inst.base_currency,
        expiration_timestamp: inst.expiration_timestamp ?? null,
        strike: inst.strike ?? null,
        option_type: inst.option_type ?? null,
        is_active: inst.is_active ?? null,
        settlement_period: inst.settlement_period ?? null,
      });
    }

    await writer.close();
  }

  /**
   * Read instruments from Parquet file
   */
  async readInstruments(currency: string): Promise<DeribitInstrument[]> {
    const filePath = this.getInstrumentFilePath(currency);

    if (!existsSync(filePath)) {
      return [];
    }

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();

    const instruments: DeribitInstrument[] = [];
    let row = await cursor.next();

    while (row) {
      instruments.push({
        instrument_name: row.instrument_name,
        kind: row.kind,
        base_currency: row.base_currency,
        expiration_timestamp: row.expiration_timestamp ?? undefined,
        strike: row.strike ?? undefined,
        option_type: row.option_type ?? undefined,
        is_active: row.is_active ?? undefined,
        settlement_period: row.settlement_period ?? undefined,
      });

      row = await cursor.next();
    }

    await reader.close();
    return instruments;
  }
}
