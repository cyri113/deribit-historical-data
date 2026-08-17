import { test, expect, describe } from "bun:test";
import {
  black76Call,
  black76Put,
  delta,
  gamma,
  vega,
  theta,
  calculateGreeks,
} from "../../src/domain/black76.ts";

describe("Black-76 Option Pricing", () => {
  // Known values for validation (from financial calculators/references)
  const testParams = {
    forwardPrice: 50000,
    strike: 50000,
    timeToExpiry: 0.25, // 3 months
    volatility: 0.8, // 80% IV
    discountFactor: 1, // crypto, r=0
  };

  describe("black76Call", () => {
    test("ATM call has positive value", () => {
      const price = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(price).toBeGreaterThan(0);
      expect(price).toBeGreaterThan(1000); // Should be significant for BTC
    });

    test("ITM call worth more than ATM call", () => {
      const atmPrice = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      const itmPrice = black76Call(
        testParams.forwardPrice,
        45000, // Lower strike = ITM call
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(itmPrice).toBeGreaterThan(atmPrice);
    });

    test("Higher volatility increases call value", () => {
      const lowVolPrice = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        0.4
      );
      const highVolPrice = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        0.8
      );
      expect(highVolPrice).toBeGreaterThan(lowVolPrice);
    });

    test("Expired ATM call has zero value", () => {
      const price = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        0, // Expired
        testParams.volatility
      );
      expect(price).toBe(0);
    });

    test("Expired ITM call has intrinsic value", () => {
      const strike = 45000;
      const price = black76Call(testParams.forwardPrice, strike, 0, testParams.volatility);
      expect(price).toBe(testParams.forwardPrice - strike);
    });
  });

  describe("black76Put", () => {
    test("ATM put has positive value", () => {
      const price = black76Put(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(price).toBeGreaterThan(0);
    });

    test("ITM put worth more than ATM put", () => {
      const atmPrice = black76Put(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      const itmPrice = black76Put(
        testParams.forwardPrice,
        55000, // Higher strike = ITM put
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(itmPrice).toBeGreaterThan(atmPrice);
    });

    test("Put-call parity holds (approximately)", () => {
      // C - P = F - K (when discount factor = 1)
      const callPrice = black76Call(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      const putPrice = black76Put(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );

      const diff = callPrice - putPrice;
      const expected = testParams.forwardPrice - testParams.strike;

      // Allow small numerical error
      expect(Math.abs(diff - expected)).toBeLessThan(0.01);
    });
  });

  describe("delta", () => {
    test("ATM call delta is approximately 0.5", () => {
      const d = delta(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      expect(d).toBeGreaterThan(0.4);
      expect(d).toBeLessThan(0.6);
    });

    test("ATM put delta is approximately -0.5", () => {
      const d = delta(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "put"
      );
      expect(d).toBeGreaterThan(-0.6);
      expect(d).toBeLessThan(-0.4);
    });

    test("Deep ITM call delta approaches 1", () => {
      const d = delta(
        testParams.forwardPrice,
        30000, // Very low strike
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      expect(d).toBeGreaterThan(0.9); // With 80% vol, won't reach 0.95
    });

    test("Deep OTM call delta approaches 0", () => {
      const d = delta(
        testParams.forwardPrice,
        70000, // Very high strike
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      expect(d).toBeLessThan(0.3); // With 80% vol, won't reach 0.05
    });

    test("Expired ITM call has delta 1", () => {
      const d = delta(50000, 45000, 0, 0.8, "call");
      expect(d).toBe(1);
    });

    test("Expired OTM call has delta 0", () => {
      const d = delta(50000, 55000, 0, 0.8, "call");
      expect(d).toBe(0);
    });
  });

  describe("gamma", () => {
    test("ATM gamma is highest", () => {
      const atmGamma = gamma(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      const itmGamma = gamma(
        testParams.forwardPrice,
        40000,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(atmGamma).toBeGreaterThan(itmGamma);
    });

    test("Gamma is always positive", () => {
      const g = gamma(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(g).toBeGreaterThan(0);
    });

    test("Expired option has zero gamma", () => {
      const g = gamma(testParams.forwardPrice, testParams.strike, 0, testParams.volatility);
      expect(g).toBe(0);
    });
  });

  describe("vega", () => {
    test("Vega is positive for all options", () => {
      const v = vega(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(v).toBeGreaterThan(0);
    });

    test("ATM vega is highest", () => {
      const atmVega = vega(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility
      );
      const otmVega = vega(
        testParams.forwardPrice,
        60000,
        testParams.timeToExpiry,
        testParams.volatility
      );
      expect(atmVega).toBeGreaterThan(otmVega);
    });

    test("Expired option has zero vega", () => {
      const v = vega(testParams.forwardPrice, testParams.strike, 0, testParams.volatility);
      expect(v).toBe(0);
    });
  });

  describe("theta", () => {
    test("Theta is negative for long options", () => {
      const t = theta(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      expect(t).toBeLessThan(0);
    });

    test("ATM theta is most negative", () => {
      const atmTheta = theta(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      const otmTheta = theta(
        testParams.forwardPrice,
        60000,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );
      expect(Math.abs(atmTheta)).toBeGreaterThan(Math.abs(otmTheta));
    });

    test("Expired option has zero theta", () => {
      const t = theta(
        testParams.forwardPrice,
        testParams.strike,
        0,
        testParams.volatility,
        "call"
      );
      expect(t).toBe(0);
    });
  });

  describe("calculateGreeks", () => {
    test("Returns all greeks with correct structure", () => {
      const result = calculateGreeks(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );

      expect(result).toHaveProperty("price");
      expect(result).toHaveProperty("delta");
      expect(result).toHaveProperty("gamma");
      expect(result).toHaveProperty("vega");
      expect(result).toHaveProperty("theta");

      expect(result.price).toBeGreaterThan(0);
      expect(result.delta).toBeGreaterThan(0);
      expect(result.gamma).toBeGreaterThan(0);
      expect(result.vega).toBeGreaterThan(0);
      expect(result.theta).toBeLessThan(0);
    });

    test("Matches individual greek calculations", () => {
      const combined = calculateGreeks(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );

      const individualDelta = delta(
        testParams.forwardPrice,
        testParams.strike,
        testParams.timeToExpiry,
        testParams.volatility,
        "call"
      );

      expect(combined.delta).toBeCloseTo(individualDelta, 6);
    });
  });
});
