/**
 * Data Associations Tests (Legacy SQLite-Based Architecture)
 *
 * ⚠️ NOTE: These tests verify the legacy SQLite-based data associations.
 * In production, Greeks and moneyness are now computed on-the-fly during
 * JSONL → Parquet merge and stored together with trades in Parquet files.
 *
 * This test suite is maintained to:
 * 1. Verify SQLite database schema integrity
 * 2. Document historical data relationships
 * 3. Test database JOIN queries for backwards compatibility
 *
 * For modern Parquet-based tests, see:
 * - tests/integration/parquet-writer.test.ts
 * - tests/integration/parquet-merger.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import { calculateGreeks } from "../../src/domain/black76.ts";
import type { Trade, DeliveryPrice, Greeks } from "../../src/domain/models.ts";

let db: Database;
const testDbPath = ":memory:";

beforeAll(() => {
  db = new Database(testDbPath);
});

afterAll(() => {
  db.close();
});

test("Data Associations: Instrument → Trades (1:many)", () => {
  const instrumentName = "BTC-17AUG26-60000-C";

  // Create multiple trades for the same instrument
  const trades: Trade[] = [
    {
      id: "trade-1",
      instrumentName,
      price: 0.05,
      amount: 1.0,
      direction: "buy",
      timestamp: 1723800000000,
      indexPrice: 60000,
      impliedVolatility: 0.6,
    },
    {
      id: "trade-2",
      instrumentName,
      price: 0.06,
      amount: 2.0,
      direction: "sell",
      timestamp: 1723810000000,
      indexPrice: 60100,
      impliedVolatility: 0.62,
    },
    {
      id: "trade-3",
      instrumentName,
      price: 0.055,
      amount: 1.5,
      direction: "buy",
      timestamp: 1723820000000,
      indexPrice: 60050,
      impliedVolatility: 0.61,
    },
  ];

  db.insertTrades(trades);

  // Verify: One instrument has many trades
  const fetchedTrades = db.getTrades(instrumentName);
  expect(fetchedTrades.length).toBe(3);
  expect(fetchedTrades[0]!.id).toBe("trade-1");
  expect(fetchedTrades[1]!.id).toBe("trade-2");
  expect(fetchedTrades[2]!.id).toBe("trade-3");
});

test("Data Associations: Trade → Greeks (1:1)", () => {
  const instrumentName = "BTC-17AUG26-60000-C";
  const timestamp = 1723800000000;

  // Each trade has its own greeks calculated at that specific timestamp
  const trade: Trade = {
    id: "trade-greeks-1",
    instrumentName,
    price: 0.05,
    amount: 1.0,
    direction: "buy",
    timestamp,
    indexPrice: 60000,
    impliedVolatility: 0.6,
  };

  db.insertTrades([trade]);

  // Calculate greeks for this specific trade
  const expiration = new Date("2026-08-17T08:00:00Z").getTime();
  const timeToExpiry = (expiration - timestamp) / (1000 * 60 * 60 * 24 * 365);

  const greeks = calculateGreeks(
    60000, // forward price (index price)
    60000, // strike
    timeToExpiry,
    0.6, // IV
    "call"
  );

  const greeksData: Greeks = {
    instrumentName,
    timestamp,
    delta: greeks.delta,
    gamma: greeks.gamma,
    vega: greeks.vega,
    theta: greeks.theta,
    price: trade.price,
    underlyingPrice: trade.indexPrice,
    impliedVolatility: 0.6,
  };

  db.insertGreeks([greeksData]);

  // Verify: Trade has one greeks record
  const fetchedGreeks = db.getGreeks(instrumentName, timestamp, timestamp);
  expect(fetchedGreeks.length).toBe(1);
  expect(fetchedGreeks[0]!.timestamp).toBe(timestamp);
  expect(fetchedGreeks[0]!.delta).toBeCloseTo(greeks.delta, 4);
});

test("Data Associations: Instrument → DeliveryPrice (1:1)", () => {
  const indexName = "btc_usd";
  // Delivery prices are stored at midnight UTC (00:00), not at option expiration time (08:00)
  const expirationDate = new Date("2026-08-17T00:00:00Z").getTime();

  // Insert delivery price at expiration date (midnight)
  const deliveryPrice: DeliveryPrice = {
    indexName,
    date: expirationDate,
    deliveryPrice: 62000,
  };

  db.insertDeliveryPrices([deliveryPrice]);

  // Insert multiple trades for the same instrument - they all share one delivery price
  const instrumentName = "BTC-17AUG26-60000-C";
  const trades: Trade[] = [
    {
      id: "delivery-trade-1",
      instrumentName,
      price: 0.05,
      amount: 1.0,
      direction: "buy",
      timestamp: 1723800000000,
      indexPrice: 60000,
    },
    {
      id: "delivery-trade-2",
      instrumentName,
      price: 0.06,
      amount: 2.0,
      direction: "sell",
      timestamp: 1723810000000,
      indexPrice: 60100,
    },
  ];

  db.insertTrades(trades);

  // Verify: All trades of this instrument share ONE delivery price
  const fetchedDeliveryPrice = db.getDeliveryPriceForInstrument(instrumentName);
  expect(fetchedDeliveryPrice).not.toBeNull();
  expect(fetchedDeliveryPrice!.deliveryPrice).toBe(62000);
  expect(fetchedDeliveryPrice!.indexName).toBe(indexName);
  expect(fetchedDeliveryPrice!.date).toBe(expirationDate);
});

test("Complete Analysis: getTradesWithGreeks JOIN query", () => {
  const instrumentName = "BTC-17AUG26-61000-C";
  const timestamp1 = 1723800000000;
  const timestamp2 = 1723810000000;

  // Insert trades
  const trades: Trade[] = [
    {
      id: "join-trade-1",
      instrumentName,
      price: 0.05,
      amount: 1.0,
      direction: "buy",
      timestamp: timestamp1,
      indexPrice: 61000,
      impliedVolatility: 0.6,
    },
    {
      id: "join-trade-2",
      instrumentName,
      price: 0.06,
      amount: 2.0,
      direction: "sell",
      timestamp: timestamp2,
      indexPrice: 61100,
      impliedVolatility: 0.62,
    },
  ];

  db.insertTrades(trades);

  // Insert greeks only for first trade
  const expiration = new Date("2026-08-17T08:00:00Z").getTime();
  const timeToExpiry = (expiration - timestamp1) / (1000 * 60 * 60 * 24 * 365);

  const greeksCalc = calculateGreeks(61000, 61000, timeToExpiry, 0.6, "call");

  const greeksData: Greeks = {
    instrumentName,
    timestamp: timestamp1,
    delta: greeksCalc.delta,
    gamma: greeksCalc.gamma,
    vega: greeksCalc.vega,
    theta: greeksCalc.theta,
    price: 0.05,
    underlyingPrice: 61000,
    impliedVolatility: 0.6,
  };

  db.insertGreeks([greeksData]);

  // Query with JOIN
  const tradesWithGreeks = db.getTradesWithGreeks(instrumentName);

  expect(tradesWithGreeks.length).toBe(2);

  // First trade should have greeks
  expect(tradesWithGreeks[0]!.id).toBe("join-trade-1");
  expect(tradesWithGreeks[0]!.greeks).toBeDefined();
  expect(tradesWithGreeks[0]!.greeks!.delta).toBeCloseTo(greeksCalc.delta, 4);

  // Second trade should NOT have greeks
  expect(tradesWithGreeks[1]!.id).toBe("join-trade-2");
  expect(tradesWithGreeks[1]!.greeks).toBeUndefined();
});

test("Complete Analysis: getCompleteAnalysis full enrichment", () => {
  const instrumentName = "BTC-17AUG26-62000-C";
  const indexName = "btc_usd";
  // Delivery prices are stored at midnight UTC (00:00), not at option expiration time (08:00)
  const expirationDate = new Date("2026-08-17T00:00:00Z").getTime();
  const timestamp1 = 1723800000000;
  const timestamp2 = 1723810000000;

  // Insert delivery price at midnight
  const deliveryPrice: DeliveryPrice = {
    indexName,
    date: expirationDate,
    deliveryPrice: 63500,
  };
  db.insertDeliveryPrices([deliveryPrice]);

  // Insert trades
  const trades: Trade[] = [
    {
      id: "complete-trade-1",
      instrumentName,
      price: 0.045,
      amount: 1.0,
      direction: "buy",
      timestamp: timestamp1,
      indexPrice: 62000,
      impliedVolatility: 0.55,
    },
    {
      id: "complete-trade-2",
      instrumentName,
      price: 0.05,
      amount: 2.0,
      direction: "sell",
      timestamp: timestamp2,
      indexPrice: 62100,
      impliedVolatility: 0.57,
    },
  ];
  db.insertTrades(trades);

  // Insert greeks for both trades
  const expiration = new Date("2026-08-17T08:00:00Z").getTime();

  for (const trade of trades) {
    const timeToExpiry = (expiration - trade.timestamp) / (1000 * 60 * 60 * 24 * 365);
    const greeksCalc = calculateGreeks(
      trade.indexPrice,
      62000,
      timeToExpiry,
      trade.impliedVolatility!,
      "call"
    );

    const greeksData: Greeks = {
      instrumentName,
      timestamp: trade.timestamp,
      delta: greeksCalc.delta,
      gamma: greeksCalc.gamma,
      vega: greeksCalc.vega,
      theta: greeksCalc.theta,
      price: trade.price,
      underlyingPrice: trade.indexPrice,
      impliedVolatility: trade.impliedVolatility!,
    };

    db.insertGreeks([greeksData]);
  }

  // Get complete analysis
  const analysis = db.getCompleteAnalysis(instrumentName);

  // Verify structure
  expect(analysis.instrumentName).toBe(instrumentName);

  // Verify delivery price (shared by all trades)
  expect(analysis.deliveryPrice).not.toBeNull();
  expect(analysis.deliveryPrice!.deliveryPrice).toBe(63500);

  // Verify trades with greeks
  expect(analysis.trades.length).toBe(2);
  expect(analysis.trades[0]!.greeks).toBeDefined();
  expect(analysis.trades[1]!.greeks).toBeDefined();

  // Verify greeks are different for each trade (1:1 relationship)
  expect(analysis.trades[0]!.greeks!.delta).not.toBe(analysis.trades[1]!.greeks!.delta);
});

test("Edge Case: Non-option instrument has no delivery price", () => {
  const instrumentName = "BTC-PERPETUAL";

  const trade: Trade = {
    id: "perp-trade-1",
    instrumentName,
    price: 62000,
    amount: 1.0,
    direction: "buy",
    timestamp: 1723800000000,
    indexPrice: 62000,
  };

  db.insertTrades([trade]);

  // Perpetuals should not have delivery prices
  const deliveryPrice = db.getDeliveryPriceForInstrument(instrumentName);
  expect(deliveryPrice).toBeNull();

  // Complete analysis should still work
  const analysis = db.getCompleteAnalysis(instrumentName);
  expect(analysis.deliveryPrice).toBeNull();
  expect(analysis.trades.length).toBe(1);
});
