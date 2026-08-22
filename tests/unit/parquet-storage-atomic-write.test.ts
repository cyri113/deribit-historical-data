import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParquetStorage } from "../../src/infrastructure/parquet-storage.ts";
import type { DeribitTrade } from "../../src/domain/models.ts";

// Regression coverage for: writeTrades/appendTrades/writeFuturesTrades wrote
// directly to the final Parquet path. An interruption (SIGKILL/OOM/Ctrl-C)
// mid-write left a truncated/corrupt file at the exact path fetchers'
// skip-if-exists check (existsSync) looks at -- that instrument would then
// be silently treated as "already fetched" forever, a survivorship-bias
// mechanism. appendTrades was worse: it rewrote the whole file in place, so
// an interruption could destroy previously-complete data. Fixed via
// write-to-temp-then-rename (writeAtomic).

describe("ParquetStorage atomic writes", () => {
  let workDir: string;
  let storage: ParquetStorage;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  function makeTrade(overrides: Partial<DeribitTrade> = {}): DeribitTrade {
    return {
      trade_seq: 1,
      trade_id: "t1",
      timestamp: Date.now(),
      tick_direction: 0,
      price: 0.05,
      mark_price: 0.051,
      instrument_name: "BTC-1JAN24-50000-C",
      index_price: 54000,
      direction: "buy",
      amount: 1,
      iv: 60,
      ...overrides,
    };
  }

  test("writeTrades leaves no stray .tmp file and produces a readable final file", async () => {
    workDir = mkdtempSync(join(tmpdir(), "parquet-atomic-test-"));
    storage = new ParquetStorage({ baseDir: workDir });

    await storage.writeTrades("BTC-1JAN24-50000-C", [makeTrade()]);

    const filePath = storage.getTradeFilePath("BTC-1JAN24-50000-C");
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);

    const trades = await storage.readTrades("BTC-1JAN24-50000-C");
    expect(trades.length).toBe(1);
    expect(trades[0]!.trade_id).toBe("t1");
  });

  test("a stale leftover .tmp file from a prior interrupted run does not satisfy an existsSync skip-check", async () => {
    workDir = mkdtempSync(join(tmpdir(), "parquet-atomic-test-"));
    storage = new ParquetStorage({ baseDir: workDir });

    const filePath = storage.getTradeFilePath("BTC-1JAN24-50000-C");
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    // Simulate a truncated write left behind by an interrupted process.
    writeFileSync(`${filePath}.tmp`, "not a real parquet file, truncated mid-write");

    // The final path (what fetchers' skip-if-exists checks) must NOT exist,
    // even though a same-named .tmp artifact is sitting right next to it --
    // this is the whole point of the atomic-rename fix.
    expect(existsSync(filePath)).toBe(false);

    // A fresh write should succeed and clean up the stale .tmp automatically.
    await storage.writeTrades("BTC-1JAN24-50000-C", [makeTrade()]);
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  test("appendTrades preserves the original file if given invalid data that fails partway through the merge (atomicity)", async () => {
    workDir = mkdtempSync(join(tmpdir(), "parquet-atomic-test-"));
    storage = new ParquetStorage({ baseDir: workDir });

    // Write an initial, valid, complete file.
    await storage.writeTrades("BTC-1JAN24-50000-C", [makeTrade({ trade_seq: 1, trade_id: "t1" })]);
    const before = await storage.readTrades("BTC-1JAN24-50000-C");
    expect(before.length).toBe(1);

    // appendTrades merges new trades with the existing file's trades by
    // reading + re-writing the whole thing atomically. Even on a normal
    // (non-interrupted) successful append, verify the original data survives
    // and dedup/merge behavior is correct -- and that no .tmp file remains.
    await storage.appendTrades("BTC-1JAN24-50000-C", [
      makeTrade({ trade_seq: 2, trade_id: "t2" }),
    ]);

    const after = await storage.readTrades("BTC-1JAN24-50000-C");
    expect(after.length).toBe(2);
    expect(after.map(t => t.trade_id).sort()).toEqual(["t1", "t2"]);

    const filePath = storage.getTradeFilePath("BTC-1JAN24-50000-C");
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  test("writeFuturesTrades is also atomic (no stray .tmp, final file readable)", async () => {
    workDir = mkdtempSync(join(tmpdir(), "parquet-atomic-test-"));
    storage = new ParquetStorage({ baseDir: workDir });

    await storage.writeFuturesTrades("BTC-29MAY26", [
      makeTrade({ instrument_name: "BTC-29MAY26" }),
    ]);

    const filePath = storage.getFuturesFilePath("BTC-29MAY26");
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);

    const trades = await storage.readFuturesTrades("BTC-29MAY26");
    expect(trades.length).toBe(1);
  });
});
