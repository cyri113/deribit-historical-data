import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";
import type { Trade, DeliveryPrice, Greeks } from "../../src/domain/models.ts";
import { unlink } from "node:fs/promises";

describe("Database Integration Tests", () => {
  let db: Database;
  const testDbPath = ":memory:"; // Use in-memory database for tests

  beforeEach(() => {
    db = new Database(testDbPath);
  });

  afterEach(() => {
    db.close();
  });

  describe("Trades", () => {
    test("Insert and retrieve single trade", () => {
      const trade: Trade = {
        id: "test-trade-1",
        instrumentName: "BTC-29MAR24-50000-C",
        price: 2500,
        amount: 0.5,
        direction: "buy",
        timestamp: Date.now(),
        indexPrice: 52000,
        markPrice: 2550,
        impliedVolatility: 0.8,
      };

      db.insertTrades([trade]);

      const trades = db.getTrades("BTC-29MAR24-50000-C");
      expect(trades).toHaveLength(1);
      expect(trades[0]?.id).toBe("test-trade-1");
      expect(trades[0]?.price).toBe(2500);
    });

    test("Insert multiple trades in batch", () => {
      const trades: Trade[] = Array.from({ length: 100 }, (_, i) => ({
        id: `trade-${i}`,
        instrumentName: "ETH-29MAR24-3000-P",
        price: 150 + i,
        amount: 1.0,
        direction: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
        timestamp: Date.now() + i * 1000,
        indexPrice: 3100,
        impliedVolatility: 0.7,
      }));

      db.insertTrades(trades);

      const retrieved = db.getTrades("ETH-29MAR24-3000-P");
      expect(retrieved).toHaveLength(100);
    });

    test("Filter trades by timestamp range", () => {
      const baseTime = Date.now();
      const trades: Trade[] = Array.from({ length: 10 }, (_, i) => ({
        id: `trade-${i}`,
        instrumentName: "BTC-PERPETUAL",
        price: 50000 + i,
        amount: 1.0,
        direction: "buy" as const,
        timestamp: baseTime + i * 60000, // 1 minute apart
        indexPrice: 50000,
      }));

      db.insertTrades(trades);

      // Get trades from 3rd to 7th minute
      const filtered = db.getTrades(
        "BTC-PERPETUAL",
        baseTime + 3 * 60000,
        baseTime + 7 * 60000
      );

      expect(filtered).toHaveLength(5); // Trades 3, 4, 5, 6, 7
    });

    test("Upsert replaces existing trade", () => {
      const trade1: Trade = {
        id: "duplicate-id",
        instrumentName: "BTC-29MAR24-50000-C",
        price: 1000,
        amount: 1.0,
        direction: "buy",
        timestamp: Date.now(),
        indexPrice: 50000,
      };

      const trade2: Trade = {
        ...trade1,
        price: 2000, // Updated price
      };

      db.insertTrades([trade1]);
      db.insertTrades([trade2]);

      const trades = db.getTrades("BTC-29MAR24-50000-C");
      expect(trades).toHaveLength(1);
      expect(trades[0]?.price).toBe(2000);
    });

    test("Get trade count", () => {
      const trades: Trade[] = Array.from({ length: 50 }, (_, i) => ({
        id: `trade-${i}`,
        instrumentName: "SOL-29MAR24-100-C",
        price: 10 + i,
        amount: 1.0,
        direction: "buy" as const,
        timestamp: Date.now() + i,
        indexPrice: 110,
      }));

      db.insertTrades(trades);

      const count = db.getTradeCount("SOL-29MAR24-100-C");
      expect(count).toBe(50);
    });
  });

  describe("Delivery Prices", () => {
    test("Insert and retrieve delivery price", () => {
      const delivery: DeliveryPrice = {
        indexName: "btc_usd",
        date: Date.UTC(2024, 2, 29, 8, 0, 0),
        deliveryPrice: 65000,
      };

      db.insertDeliveryPrices([delivery]);

      const retrieved = db.getDeliveryPrice("btc_usd", delivery.date);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.deliveryPrice).toBe(65000);
    });

    test("Insert multiple delivery prices in batch", () => {
      const deliveries: DeliveryPrice[] = Array.from({ length: 30 }, (_, i) => ({
        indexName: "eth_usd",
        date: Date.UTC(2024, 2, i + 1, 8, 0, 0),
        deliveryPrice: 3000 + i * 50,
      }));

      db.insertDeliveryPrices(deliveries);

      const all = db.getDeliveryPrices("eth_usd");
      expect(all).toHaveLength(30);
    });

    test("Upsert replaces existing delivery price", () => {
      const date = Date.UTC(2024, 2, 29, 8, 0, 0);

      const delivery1: DeliveryPrice = {
        indexName: "btc_usd",
        date,
        deliveryPrice: 60000,
      };

      const delivery2: DeliveryPrice = {
        indexName: "btc_usd",
        date,
        deliveryPrice: 65000, // Corrected price
      };

      db.insertDeliveryPrices([delivery1]);
      db.insertDeliveryPrices([delivery2]);

      const retrieved = db.getDeliveryPrice("btc_usd", date);
      expect(retrieved?.deliveryPrice).toBe(65000);
    });

    test("Different indices are stored separately", () => {
      const btcDelivery: DeliveryPrice = {
        indexName: "btc_usd",
        date: Date.UTC(2024, 2, 29, 8, 0, 0),
        deliveryPrice: 65000,
      };

      const ethDelivery: DeliveryPrice = {
        indexName: "eth_usd",
        date: Date.UTC(2024, 2, 29, 8, 0, 0),
        deliveryPrice: 3500,
      };

      db.insertDeliveryPrices([btcDelivery, ethDelivery]);

      const btcRetrieved = db.getDeliveryPrices("btc_usd");
      const ethRetrieved = db.getDeliveryPrices("eth_usd");

      expect(btcRetrieved).toHaveLength(1);
      expect(ethRetrieved).toHaveLength(1);
      expect(btcRetrieved[0]?.deliveryPrice).toBe(65000);
      expect(ethRetrieved[0]?.deliveryPrice).toBe(3500);
    });
  });

  describe("Greeks", () => {
    test("Insert and retrieve greeks", () => {
      const greeks: Greeks = {
        instrumentName: "BTC-29MAR24-50000-C",
        timestamp: Date.now(),
        delta: 0.55,
        gamma: 0.00015,
        vega: 45.5,
        theta: -12.3,
        price: 2500,
        underlyingPrice: 52000,
        impliedVolatility: 0.8,
      };

      db.insertGreeks([greeks]);

      const retrieved = db.getGreeks("BTC-29MAR24-50000-C");
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]?.delta).toBeCloseTo(0.55, 5);
    });

    test("Insert multiple greeks in batch", () => {
      const greeksList: Greeks[] = Array.from({ length: 200 }, (_, i) => ({
        instrumentName: "ETH-29MAR24-3000-P",
        timestamp: Date.now() + i * 1000,
        delta: -0.5 + i * 0.001,
        gamma: 0.0001,
        vega: 30,
        theta: -10,
        price: 150,
        underlyingPrice: 3100,
        impliedVolatility: 0.7,
      }));

      db.insertGreeks(greeksList);

      const retrieved = db.getGreeks("ETH-29MAR24-3000-P");
      expect(retrieved).toHaveLength(200);
    });

    test("Filter greeks by timestamp range", () => {
      const baseTime = Date.now();
      const greeksList: Greeks[] = Array.from({ length: 10 }, (_, i) => ({
        instrumentName: "BTC-29MAR24-50000-C",
        timestamp: baseTime + i * 60000,
        delta: 0.5 + i * 0.01,
        gamma: 0.0001,
        vega: 40,
        theta: -15,
        price: 2500,
        underlyingPrice: 52000,
        impliedVolatility: 0.8,
      }));

      db.insertGreeks(greeksList);

      const filtered = db.getGreeks(
        "BTC-29MAR24-50000-C",
        baseTime + 2 * 60000,
        baseTime + 5 * 60000
      );

      expect(filtered).toHaveLength(4); // Records 2, 3, 4, 5
    });

    test("Upsert replaces existing greeks", () => {
      const timestamp = Date.now();

      const greeks1: Greeks = {
        instrumentName: "BTC-29MAR24-50000-C",
        timestamp,
        delta: 0.5,
        gamma: 0.0001,
        vega: 40,
        theta: -15,
        price: 2500,
        underlyingPrice: 52000,
        impliedVolatility: 0.8,
      };

      const greeks2: Greeks = {
        ...greeks1,
        delta: 0.55, // Updated delta
      };

      db.insertGreeks([greeks1]);
      db.insertGreeks([greeks2]);

      const retrieved = db.getGreeks("BTC-29MAR24-50000-C");
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]?.delta).toBeCloseTo(0.55, 5);
    });
  });

  describe("Instruments", () => {
    test("Get distinct instruments from trades", () => {
      const instruments = [
        "BTC-29MAR24-50000-C",
        "BTC-29MAR24-55000-C",
        "ETH-29MAR24-3000-P",
      ];

      const trades: Trade[] = instruments.flatMap((inst) =>
        Array.from({ length: 5 }, (_, i) => ({
          id: `${inst}-${i}`,
          instrumentName: inst,
          price: 1000 + i,
          amount: 1.0,
          direction: "buy" as const,
          timestamp: Date.now() + i,
          indexPrice: 50000,
        }))
      );

      db.insertTrades(trades);

      const retrieved = db.getInstruments();
      expect(retrieved).toHaveLength(3);
      expect(retrieved).toContain("BTC-29MAR24-50000-C");
      expect(retrieved).toContain("ETH-29MAR24-3000-P");
    });
  });

  describe("Performance", () => {
    test("Batch insert is transactional", () => {
      const largeBatch: Trade[] = Array.from({ length: 10000 }, (_, i) => ({
        id: `large-batch-${i}`,
        instrumentName: "BTC-PERPETUAL",
        price: 50000 + i,
        amount: 1.0,
        direction: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
        timestamp: Date.now() + i,
        indexPrice: 50000,
      }));

      const start = performance.now();
      db.insertTrades(largeBatch);
      const duration = performance.now() - start;

      const count = db.getTradeCount("BTC-PERPETUAL");
      expect(count).toBe(10000);

      // Should be fast (< 1 second for 10k records)
      expect(duration).toBeLessThan(1000);
    });
  });
});
