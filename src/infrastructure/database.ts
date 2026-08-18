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

    // ========================================
    // Seq-based fetching schema
    // ========================================

    // Instruments table - store metadata fetched from get_instruments
    this.db.run(`
      CREATE TABLE IF NOT EXISTS instruments (
        instrument_name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        expiration_timestamp INTEGER,
        strike REAL,
        option_type TEXT,
        is_active INTEGER NOT NULL,
        settlement_period TEXT,
        last_seq INTEGER,
        fetched_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_instruments_currency_kind
      ON instruments(base_currency, kind)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_instruments_active
      ON instruments(is_active)
    `);

    // Future chunks table - track per-chunk progress for futures
    // Design Decision #2: Pre-allocated chunks for futures
    this.db.run(`
      CREATE TABLE IF NOT EXISTS future_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_name TEXT NOT NULL,
        chunk_start_seq INTEGER NOT NULL,
        chunk_end_seq INTEGER NOT NULL,
        is_done INTEGER NOT NULL DEFAULT 0,
        jsonl_path TEXT,
        trade_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(instrument_name, chunk_start_seq, chunk_end_seq)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_future_chunks_instrument
      ON future_chunks(instrument_name)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_future_chunks_done
      ON future_chunks(is_done)
    `);

    // Option progress table - track streaming progress for options
    // Design Decision #2: Streaming/lazy progress for options
    this.db.run(`
      CREATE TABLE IF NOT EXISTS option_progress (
        instrument_name TEXT PRIMARY KEY,
        last_no INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'in_progress',
        jsonl_path TEXT,
        trade_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_option_progress_status
      ON option_progress(status)
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

  // ========================================
  // Instrument Repository Methods
  // ========================================

  /**
   * Insert or update instruments from get_instruments API
   */
  upsertInstruments(instruments: Array<{
    instrument_name: string;
    kind: string;
    base_currency: string;
    expiration_timestamp?: number;
    strike?: number;
    option_type?: string;
    is_active: boolean;
    settlement_period?: string;
    last_seq?: number;
  }>): void {
    if (instruments.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO instruments (
        instrument_name, kind, base_currency, expiration_timestamp,
        strike, option_type, is_active, settlement_period, last_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertMany = this.db.transaction((instruments: typeof instruments) => {
      for (const inst of instruments) {
        stmt.run(
          inst.instrument_name,
          inst.kind,
          inst.base_currency,
          inst.expiration_timestamp ?? null,
          inst.strike ?? null,
          inst.option_type ?? null,
          inst.is_active ? 1 : 0,
          inst.settlement_period ?? null,
          inst.last_seq ?? null
        );
      }
    });

    upsertMany(instruments);
  }

  /**
   * Update last_seq for an instrument
   */
  updateInstrumentLastSeq(instrumentName: string, lastSeq: number): void {
    const stmt = this.db.prepare(`
      UPDATE instruments SET last_seq = ? WHERE instrument_name = ?
    `);
    stmt.run(lastSeq, instrumentName);
  }

  /**
   * Get instruments by currency and kind
   */
  getInstruments(currency: string, kind?: string, expired?: boolean): Array<{
    instrument_name: string;
    kind: string;
    base_currency: string;
    expiration_timestamp?: number;
    strike?: number;
    option_type?: string;
    is_active: boolean;
    settlement_period?: string;
    last_seq?: number;
  }> {
    let query = `SELECT * FROM instruments WHERE base_currency = ?`;
    const params: any[] = [currency];

    if (kind) {
      query += ` AND kind = ?`;
      params.push(kind);
    }

    if (expired !== undefined) {
      query += ` AND is_active = ?`;
      params.push(expired ? 0 : 1);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      instrument_name: row.instrument_name,
      kind: row.kind,
      base_currency: row.base_currency,
      expiration_timestamp: row.expiration_timestamp,
      strike: row.strike,
      option_type: row.option_type,
      is_active: row.is_active === 1,
      settlement_period: row.settlement_period,
      last_seq: row.last_seq,
    }));
  }

  /**
   * Get a single instrument by name
   */
  getInstrument(instrumentName: string): {
    instrument_name: string;
    kind: string;
    base_currency: string;
    expiration_timestamp?: number;
    strike?: number;
    option_type?: string;
    is_active: boolean;
    settlement_period?: string;
    last_seq?: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT * FROM instruments WHERE instrument_name = ?
    `);
    const row = stmt.get(instrumentName) as any;

    if (!row) return null;

    return {
      instrument_name: row.instrument_name,
      kind: row.kind,
      base_currency: row.base_currency,
      expiration_timestamp: row.expiration_timestamp,
      strike: row.strike,
      option_type: row.option_type,
      is_active: row.is_active === 1,
      settlement_period: row.settlement_period,
      last_seq: row.last_seq,
    };
  }

  // ========================================
  // Future Chunks Repository Methods
  // ========================================

  /**
   * Create chunks for a future instrument
   */
  createFutureChunks(
    instrumentName: string,
    lastSeq: number,
    chunkSize: number = 10000
  ): void {
    const chunks: Array<{ start: number; end: number }> = [];

    // Partition [1, lastSeq] into chunks of chunkSize
    for (let start = 1; start <= lastSeq; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, lastSeq);
      chunks.push({ start, end });
    }

    if (chunks.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO future_chunks (
        instrument_name, chunk_start_seq, chunk_end_seq
      ) VALUES (?, ?, ?)
    `);

    const insertMany = this.db.transaction((chunks: typeof chunks) => {
      for (const chunk of chunks) {
        stmt.run(instrumentName, chunk.start, chunk.end);
      }
    });

    insertMany(chunks);
  }

  /**
   * Get incomplete chunks for a future instrument
   */
  getIncompleteFutureChunks(instrumentName: string): Array<{
    id: number;
    chunk_start_seq: number;
    chunk_end_seq: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, chunk_start_seq, chunk_end_seq
      FROM future_chunks
      WHERE instrument_name = ? AND is_done = 0
      ORDER BY chunk_start_seq ASC
    `);

    const rows = stmt.all(instrumentName) as any[];

    return rows.map((row) => ({
      id: row.id,
      chunk_start_seq: row.chunk_start_seq,
      chunk_end_seq: row.chunk_end_seq,
    }));
  }

  /**
   * Mark a future chunk as complete
   */
  markFutureChunkDone(
    instrumentName: string,
    chunkStartSeq: number,
    chunkEndSeq: number,
    tradeCount: number,
    jsonlPath: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE future_chunks
      SET is_done = 1, trade_count = ?, jsonl_path = ?, updated_at = ?
      WHERE instrument_name = ? AND chunk_start_seq = ? AND chunk_end_seq = ?
    `);

    stmt.run(
      tradeCount,
      jsonlPath,
      Date.now(),
      instrumentName,
      chunkStartSeq,
      chunkEndSeq
    );
  }

  /**
   * Get future chunk stats for an instrument
   */
  getFutureChunkStats(instrumentName: string): {
    total: number;
    done: number;
    pending: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN is_done = 0 THEN 1 ELSE 0 END) as pending
      FROM future_chunks
      WHERE instrument_name = ?
    `);

    const row = stmt.get(instrumentName) as any;

    return {
      total: row.total || 0,
      done: row.done || 0,
      pending: row.pending || 0,
    };
  }

  // ========================================
  // Option Progress Repository Methods
  // ========================================

  /**
   * Get or create option progress record
   */
  getOptionProgress(instrumentName: string): {
    last_no: number;
    status: string;
    trade_count: number;
  } {
    const stmt = this.db.prepare(`
      SELECT last_no, status, trade_count
      FROM option_progress
      WHERE instrument_name = ?
    `);

    let row = stmt.get(instrumentName) as any;

    if (!row) {
      // Create initial record
      const insertStmt = this.db.prepare(`
        INSERT INTO option_progress (instrument_name, last_no, status)
        VALUES (?, 0, 'in_progress')
      `);
      insertStmt.run(instrumentName);

      return { last_no: 0, status: "in_progress", trade_count: 0 };
    }

    return {
      last_no: row.last_no,
      status: row.status,
      trade_count: row.trade_count || 0,
    };
  }

  /**
   * Update option progress (Design Decision #5: MAX guard to prevent rollback)
   */
  updateOptionProgress(
    instrumentName: string,
    lastNo: number,
    tradeCount: number,
    jsonlPath: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE option_progress
      SET last_no = MAX(last_no, ?), trade_count = ?, jsonl_path = ?, updated_at = ?
      WHERE instrument_name = ?
    `);

    stmt.run(lastNo, tradeCount, jsonlPath, Date.now(), instrumentName);
  }

  /**
   * Mark option as complete
   */
  markOptionComplete(instrumentName: string): void {
    const stmt = this.db.prepare(`
      UPDATE option_progress
      SET status = 'completed', updated_at = ?
      WHERE instrument_name = ?
    `);

    stmt.run(Date.now(), instrumentName);
  }

  /**
   * Get all incomplete options
   */
  getIncompleteOptions(currency: string): string[] {
    const stmt = this.db.prepare(`
      SELECT i.instrument_name
      FROM instruments i
      LEFT JOIN option_progress op ON i.instrument_name = op.instrument_name
      WHERE i.base_currency = ?
        AND i.kind = 'option'
        AND (op.status IS NULL OR op.status != 'completed')
    `);

    const rows = stmt.all(currency) as any[];
    return rows.map((row) => row.instrument_name);
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
