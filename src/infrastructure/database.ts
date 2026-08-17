import { Database as BunDatabase } from "bun:sqlite";
import type { Trade, DeliveryPrice, Greeks } from "../domain/models.ts";

export class Database {
  private db: BunDatabase;

  constructor(path: string = "deribit-data.db") {
    this.db = new BunDatabase(path);
    this.initialize();
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
