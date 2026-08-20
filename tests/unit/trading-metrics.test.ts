import { test, expect, describe } from "bun:test";
import {
  calculateAnnualizedYield,
  calculateIVRank,
  calculateExpectedValue,
  DEFAULT_STRESS_SCENARIOS,
} from "../../src/domain/trading-metrics.ts";

describe("Trading Metrics", () => {
  describe("calculateAnnualizedYield", () => {
    test("calculates correct annualized yield for typical option", () => {
      // Example: Sell BTC option at 0.002 BTC premium, 50000 strike, index 65000, 30 DTE
      const result = calculateAnnualizedYield(0.002, 50000, 65000, 30);

      expect(result).not.toBeNull();
      // Strike in BTC = 50000/65000 = 0.769 BTC
      // Yield = (0.002 / 0.769) * 100 * (365/30) = 3.16%
      expect(result!.annualized_premium_yield).toBeCloseTo(3.16, 1);
    });

    test("calculates correct annualized yield for longer DTE", () => {
      // Same premium but 90 DTE (lower annualized yield)
      const result = calculateAnnualizedYield(0.002, 50000, 65000, 90);

      expect(result).not.toBeNull();
      // Same yield but 90 DTE: 3.16% / 3 = 1.05%
      expect(result!.annualized_premium_yield).toBeCloseTo(1.05, 1);
    });

    test("returns null for zero premium", () => {
      const result = calculateAnnualizedYield(0, 50000, 65000, 30);
      expect(result).toBeNull();
    });

    test("returns null for zero strike", () => {
      const result = calculateAnnualizedYield(0.002, 0, 65000, 30);
      expect(result).toBeNull();
    });

    test("returns null for zero index price", () => {
      const result = calculateAnnualizedYield(0.002, 50000, 0, 30);
      expect(result).toBeNull();
    });

    test("returns null for zero DTE (expired)", () => {
      const result = calculateAnnualizedYield(0.002, 50000, 65000, 0);
      expect(result).toBeNull();
    });

    test("returns null for negative values", () => {
      expect(calculateAnnualizedYield(-0.002, 50000, 65000, 30)).toBeNull();
      expect(calculateAnnualizedYield(0.002, -50000, 65000, 30)).toBeNull();
      expect(calculateAnnualizedYield(0.002, 50000, -65000, 30)).toBeNull();
      expect(calculateAnnualizedYield(0.002, 50000, 65000, -30)).toBeNull();
    });

    test("calculates realistic yield for high premium short DTE", () => {
      // High IV option: 0.01 BTC premium, 60000 strike, index 65000, 7 DTE
      const result = calculateAnnualizedYield(0.01, 60000, 65000, 7);

      expect(result).not.toBeNull();
      // Strike in BTC = 60000/65000 = 0.923 BTC
      // Yield = (0.01 / 0.923) * 100 * (365/7) = 56.5%
      expect(result!.annualized_premium_yield).toBeGreaterThan(50);
      expect(result!.annualized_premium_yield).toBeLessThan(60);
    });
  });

  describe("calculateIVRank", () => {
    test("calculates IV rank for typical 52-week range", () => {
      // Historical IVs ranging from 40 to 100 (40% to 100%)
      const historicalIVs = [40, 50, 60, 70, 80, 90, 100];
      const currentIV = 70; // Middle of range

      const result = calculateIVRank(currentIV, historicalIVs);

      expect(result.iv_rank_52w).toBeCloseTo(50, 1); // 50th percentile
      expect(result.iv_52w_high).toBe(100);
      expect(result.iv_52w_low).toBe(40);
      expect(result.iv_52w_mean).toBeCloseTo(70, 1);
      expect(result.iv_52w_stddev).toBeGreaterThan(0);
    });

    test("calculates IV rank at high end of range", () => {
      const historicalIVs = [50, 60, 70, 80, 90];
      const currentIV = 85; // Near top

      const result = calculateIVRank(currentIV, historicalIVs);

      expect(result.iv_rank_52w).toBeCloseTo(87.5, 1); // 87.5th percentile
      // Math: (85 - 50) / (90 - 50) = 35/40 = 0.875 = 87.5%
    });

    test("calculates IV rank at low end of range", () => {
      const historicalIVs = [50, 60, 70, 80, 90];
      const currentIV = 55; // Near bottom

      const result = calculateIVRank(currentIV, historicalIVs);

      expect(result.iv_rank_52w).toBeCloseTo(12.5, 1); // 12.5th percentile
      // Math: (55 - 50) / (90 - 50) = 5/40 = 0.125 = 12.5%
    });

    test("clamps IV rank to 0-100 range when outside", () => {
      const historicalIVs = [50, 60, 70];

      // Current IV below historical low
      const resultLow = calculateIVRank(40, historicalIVs);
      expect(resultLow.iv_rank_52w).toBe(0);

      // Current IV above historical high
      const resultHigh = calculateIVRank(80, historicalIVs);
      expect(resultHigh.iv_rank_52w).toBe(100);
    });

    test("handles single IV (constant volatility)", () => {
      const historicalIVs = [65, 65, 65, 65, 65];
      const currentIV = 65;

      const result = calculateIVRank(currentIV, historicalIVs);

      // When high == low, return middle of range
      expect(result.iv_rank_52w).toBe(50);
      expect(result.iv_52w_high).toBe(65);
      expect(result.iv_52w_low).toBe(65);
      expect(result.iv_52w_stddev).toBe(0);
    });

    test("returns null stats for empty history", () => {
      const result = calculateIVRank(65, []);

      expect(result.iv_rank_52w).toBeNull();
      expect(result.iv_52w_high).toBeNull();
      expect(result.iv_52w_low).toBeNull();
      expect(result.iv_52w_mean).toBeNull();
      expect(result.iv_52w_stddev).toBeNull();
    });

    test("calculates correct statistics for realistic BTC volatility", () => {
      // Realistic BTC IV range over 52 weeks
      const historicalIVs = [45, 52, 61, 58, 73, 82, 68, 55, 49, 67, 88, 95];
      const currentIV = 70;

      const result = calculateIVRank(currentIV, historicalIVs);

      expect(result.iv_52w_high).toBe(95);
      expect(result.iv_52w_low).toBe(45);
      expect(result.iv_rank_52w).toBeGreaterThan(40);
      expect(result.iv_rank_52w).toBeLessThan(60);
      expect(result.iv_52w_mean).toBeGreaterThan(60);
      expect(result.iv_52w_stddev).toBeGreaterThan(10);
    });
  });

  describe("calculateExpectedValue", () => {
    test("calculates EV for OTM short call", () => {
      // Sell 70000 call, index at 65000, premium 0.001 BTC
      const result = calculateExpectedValue(
        0.001, // premium (may be too low for positive EV)
        70000, // strike
        65000, // index price
        "call"
      );

      // With stress scenarios including +40% moves, even OTM can have negative EV
      expect(result.expected_value_btc).toBeDefined();
      expect(result.win_probability).toBeGreaterThan(30); // Should still win in most scenarios
      expect(result.max_gain_btc).toBeCloseTo(0.001, 4); // Full premium
      expect(result.max_loss_btc).toBeLessThan(0); // Can lose money
      expect(result.sharpe_ratio).not.toBeNull();
    });

    test("calculates negative EV for deep ITM short call", () => {
      // Sell 50000 call, index at 65000, premium 0.001 BTC (way too low)
      const result = calculateExpectedValue(
        0.001, // tiny premium
        50000, // strike deep ITM
        65000, // index price
        "call"
      );

      // Deep ITM with tiny premium should have negative EV
      expect(result.expected_value_btc).toBeLessThan(0);
      expect(result.win_probability).toBeLessThan(50); // More likely to lose
      expect(result.max_loss_btc).toBeLessThan(-0.001); // Lose more than premium
    });

    test("calculates EV for ATM put", () => {
      // Sell 65000 put, index at 65000, premium 0.003 BTC
      const result = calculateExpectedValue(
        0.003,
        65000,
        65000,
        "put"
      );

      // ATM with stress scenarios - EV depends on probability distribution
      expect(result.expected_value_btc).toBeDefined();
      expect(result.expected_value_btc).toBeGreaterThan(-0.05); // Not catastrophic
      expect(result.win_probability).toBeGreaterThan(30);
      expect(result.win_probability).toBeLessThan(70);
    });

    test("default scenarios sum to 100% probability", () => {
      const totalProbability = DEFAULT_STRESS_SCENARIOS.reduce(
        (sum, s) => sum + s.probability,
        0
      );
      expect(totalProbability).toBeCloseTo(1.0, 2);
    });

    test("calculates max loss for short put", () => {
      // Sell 60000 put, index at 65000, premium 0.002 BTC
      const result = calculateExpectedValue(
        0.002,
        60000,
        65000,
        "put"
      );

      // Worst case: underlying drops to 0 (or -40% in stress scenarios)
      // At -40%, index = 39000, intrinsic = 21000, in BTC = ~0.538
      // Loss = 0.002 - 0.538 ≈ -0.536
      expect(result.max_loss_btc).toBeLessThan(-0.3); // Substantial downside
      expect(result.max_gain_btc).toBeCloseTo(0.002, 4); // Max gain = full premium
    });

    test("calculates max loss for short call", () => {
      // Sell 60000 call, index at 65000, premium 0.0015 BTC
      const result = calculateExpectedValue(
        0.0015,
        60000,
        65000,
        "call"
      );

      // Worst case: underlying rallies to +40% in stress scenarios
      // At +40%, index = 91000, intrinsic = 31000, in BTC = ~0.341
      // Loss = 0.0015 - 0.341 ≈ -0.339
      expect(result.max_loss_btc).toBeLessThan(-0.2); // Substantial upside risk
      expect(result.max_gain_btc).toBeCloseTo(0.0015, 4);
    });

    test("calculates Sharpe ratio correctly", () => {
      // High premium OTM option should have good Sharpe ratio
      const result = calculateExpectedValue(
        0.005, // high premium
        75000, // far OTM call
        65000, // index
        "call"
      );

      expect(result.sharpe_ratio).not.toBeNull();
      expect(result.sharpe_ratio).toBeGreaterThan(0); // Positive risk-adjusted return
    });

    test("handles custom stress scenarios", () => {
      // Simple 3-scenario test
      const customScenarios = [
        { underlying_move_pct: -10, probability: 0.3 },
        { underlying_move_pct: 0, probability: 0.4 },
        { underlying_move_pct: 10, probability: 0.3 },
      ];

      const result = calculateExpectedValue(
        0.002,
        65000,
        65000,
        "call",
        customScenarios
      );

      expect(result.expected_value_btc).toBeDefined();
      expect(result.win_probability).toBeGreaterThan(0);
      expect(result.sharpe_ratio).not.toBeNull();
    });

    test("win probability matches expected scenarios", () => {
      // Far OTM call: 70000 strike, index 60000, premium 0.001
      const result = calculateExpectedValue(
        0.001,
        70000,
        60000,
        "call"
      );

      // Most scenarios should be winners (underlying won't hit 70k)
      expect(result.win_probability).toBeGreaterThan(70);
    });
  });

  describe("Integration: Combined metrics for realistic trade", () => {
    test("calculates all metrics for typical BTC short put", () => {
      // Realistic BTC option:
      // Sell 60000 put at 0.003 BTC premium, 30 DTE
      // Index at 65000, current IV 70% (mid-range in 45-95 range)

      const premium = 0.003;
      const strike = 60000;
      const dte = 30;
      const indexPrice = 65000;
      const currentIV = 70;
      const historicalIVs = [45, 52, 61, 73, 82, 88, 95];

      const yieldMetrics = calculateAnnualizedYield(premium, strike, indexPrice, dte);
      const ivRankMetrics = calculateIVRank(currentIV, historicalIVs);
      const evMetrics = calculateExpectedValue(premium, strike, indexPrice, "put");

      // Annualized yield should be reasonable
      expect(yieldMetrics).not.toBeNull();
      // Strike in BTC = 60000/65000 = 0.923 BTC
      // Yield = (0.003 / 0.923) * 100 * (365/30) ≈ 3.95%
      expect(yieldMetrics!.annualized_premium_yield).toBeGreaterThan(3);
      expect(yieldMetrics!.annualized_premium_yield).toBeLessThan(5);

      // IV rank should show mid-range
      expect(ivRankMetrics.iv_rank_52w).toBeGreaterThan(30);
      expect(ivRankMetrics.iv_rank_52w).toBeLessThan(70);

      // EV metrics should be defined (sign depends on stress scenarios)
      expect(evMetrics.expected_value_btc).toBeDefined();
      expect(evMetrics.win_probability).toBeGreaterThan(30);
      expect(evMetrics.sharpe_ratio).not.toBeNull();
    });
  });
});
