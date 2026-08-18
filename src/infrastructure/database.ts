import { Database as BunDatabase } from "bun:sqlite";
import type { Trade, DeliveryPrice, Greeks } from "../domain/models.ts";
import { CheckpointManager } from "./checkpoint.ts";

export class Database {
  private db: BunDatabase;
  public checkpoints: CheckpointManager;

  constructor(path: string = "deribit-data.db") {
    this.db = new BunDatabase(path);
    this.initialize();
    this.checkpoints = new CheckpointManager(this.db);
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    // Enable WAL mode for better concurrent access
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA cache_size = -64000"); // 64MB cache

    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        instrument_name TEXT NOT NULL,
        price REAL NOT NULL,
        amount REAL NOT NULL,
        direction TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        index_price REAL NOT NULL,
        mark_price REAL,
        implied_volatility REAL,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS delivery_prices (
        index_name TEXT NOT NULL,
        date INTEGER NOT NULL,
        delivery_price REAL NOT NULL,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (index_name, date)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS greeks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        delta REAL NOT NULL,
        gamma REAL NOT NULL,
        vega REAL NOT NULL,
        theta REAL NOT NULL,
        price REAL NOT NULL,
        underlying_price REAL NOT NULL,
        implied_volatility REAL NOT NULL,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(instrument_name, timestamp)
      )
    `);

    // Create indexes for efficient queries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_trades_instrument_timestamp
      ON trades(instrument_name, timestamp)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp
      ON trades(timestamp)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_delivery_prices_index_date
      ON delivery_prices(index_name, date)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_greeks_instrument_timestamp
      ON greeks(instrument_name, timestamp)
    `);

