import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import { JSONLStorage } from "../../src/infrastructure/jsonl-storage.ts";
import { ParquetStorage } from "../../src/infrastructure/parquet-storage.ts";
import type { DeribitTrade } from "../../src/domain/models.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Hybrid Storage Integration Tests
 *
 * Tests the complete JSONL → Parquet workflow:
 * 1. Write trades to JSONL during fetch (in-progress)
 * 2. Convert to Parquet when instrument completes
 * 3. Delete JSONL after successful conversion
 * 4. Verify resumability and crash safety
 */
describe("Hybrid Storage Integration Tests", () => {
  let db: Database;
  let jsonlStorage: JSONLStorage;
  let parquetStorage: ParquetStorage;

  const testDbPath = ":memory:";
  const testJsonlDir = "./test-data/hybrid-jsonl";
  const testParquetDir = "./test-data/hybrid-parquet";

  beforeAll(async () => {
    db = new Database(testDbPath);
    jsonlStorage = new JSONLStorage(testJsonlDir);
    parquetStorage = new ParquetStorage({ baseDir: testParquetDir });

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    db.close();
    await jsonlStorage.closeAll();

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  test("Hybrid workflow: JSONL during fetch, Parquet on completion", async () => {
    const instrumentName = "BTC-27MAR26-70000-C";

    // Phase 1: In-progress - write to JSONL
    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "test-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 0.0024,
        mark_price: 0.00246,
        instrument_name: instrumentName,
        index_price: 65150,
        direction: "buy",
        amount: 0.5,
        iv: 19.06,
      },
      {
        trade_seq: 2,
        trade_id: "test-2",
        timestamp: 1723271000000,
        tick_direction: 2,
        price: 0.0025,
        mark_price: 0.00251,
        instrument_name: instrumentName,
        index_price: 65200,
        direction: "sell",
        amount: 1.0,
        iv: 18.5,
      },
    ];

    await jsonlStorage.appendTrades(instrumentName, trades);

    // Verify JSONL exists
    expect(jsonlStorage.fileExists(instrumentName)).toBe(true);
    const jsonlPath = jsonlStorage.getFilePath(instrumentName);
    expect(existsSync(jsonlPath)).toBe(true);

    // Verify trades can be read from JSONL
    const readTrades = await jsonlStorage.readTrades(instrumentName);
    expect(readTrades.length).toBe(2);
    expect(readTrades[0]?.trade_seq).toBe(1);
    expect(readTrades[1]?.trade_seq).toBe(2);

    // Phase 2: Completion - convert to Parquet
    await parquetStorage.writeTrades(instrumentName, readTrades);

    // Verify Parquet exists
    const parquetPath = parquetStorage.getTradeFilePath(instrumentName);
    expect(existsSync(parquetPath)).toBe(true);

    // Verify trades can be read from Parquet
    const parquetTrades = await parquetStorage.readTrades(instrumentName);
    expect(parquetTrades.length).toBe(2);
    expect(parquetTrades[0]?.trade_seq).toBe(1);
    expect(parquetTrades[1]?.trade_seq).toBe(2);

    // Phase 3: Cleanup - delete JSONL
    await jsonlStorage.deleteFile(instrumentName);

    // Verify JSONL deleted
    expect(jsonlStorage.fileExists(instrumentName)).toBe(false);
    expect(existsSync(jsonlPath)).toBe(false);

    // Verify Parquet still exists
    expect(existsSync(parquetPath)).toBe(true);
  });

  test("Resume scenario: append more trades to existing JSONL", async () => {
    const instrumentName = "BTC-15APR26-65000-C";

    // Initial trades (first batch)
    const batch1: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "resume-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 0.0024,
        mark_price: 0.00246,
        instrument_name: instrumentName,
        index_price: 65150,
        direction: "buy",
        amount: 0.5,
        iv: 19.06,
      },
    ];

    await jsonlStorage.appendTrades(instrumentName, batch1);

    // Simulate resume: append more trades
    const batch2: DeribitTrade[] = [
      {
        trade_seq: 2,
        trade_id: "resume-2",
        timestamp: 1723271000000,
        tick_direction: 2,
        price: 0.0025,
        mark_price: 0.00251,
        instrument_name: instrumentName,
        index_price: 65200,
        direction: "sell",
        amount: 1.0,
        iv: 18.5,
      },
    ];

    await jsonlStorage.appendTrades(instrumentName, batch2);

    // Verify both batches in JSONL
    const allTrades = await jsonlStorage.readTrades(instrumentName);
    expect(allTrades.length).toBe(2);
    expect(allTrades[0]?.trade_seq).toBe(1);
    expect(allTrades[1]?.trade_seq).toBe(2);

    // Cleanup
    await jsonlStorage.deleteFile(instrumentName);
  });

  test("Parquet supports futures and perpetuals", async () => {
    const future = "BTC-30JUN17";
    const perpetual = "BTC-PERPETUAL";

    const futureTrades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "future-1",
        timestamp: 1498867200000,
        tick_direction: 1,
        price: 2500,
        mark_price: 2505,
        instrument_name: future,
        index_price: 2498,
        direction: "buy",
        amount: 10,
      },
    ];

    const perpetualTrades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "perp-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 65000,
        mark_price: 65050,
        instrument_name: perpetual,
        index_price: 64998,
        direction: "buy",
        amount: 100,
      },
    ];

    // Write futures
    await parquetStorage.writeTrades(future, futureTrades);
    const futureRead = await parquetStorage.readTrades(future);
    expect(futureRead.length).toBe(1);
    expect(futureRead[0]?.instrument_name).toBe(future);

    // Write perpetuals
    await parquetStorage.writeTrades(perpetual, perpetualTrades);
    const perpetualRead = await parquetStorage.readTrades(perpetual);
    expect(perpetualRead.length).toBe(1);
    expect(perpetualRead[0]?.instrument_name).toBe(perpetual);
  });

  test("Parquet deduplication on appendTrades", async () => {
    const instrumentName = "BTC-20SEP26-72000-C";

    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "dedup-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 0.0024,
        mark_price: 0.00246,
        instrument_name: instrumentName,
        index_price: 65150,
        direction: "buy",
        amount: 0.5,
        iv: 19.06,
      },
      {
        trade_seq: 2,
        trade_id: "dedup-2",
        timestamp: 1723271000000,
        tick_direction: 2,
        price: 0.0025,
        mark_price: 0.00251,
        instrument_name: instrumentName,
        index_price: 65200,
        direction: "sell",
        amount: 1.0,
        iv: 18.5,
      },
    ];

    // First append
    await parquetStorage.appendTrades(instrumentName, trades);

    // Second append with duplicate (trade_seq 2) + new trade
    const moreTrades: DeribitTrade[] = [
      {
        trade_seq: 2, // DUPLICATE
        trade_id: "dedup-2",
        timestamp: 1723271000000,
        tick_direction: 2,
        price: 0.0025,
        mark_price: 0.00251,
        instrument_name: instrumentName,
        index_price: 65200,
        direction: "sell",
        amount: 1.0,
        iv: 18.5,
      },
      {
        trade_seq: 3, // NEW
        trade_id: "dedup-3",
        timestamp: 1723272000000,
        tick_direction: 1,
        price: 0.0026,
        mark_price: 0.00261,
        instrument_name: instrumentName,
        index_price: 65250,
        direction: "buy",
        amount: 0.75,
        iv: 18.8,
      },
    ];

    await parquetStorage.appendTrades(instrumentName, moreTrades);

    // Verify only 3 unique trades (dedup worked)
    const allTrades = await parquetStorage.readTrades(instrumentName);
    expect(allTrades.length).toBe(3);
    expect(allTrades[0]?.trade_seq).toBe(1);
    expect(allTrades[1]?.trade_seq).toBe(2);
    expect(allTrades[2]?.trade_seq).toBe(3);
  });

  test("Empty JSONL deletion works", async () => {
    const instrumentName = "BTC-EMPTY-TEST";

    // Manually create empty JSONL file
    const jsonlPath = jsonlStorage.getFilePath(instrumentName);
    const writer = Bun.file(jsonlPath).writer();
    await writer.end();

    // Verify file exists
    expect(existsSync(jsonlPath)).toBe(true);

    // Delete empty file
    await jsonlStorage.deleteFile(instrumentName);

    // Verify deleted
    expect(existsSync(jsonlPath)).toBe(false);
  });

  test("Parquet writeTrades vs appendTrades behavior", async () => {
    const instrumentName = "BTC-25SEP26-66000-C";

    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "test-1",
        timestamp: 1723270000000,
        tick_direction: 1,
        price: 0.0024,
        mark_price: 0.00246,
        instrument_name: instrumentName,
        index_price: 65150,
        direction: "buy",
        amount: 0.5,
        iv: 19.06,
      },
    ];

    // writeTrades: bulk write (no dedup check)
    await parquetStorage.writeTrades(instrumentName, trades);
    let readTrades = await parquetStorage.readTrades(instrumentName);
    expect(readTrades.length).toBe(1);

    // appendTrades: should deduplicate
    await parquetStorage.appendTrades(instrumentName, trades); // Same trade again
    readTrades = await parquetStorage.readTrades(instrumentName);
    expect(readTrades.length).toBe(1); // Still 1, deduped

    // appendTrades: add new trade
    const newTrade: DeribitTrade = {
      trade_seq: 2,
      trade_id: "test-2",
      timestamp: 1723271000000,
      tick_direction: 2,
      price: 0.0025,
      mark_price: 0.00251,
      instrument_name: instrumentName,
      index_price: 65200,
      direction: "sell",
      amount: 1.0,
      iv: 18.5,
    };

    await parquetStorage.appendTrades(instrumentName, [newTrade]);
    readTrades = await parquetStorage.readTrades(instrumentName);
    expect(readTrades.length).toBe(2); // Now 2 trades
  });
});
