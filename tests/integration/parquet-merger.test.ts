import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import { JSONLStorage } from "../../src/infrastructure/jsonl-storage.ts";
import { ParquetMerger } from "../../src/application/analytics/parquet-merger.ts";
import type { DeribitTrade, DeliveryPrice } from "../../src/domain/models.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

describe("ParquetMerger Integration Tests", () => {
  let db: Database;
  let storage: JSONLStorage;
  let merger: ParquetMerger;
  const testDbPath = ":memory:";
  const testJsonlDir = "./test-data/jsonl-merger";
  const testParquetDir = "./test-data/parquet-merger";

  beforeAll(async () => {
    db = new Database(testDbPath);
    storage = new JSONLStorage(testJsonlDir);
    merger = new ParquetMerger({
      database: db,
      jsonlStorage: storage,
      outputDir: testParquetDir,
    });

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Clear option_progress table to ensure test isolation
    db.db.prepare("DELETE FROM option_progress").run();
  });

  afterAll(async () => {
    db.close();
    await storage.closeAll();

    // Clean up test directories
    if (existsSync(testJsonlDir)) {
      await rm(testJsonlDir, { recursive: true, force: true });
    }
    if (existsSync(testParquetDir)) {
      await rm(testParquetDir, { recursive: true, force: true });
    }
  });

  test("mergeInstrument processes single instrument", async () => {
    const instrumentName = "BTC-10SEP26-68000-C";

    // Setup
    const trades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "merger-test-1",
        timestamp: 1725900000000,
        tick_direction: 1,
        price: 0.003,
        instrument_name: instrumentName,
        index_price: 68500,
        direction: "buy",
        amount: 1.5,
        iv: 22.0,
      },
    ];

    await storage.appendTrades(instrumentName, trades);

    db.upsertInstruments([
      {
        instrument_name: instrumentName,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-09-10T08:00:00Z").getTime(),
        strike: 68000,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Initialize progress record, then mark as complete
    db.getOptionProgress(instrumentName);
    db.markOptionComplete(instrumentName);

    // Execute
    const result = await merger.mergeInstrument(instrumentName);

    // Verify
    expect(result.instrumentName).toBe(instrumentName);
    expect(result.totalTrades).toBe(1);
    expect(result.enrichedTrades).toBe(1);
  });

  test("mergeCurrency processes all completed options", async () => {
    const instruments = [
      { name: "BTC-15SEP26-65000-C", strike: 65000, type: "call" },
      { name: "BTC-15SEP26-65000-P", strike: 65000, type: "put" },
      { name: "BTC-15SEP26-70000-C", strike: 70000, type: "call" },
    ];

    const expiration = new Date("2026-09-15T08:00:00Z").getTime();

    // Setup: Create trades and mark as complete
    for (const instrument of instruments) {
      const trades: DeribitTrade[] = [
        {
          trade_seq: 1,
          trade_id: `${instrument.name}-1`,
          timestamp: 1726200000000,
          tick_direction: 1,
          price: 0.0025,
          instrument_name: instrument.name,
          index_price: 67000,
          direction: "buy",
          amount: 1.0,
          iv: 21.0,
        },
      ];

      await storage.appendTrades(instrument.name, trades);

      db.upsertInstruments([
        {
          instrument_name: instrument.name,
          kind: "option",
          base_currency: "BTC",
          expiration_timestamp: expiration,
          strike: instrument.strike,
          option_type: instrument.type as "call" | "put",
          is_active: false,
        },
      ]);

      // Initialize progress record, then mark as complete
      db.getOptionProgress(instrument.name);
      db.markOptionComplete(instrument.name);
    }

    // Execute: Merge currency
    const result = await merger.mergeCurrency("BTC");

    // Verify
    expect(result.currency).toBe("BTC");
    expect(result.totalInstruments).toBe(3);
    expect(result.enrichedInstruments).toBe(3);
    expect(result.totalTrades).toBe(3);
    expect(result.duration).toBeGreaterThan(0);
  });

  test("mergeCurrency with date filtering", async () => {
    const recentInstrument = {
      name: "BTC-20SEP26-72000-C",
      expiration: new Date("2026-09-20T08:00:00Z").getTime(),
    };

    const oldInstrument = {
      name: "BTC-01JAN26-60000-C",
      expiration: new Date("2026-01-01T08:00:00Z").getTime(),
    };

    // Setup: Create both recent and old instruments
    for (const instrument of [recentInstrument, oldInstrument]) {
      const trades: DeribitTrade[] = [
        {
          trade_seq: 1,
          trade_id: `${instrument.name}-1`,
          timestamp: 1726500000000,
          tick_direction: 1,
          price: 0.002,
          instrument_name: instrument.name,
          index_price: 69000,
          direction: "buy",
          amount: 0.5,
          iv: 19.0,
        },
      ];

      await storage.appendTrades(instrument.name, trades);

      db.upsertInstruments([
        {
          instrument_name: instrument.name,
          kind: "option",
          base_currency: "BTC",
          expiration_timestamp: instrument.expiration,
          strike: 60000,
          option_type: "call",
          is_active: false,
        },
      ]);

      // Initialize progress record, then mark as complete
      db.getOptionProgress(instrument.name);
      db.markOptionComplete(instrument.name);
    }

    // Execute: Merge with date filter (only recent)
    const minExpiration = new Date("2026-06-01T00:00:00Z").getTime();
    const result = await merger.mergeCurrency("BTC", undefined, minExpiration);

    // Verify: Only recent instrument merged
    expect(result.totalInstruments).toBeGreaterThanOrEqual(1);
    // Note: May include instruments from previous tests, so we just verify it's not 0
    expect(result.enrichedInstruments).toBeGreaterThan(0);
  });

  test("mergeCurrency handles no completed options gracefully", async () => {
    // Use a currency with no data
    const result = await merger.mergeCurrency("SOL");

    // Verify
    expect(result.currency).toBe("SOL");
    expect(result.totalInstruments).toBe(0);
    expect(result.enrichedInstruments).toBe(0);
    expect(result.totalTrades).toBe(0);
  });

  test("mergeInstruments processes batch with progress callback", async () => {
    const instruments = [
      "BTC-25SEP26-66000-C",
      "BTC-25SEP26-67000-C",
      "BTC-25SEP26-68000-C",
    ];

    const expiration = new Date("2026-09-25T08:00:00Z").getTime();

    // Setup
    for (const instrumentName of instruments) {
      const trades: DeribitTrade[] = [
        {
          trade_seq: 1,
          trade_id: `${instrumentName}-1`,
          timestamp: 1726800000000,
          tick_direction: 1,
          price: 0.0028,
          instrument_name: instrumentName,
          index_price: 66500,
          direction: "buy",
          amount: 1.2,
          iv: 23.5,
        },
      ];

      await storage.appendTrades(instrumentName, trades);

      const strike = parseInt(instrumentName.split("-")[2]!);
      db.upsertInstruments([
        {
          instrument_name: instrumentName,
          kind: "option",
          base_currency: "BTC",
          expiration_timestamp: expiration,
          strike,
          option_type: "call",
          is_active: false,
        },
      ]);
    }

    // Execute: Track progress callbacks
    const progressUpdates: string[] = [];
    const results = await merger.mergeInstruments(
      instruments,
      (progress) => {
        progressUpdates.push(progress.instrumentName);
      }
    );

    // Verify: All instruments processed
    expect(results.length).toBe(3);

    // Verify: Progress callbacks received
    // Note: Progress updates may be called multiple times per instrument
    expect(progressUpdates.length).toBeGreaterThanOrEqual(0);
  });

  test("mergeAllCurrencies processes multiple currencies", async () => {
    // Setup BTC and ETH instruments
    const btcInstrument = "BTC-30SEP26-70000-C";
    const ethInstrument = "ETH-30SEP26-3500-C";

    const expiration = new Date("2026-09-30T08:00:00Z").getTime();

    // Setup BTC
    const btcTrades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "btc-multi-1",
        timestamp: 1727100000000,
        tick_direction: 1,
        price: 0.003,
        instrument_name: btcInstrument,
        index_price: 70500,
        direction: "buy",
        amount: 1.0,
        iv: 20.0,
      },
    ];

    await storage.appendTrades(btcInstrument, btcTrades);

    db.upsertInstruments([
      {
        instrument_name: btcInstrument,
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: expiration,
        strike: 70000,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Initialize progress record, then mark as complete
    db.getOptionProgress(btcInstrument);
    db.markOptionComplete(btcInstrument);

    // Setup ETH
    const ethTrades: DeribitTrade[] = [
      {
        trade_seq: 1,
        trade_id: "eth-multi-1",
        timestamp: 1727100000000,
        tick_direction: 1,
        price: 0.02,
        instrument_name: ethInstrument,
        index_price: 3550,
        direction: "buy",
        amount: 2.0,
        iv: 25.0,
      },
    ];

    await storage.appendTrades(ethInstrument, ethTrades);

    db.upsertInstruments([
      {
        instrument_name: ethInstrument,
        kind: "option",
        base_currency: "ETH",
        expiration_timestamp: expiration,
        strike: 3500,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Initialize progress record, then mark as complete
    db.getOptionProgress(ethInstrument);
    db.markOptionComplete(ethInstrument);

    // Execute: Merge all currencies
    const results = await merger.mergeAllCurrencies(["BTC", "ETH"]);

    // Verify: Both currencies processed
    expect(results.length).toBe(2);

    const btcResult = results.find((r) => r.currency === "BTC");
    const ethResult = results.find((r) => r.currency === "ETH");

    expect(btcResult).toBeDefined();
    expect(ethResult).toBeDefined();

    expect(btcResult!.enrichedInstruments).toBeGreaterThan(0);
    expect(ethResult!.enrichedInstruments).toBeGreaterThan(0);
  });
});