    // Create checkpoints table for resumable downloads
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_name TEXT NOT NULL,
        last_trade_seq INTEGER NOT NULL,
        last_timestamp INTEGER NOT NULL,
        chunk_start_seq INTEGER,
        chunk_end_seq INTEGER,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(instrument_name, chunk_start_seq, chunk_end_seq)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_instrument
      ON checkpoints(instrument_name)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_status
      ON checkpoints(status)
    `);
  }

  /**
   * Insert trades in bulk using a transaction
   */
  insertTrades(trades: Trade[]): void {
    if (trades.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO trades (
        id, instrument_name, price, amount, direction,
        timestamp, index_price, mark_price, implied_volatility
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((trades: Trade[]) => {
      for (const trade of trades) {
        insert.run(
          trade.id,
          trade.instrumentName,
          trade.price,
          trade.amount,
          trade.direction,
          trade.timestamp,
          trade.indexPrice,
          trade.markPrice ?? null,
          trade.impliedVolatility ?? null
        );
      }
    });

    insertMany(trades);
  }

  /**
   * Insert delivery prices in bulk
   */
  insertDeliveryPrices(deliveryPrices: DeliveryPrice[]): void {
    if (deliveryPrices.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO delivery_prices (index_name, date, delivery_price)
      VALUES (?, ?, ?)
    `);

    const insertMany = this.db.transaction((prices: DeliveryPrice[]) => {
      for (const price of prices) {
        insert.run(price.indexName, price.date, price.deliveryPrice);
      }
    });

    insertMany(deliveryPrices);
  }

  /**
   * Insert greeks in bulk
   */
  insertGreeks(greeks: Greeks[]): void {
    if (greeks.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO greeks (
        instrument_name, timestamp, delta, gamma, vega, theta,
        price, underlying_price, implied_volatility
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((greeksList: Greeks[]) => {
      for (const g of greeksList) {
        insert.run(
          g.instrumentName,
          g.timestamp,
          g.delta,
          g.gamma,
          g.vega,
          g.theta,
          g.price,
          g.underlyingPrice,
          g.impliedVolatility
        );
      }
    });

    insertMany(greeks);
  }

  /**
   * Get all distinct instrument names that have trade data
   */
  getDistinctInstruments(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT instrument_name
      FROM trades
      ORDER BY instrument_name
    `);
    const rows = stmt.all() as Array<{ instrument_name: string }>;
    return rows.map((row) => row.instrument_name);
  }

  /**
   * Get trades for an instrument in a time range
   */
  getTrades(
    instrumentName: string,
    startTimestamp?: number,
    endTimestamp?: number
  ): Trade[] {
    let query = "SELECT * FROM trades WHERE instrument_name = ?";
    const params: (string | number)[] = [instrumentName];

    if (startTimestamp !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTimestamp);
    }

    if (endTimestamp !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTimestamp);
    }

    query += " ORDER BY timestamp ASC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: string;
      instrument_name: string;
      price: number;
      amount: number;
      direction: "buy" | "sell";
      timestamp: number;
      index_price: number;
      mark_price: number | null;
      implied_volatility: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      instrumentName: row.instrument_name,
      price: row.price,
      amount: row.amount,
      direction: row.direction,
      timestamp: row.timestamp,
      indexPrice: row.index_price,
      markPrice: row.mark_price ?? undefined,
      impliedVolatility: row.implied_volatility ?? undefined,
    }));
  }

  /**
   * Get delivery price for an index at a specific date
   */
  getDeliveryPrice(indexName: string, date: number): DeliveryPrice | null {
    const stmt = this.db.prepare(`
      SELECT * FROM delivery_prices
      WHERE index_name = ? AND date = ?
    `);

    const row = stmt.get(indexName, date) as {
      index_name: string;
      date: number;
      delivery_price: number;
    } | null;

    if (!row) return null;

    return {
      indexName: row.index_name,
      date: row.date,
      deliveryPrice: row.delivery_price,
    };
  }

  /**
   * Get delivery price for an instrument at its expiration date
   * Automatically extracts underlying and expiration from instrument name
   *
   * @param instrumentName - e.g., "BTC-17AUG26-63000-C"
   * @returns Delivery price at expiration, or null if not found
   */
  getDeliveryPriceForInstrument(instrumentName: string): DeliveryPrice | null {
    // Parse instrument to get underlying and expiration
    const { parseInstrumentName } = require("../domain/models.ts");
    const instrument = parseInstrumentName(instrumentName);

    if (!instrument || instrument.instrumentType !== "option") {
      return null;
    }

    // Convert underlying (BTC) to index name (btc_usd)
    const indexName = `${instrument.underlying.toLowerCase()}_usd`;

    // Delivery prices are stored at midnight UTC (00:00:00), but options expire at 08:00 UTC
    // So we need to match by date only (YYYY-MM-DD), not exact timestamp
    const expirationDate = new Date(instrument.expiration);
    const dateStart = new Date(Date.UTC(
      expirationDate.getUTCFullYear(),
      expirationDate.getUTCMonth(),
      expirationDate.getUTCDate(),
      0, 0, 0, 0
    )).getTime();

    // Get delivery price at that date
    return this.getDeliveryPrice(indexName, dateStart);
  }

  /**
   * Get all delivery prices for an index
   */
  getDeliveryPrices(indexName: string): DeliveryPrice[] {
    const stmt = this.db.prepare(`
      SELECT * FROM delivery_prices
      WHERE index_name = ?
      ORDER BY date DESC
    `);

    const rows = stmt.all(indexName) as Array<{
      index_name: string;
      date: number;
      delivery_price: number;
    }>;

    return rows.map((row) => ({
      indexName: row.index_name,
      date: row.date,
      deliveryPrice: row.delivery_price,
    }));
  }

  /**
   * Get greeks for an instrument in a time range
   */
  getGreeks(
    instrumentName: string,
    startTimestamp?: number,
    endTimestamp?: number
  ): Greeks[] {
    let query = "SELECT * FROM greeks WHERE instrument_name = ?";
    const params: (string | number)[] = [instrumentName];

    if (startTimestamp !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTimestamp);
    }

    if (endTimestamp !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTimestamp);
    }

    query += " ORDER BY timestamp ASC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      instrument_name: string;
      timestamp: number;
      delta: number;
      gamma: number;
      vega: number;
      theta: number;
      price: number;
      underlying_price: number;
      implied_volatility: number;
    }>;

    return rows.map((row) => ({
      instrumentName: row.instrument_name,
      timestamp: row.timestamp,
      delta: row.delta,
      gamma: row.gamma,
      vega: row.vega,
      theta: row.theta,
      price: row.price,
      underlyingPrice: row.underlying_price,
      impliedVolatility: row.implied_volatility,
    }));
  }

  /**
   * Get distinct instruments from trades
   */
  getInstruments(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT instrument_name FROM trades
      ORDER BY instrument_name
    `);

    const rows = stmt.all() as Array<{ instrument_name: string }>;
    return rows.map((row) => row.instrument_name);
  }

  /**
   * Get trade count for an instrument
   */
  getTradeCount(instrumentName: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trades
      WHERE instrument_name = ?
    `);

    const result = stmt.get(instrumentName) as { count: number };
    return result.count;
  }

  /**
   * Get complete analysis for an instrument (trades + greeks + delivery price)
   *
   * @param instrumentName - Instrument to query
   * @param startTimestamp - Optional start timestamp filter
   * @param endTimestamp - Optional end timestamp filter
   * @returns Object with trades+greeks and shared delivery price
   */
  getCompleteAnalysis(
    instrumentName: string,
    startTimestamp?: number,
    endTimestamp?: number
  ): {
    instrumentName: string;
    deliveryPrice: DeliveryPrice | null;
    trades: Array<Trade & { greeks?: Greeks }>;
  } {
    // Get trades with their greeks
    const trades = this.getTradesWithGreeks(
      instrumentName,
      startTimestamp,
      endTimestamp
    );

    // Get the single delivery price for this instrument (shared by all trades)
    const deliveryPrice = this.getDeliveryPriceForInstrument(instrumentName);

    return {
      instrumentName,
      deliveryPrice,
      trades,
    };
  }

  /**
   * Get trades with their associated greeks (JOIN query)
   *
   * @param instrumentName - Instrument to query
   * @param startTimestamp - Optional start timestamp filter
   * @param endTimestamp - Optional end timestamp filter
   * @returns Array of trades with their greeks (if calculated)
   */
  getTradesWithGreeks(
    instrumentName: string,
    startTimestamp?: number,
    endTimestamp?: number
  ): Array<Trade & { greeks?: Greeks }> {
    let query = `
      SELECT
        t.id,
        t.instrument_name,
        t.price,
        t.amount,
        t.direction,
        t.timestamp,
        t.index_price,
        t.mark_price,
        t.implied_volatility,
        g.delta,
        g.gamma,
        g.vega,
        g.theta,
        g.price as greeks_price,
        g.underlying_price,
        g.implied_volatility as greeks_iv
      FROM trades t
      LEFT JOIN greeks g ON (
        t.instrument_name = g.instrument_name AND
        t.timestamp = g.timestamp
      )
      WHERE t.instrument_name = ?
    `;
    const params: (string | number)[] = [instrumentName];

    if (startTimestamp !== undefined) {
      query += " AND t.timestamp >= ?";
      params.push(startTimestamp);
    }

    if (endTimestamp !== undefined) {
      query += " AND t.timestamp <= ?";
      params.push(endTimestamp);
    }

    query += " ORDER BY t.timestamp ASC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: string;
      instrument_name: string;
      price: number;
      amount: number;
      direction: "buy" | "sell";
      timestamp: number;
      index_price: number;
      mark_price: number | null;
      implied_volatility: number | null;
      delta: number | null;
      gamma: number | null;
      vega: number | null;
      theta: number | null;
      greeks_price: number | null;
      underlying_price: number | null;
      greeks_iv: number | null;
    }>;

    return rows.map((row) => {
      const trade: Trade = {
        id: row.id,
        instrumentName: row.instrument_name,
        price: row.price,
        amount: row.amount,
        direction: row.direction,
        timestamp: row.timestamp,
        indexPrice: row.index_price,
        markPrice: row.mark_price ?? undefined,
        impliedVolatility: row.implied_volatility ?? undefined,
      };

      // Only add greeks if they exist
      if (row.delta !== null) {
        return {
          ...trade,
          greeks: {
            instrumentName: row.instrument_name,
            timestamp: row.timestamp,
            delta: row.delta,
            gamma: row.gamma!,
            vega: row.vega!,
            theta: row.theta!,
            price: row.greeks_price!,
            underlyingPrice: row.underlying_price!,
            impliedVolatility: row.greeks_iv!,
          },
        };
      }

      return trade;
    });
  }

  /**
   * Get all historical (expired) instruments with complete data
   *
   * @param underlying - Filter by underlying (e.g., "BTC"), or undefined for all
   * @param beforeDate - Optional: only instruments expired before this timestamp
   * @returns Array of expired instruments with trades, greeks, and delivery prices
   */
  getHistoricalInstrumentsWithData(
    underlying?: string,
    beforeDate?: number
  ): Array<{
    instrumentName: string;
    strike: number;
    expiration: number;
    optionType: "call" | "put";
    deliveryPrice: DeliveryPrice;
    trades: Array<Trade & { greeks?: Greeks }>;
  }> {
    const { parseInstrumentName } = require("../domain/models.ts");

    // Get all distinct instruments
    const instruments = this.getDistinctInstruments();

    const now = beforeDate ?? Date.now();
    const results: Array<{
      instrumentName: string;
      strike: number;
      expiration: number;
      optionType: "call" | "put";
      deliveryPrice: DeliveryPrice;
      trades: Array<Trade & { greeks?: Greeks }>;
    }> = [];

    for (const instrumentName of instruments) {
      // Parse instrument to check if it's an expired option
      const instrument = parseInstrumentName(instrumentName);

      if (!instrument || instrument.instrumentType !== "option") {
        continue;
      }

      // Skip if not yet expired
      if (instrument.expiration >= now) {
        continue;
      }

      // Skip if doesn't match underlying filter
      if (underlying && instrument.underlying !== underlying.toUpperCase()) {
        continue;
      }

      // Check if we have delivery price (confirms it's truly settled)
      const deliveryPrice = this.getDeliveryPriceForInstrument(instrumentName);
      if (!deliveryPrice) {
        continue;
      }

      // Get all trades with greeks
      const trades = this.getTradesWithGreeks(instrumentName);

      results.push({
        instrumentName,
        strike: instrument.strike,
        expiration: instrument.expiration,
        optionType: instrument.optionType,
        deliveryPrice,
        trades,
      });
    }

    // Sort by expiration date (newest first)
    results.sort((a, b) => b.expiration - a.expiration);

    return results;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get underlying SQLite database (for testing)
   */
  getDB(): BunDatabase {
    return this.db;
  }
}
