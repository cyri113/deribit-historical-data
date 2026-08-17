import { test, expect, describe } from "bun:test";
import {
  calculateMoneyness,
  calculateIntrinsicValue,
  calculateMoneynessPercentage,
  isInTheMoney,
} from "../../src/domain/moneyness.ts";
import { Moneyness } from "../../src/domain/models.ts";

describe("Moneyness Calculations", () => {
  describe("calculateMoneyness", () => {
    describe("Call Options", () => {
      test("ITM when delivery price > strike", () => {
        const result = calculateMoneyness(50000, 55000, "call");
        expect(result).toBe(Moneyness.ITM);
      });

      test("OTM when delivery price < strike", () => {
        const result = calculateMoneyness(50000, 45000, "call");
        expect(result).toBe(Moneyness.OTM);
      });

      test("ATM when delivery price ≈ strike (within threshold)", () => {
        const result = calculateMoneyness(50000, 50100, "call", 0.005);
        expect(result).toBe(Moneyness.ATM);
      });

      test("Exact ATM", () => {
        const result = calculateMoneyness(50000, 50000, "call");
        expect(result).toBe(Moneyness.ATM);
      });
    });

    describe("Put Options", () => {
      test("ITM when delivery price < strike", () => {
        const result = calculateMoneyness(50000, 45000, "put");
        expect(result).toBe(Moneyness.ITM);
      });

      test("OTM when delivery price > strike", () => {
        const result = calculateMoneyness(50000, 55000, "put");
        expect(result).toBe(Moneyness.OTM);
      });

      test("ATM when delivery price ≈ strike", () => {
        const result = calculateMoneyness(50000, 49900, "put", 0.005);
        expect(result).toBe(Moneyness.ATM);
      });
    });

    describe("ATM Threshold", () => {
      test("Custom threshold works correctly", () => {
        // 1% threshold
        const result1 = calculateMoneyness(50000, 50500, "call", 0.01);
        expect(result1).toBe(Moneyness.ATM);

        // 0.1% threshold (tighter)
        const result2 = calculateMoneyness(50000, 50500, "call", 0.001);
        expect(result2).toBe(Moneyness.ITM); // Outside tighter threshold
      });
    });
  });

  describe("calculateIntrinsicValue", () => {
    describe("Call Options", () => {
      test("ITM call has positive intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 55000, "call");
        expect(value).toBe(5000);
      });

      test("ATM call has zero intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 50000, "call");
        expect(value).toBe(0);
      });

      test("OTM call has zero intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 45000, "call");
        expect(value).toBe(0);
      });
    });

    describe("Put Options", () => {
      test("ITM put has positive intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 45000, "put");
        expect(value).toBe(5000);
      });

      test("ATM put has zero intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 50000, "put");
        expect(value).toBe(0);
      });

      test("OTM put has zero intrinsic value", () => {
        const value = calculateIntrinsicValue(50000, 55000, "put");
        expect(value).toBe(0);
      });
    });

    test("Intrinsic value is never negative", () => {
      // Deep OTM
      const callValue = calculateIntrinsicValue(50000, 30000, "call");
      const putValue = calculateIntrinsicValue(50000, 70000, "put");

      expect(callValue).toBe(0);
      expect(putValue).toBe(0);
    });
  });

  describe("calculateMoneynessPercentage", () => {
    describe("Call Options", () => {
      test("Positive percentage for ITM call", () => {
        const pct = calculateMoneynessPercentage(50000, 55000, "call");
        expect(pct).toBeCloseTo(10, 1); // 10% ITM
      });

      test("Negative percentage for OTM call", () => {
        const pct = calculateMoneynessPercentage(50000, 45000, "call");
        expect(pct).toBeCloseTo(-10, 1); // 10% OTM
      });

      test("Zero percentage for ATM call", () => {
        const pct = calculateMoneynessPercentage(50000, 50000, "call");
        expect(pct).toBe(0);
      });
    });

    describe("Put Options", () => {
      test("Positive percentage for ITM put", () => {
        const pct = calculateMoneynessPercentage(50000, 45000, "put");
        expect(pct).toBeCloseTo(10, 1); // 10% ITM
      });

      test("Negative percentage for OTM put", () => {
        const pct = calculateMoneynessPercentage(50000, 55000, "put");
        expect(pct).toBeCloseTo(-10, 1); // 10% OTM
      });

      test("Zero percentage for ATM put", () => {
        const pct = calculateMoneynessPercentage(50000, 50000, "put");
        expect(pct).toBe(0);
      });
    });

    test("Percentage accuracy", () => {
      // Call: (55000 - 50000) / 50000 * 100 = 10%
      const callPct = calculateMoneynessPercentage(50000, 55000, "call");
      expect(callPct).toBe(10);

      // Put: (50000 - 45000) / 50000 * 100 = 10%
      const putPct = calculateMoneynessPercentage(50000, 45000, "put");
      expect(putPct).toBe(10);
    });
  });

  describe("isInTheMoney", () => {
    test("Returns true for ITM call", () => {
      const result = isInTheMoney(50000, 55000, "call");
      expect(result).toBe(true);
    });

    test("Returns false for OTM call", () => {
      const result = isInTheMoney(50000, 45000, "call");
      expect(result).toBe(false);
    });

    test("Returns false for ATM call", () => {
      const result = isInTheMoney(50000, 50000, "call");
      expect(result).toBe(false);
    });

    test("Returns true for ITM put", () => {
      const result = isInTheMoney(50000, 45000, "put");
      expect(result).toBe(true);
    });

    test("Returns false for OTM put", () => {
      const result = isInTheMoney(50000, 55000, "put");
      expect(result).toBe(false);
    });

    test("Returns false for ATM put", () => {
      const result = isInTheMoney(50000, 50000, "put");
      expect(result).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("Very small strike values", () => {
      const moneyness = calculateMoneyness(0.01, 0.02, "call");
      expect(moneyness).toBe(Moneyness.ITM);
    });

    test("Very large strike values", () => {
      const moneyness = calculateMoneyness(100000, 95000, "put");
      expect(moneyness).toBe(Moneyness.ITM);
    });

    test("Equal strike and delivery price", () => {
      const intrinsicCall = calculateIntrinsicValue(12345, 12345, "call");
      const intrinsicPut = calculateIntrinsicValue(12345, 12345, "put");

      expect(intrinsicCall).toBe(0);
      expect(intrinsicPut).toBe(0);
    });
  });
});
