import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";

/**
 * Max-Seq Filter Integration Tests
 *
 * Tests the --max-seq filtering functionality for both futures and options:
 * 1. Database method filters completed options by trade_count
 * 2. Incomplete options (no trade_count) are NOT filtered
 * 3. Futures can be filtered at preparation phase by last_seq
 */
describe("Max-Seq Filter Integration Tests", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");

    // Insert test instruments
    db.upsertInstruments([
      {
        instrument_name: "BTC-FUTURE-SMALL",
        kind: "future",
        base_currency: "BTC",
        is_active: false,
      },
      {
        instrument_name: "BTC-FUTURE-LARGE",
        kind: "future",
        base_currency: "BTC",
        is_active: false,
      },
      {
        instrument_name: "BTC-OPTION-SMALL",
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-12-31").getTime(),
        strike: 65000,
        option_type: "call",
        is_active: false,
      },
      {
        instrument_name: "BTC-OPTION-LARGE",
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-12-31").getTime(),
        strike: 70000,
        option_type: "call",
        is_active: false,
      },
      {
        instrument_name: "BTC-OPTION-INCOMPLETE",
        kind: "option",
        base_currency: "BTC",
        expiration_timestamp: new Date("2026-12-31").getTime(),
        strike: 75000,
        option_type: "call",
        is_active: false,
      },
    ]);

    // Set last_seq for futures
    db.updateInstrumentLastSeq("BTC-FUTURE-SMALL", 5000000); // 5M trades
    db.updateInstrumentLastSeq("BTC-FUTURE-LARGE", 50000000); // 50M trades

    // Set trade_count for completed options
    db.getOptionProgress("BTC-OPTION-SMALL"); // Creates record
    db.updateOptionProgress("BTC-OPTION-SMALL", 5000000, 5000000, "/path/small.jsonl");
    db.markOptionComplete("BTC-OPTION-SMALL"); // Mark complete

    db.getOptionProgress("BTC-OPTION-LARGE"); // Creates record
    db.updateOptionProgress("BTC-OPTION-LARGE", 50000000, 50000000, "/path/large.jsonl");
    db.markOptionComplete("BTC-OPTION-LARGE"); // Mark complete

    // BTC-OPTION-INCOMPLETE has no progress record (simulates incomplete option)
  });

  afterAll(() => {
    db.close();
  });

  test("getIncompleteOptions returns incomplete options only", () => {
    // No filter - should return only incomplete option
    const allOptions = db.getIncompleteOptions("BTC");
    expect(allOptions.length).toBe(1);
    expect(allOptions).toContain("BTC-OPTION-INCOMPLETE");

    // NOTE: Completed options are NOT included because they have status='completed'
    // The filter is: (op.status IS NULL OR op.status != 'completed')
    // Trade count filtering is now done in OptionFetcher.prepareInstrument()
  });

  test("Database correctly stores last_seq for futures", () => {
    const instruments = db.getInstruments("BTC", "future");
    const smallFuture = instruments.find((i) => i.instrument_name === "BTC-FUTURE-SMALL");
    const largeFuture = instruments.find((i) => i.instrument_name === "BTC-FUTURE-LARGE");

    expect(smallFuture?.last_seq).toBe(5000000);
    expect(largeFuture?.last_seq).toBe(50000000);
  });

  test("Database correctly stores trade_count for options", () => {
    const smallProgress = db.getOptionProgress("BTC-OPTION-SMALL");
    const largeProgress = db.getOptionProgress("BTC-OPTION-LARGE");
    const incompleteProgress = db.getOptionProgress("BTC-OPTION-INCOMPLETE");

    expect(smallProgress.trade_count).toBe(5000000);
    expect(smallProgress.status).toBe("completed");

    expect(largeProgress.trade_count).toBe(50000000);
    expect(largeProgress.status).toBe("completed");

    expect(incompleteProgress.trade_count).toBe(0);
    expect(incompleteProgress.status).not.toBe("completed");
  });

  test("Real-world scenario: Check incomplete BTC options", () => {
    // Use real database to test actual data
    const realDb = new Database("deribit-data.db");

    // Count total incomplete options (filtering now happens in OptionFetcher.fetchInstrument)
    const allOptions = realDb.getIncompleteOptions("BTC");
    console.log(`Total incomplete BTC options: ${allOptions.length}`);

    // NOTE: Trade count filtering is no longer done at database level
    // It's done by OptionFetcher.fetchInstrument() which calls getLastTradeSeq() lazily when each option starts downloading

    expect(allOptions.length).toBeGreaterThan(0);

    realDb.close();
  });

  test("Real-world scenario: Check large futures", () => {
    const realDb = new Database("deribit-data.db");

    // Get all BTC futures with last_seq
    const futures = realDb.getInstruments("BTC", "future");
    const futuresWithSeq = futures.filter((f) => f.last_seq !== null && f.last_seq > 0);

    console.log(`Total BTC futures with last_seq: ${futuresWithSeq.length}`);

    // Count how many would be skipped with 10M threshold
    const largeCount = futuresWithSeq.filter((f) => f.last_seq! > 10000000).length;
    console.log(`Futures with >10M trades: ${largeCount}`);

    expect(futuresWithSeq.length).toBeGreaterThan(0);

    realDb.close();
  });
});
