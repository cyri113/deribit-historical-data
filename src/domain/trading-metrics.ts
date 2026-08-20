/**
 * Trading Metrics Module
 *
 * Calculates sophisticated trading metrics for option strategies:
 * 1. Annualized Premium Yield - For premium selling strategies
 * 2. IV Rank (52-Week Percentile) - For mean reversion strategies
 * 3. Expected Value (Stress Scenarios) - For risk analysis
 */

/**
 * Annualized Premium Yield
 *
 * Calculates the annualized return from selling an option at a given premium
 * Formula: (premium / (strike/indexPrice)) × (365 / days_to_expiry) × 100
 *
 * @param premium - Option price in BTC
 * @param strike - Strike price in USD
 * @param indexPrice - Current underlying price in USD (for currency conversion)
 * @param daysToExpiry - Days until expiration
 * @returns Annualized yield as percentage (e.g., 45.2 = 45.2% annual yield)
 */
export interface AnnualizedYield {
  annualized_premium_yield: number; // Percentage (e.g., 45.2 = 45.2%)
}

export function calculateAnnualizedYield(
  premium: number,
  strike: number,
  indexPrice: number,
  daysToExpiry: number
): AnnualizedYield | null {
  // Edge cases
  if (premium <= 0 || strike <= 0 || indexPrice <= 0 || daysToExpiry <= 0) {
    return null;
  }

  // Convert strike to BTC (capital at risk)
  const strikeInBTC = strike / indexPrice;

  // Premium yield = premium / strikeInBTC (as percentage of collateral)
  const premiumYield = (premium / strikeInBTC) * 100;

  // Annualize: scale to 365 days
  const annualizedYield = premiumYield * (365 / daysToExpiry);

  return {
    annualized_premium_yield: annualizedYield,
  };
}

/**
 * IV Rank (52-Week Percentile)
 *
 * Calculates where current IV sits in the 52-week historical range
 * Useful for identifying high/low IV entry points
 *
 * @param currentIV - Current implied volatility (percentage format: 65 = 65%)
 * @param historicalIVs - Array of historical IVs from past 52 weeks
 * @returns IV rank statistics (percentile, high, low, mean, stddev)
 */
export interface IVRankStats {
  iv_rank_52w: number | null; // Percentile (0-100)
  iv_52w_high: number | null;
  iv_52w_low: number | null;
  iv_52w_mean: number | null;
  iv_52w_stddev: number | null;
}

export function calculateIVRank(
  currentIV: number,
  historicalIVs: number[]
): IVRankStats {
  // Edge case: no historical data
  if (historicalIVs.length === 0) {
    return {
      iv_rank_52w: null,
      iv_52w_high: null,
      iv_52w_low: null,
      iv_52w_mean: null,
      iv_52w_stddev: null,
    };
  }

  // Calculate statistics
  const high = Math.max(...historicalIVs);
  const low = Math.min(...historicalIVs);
  const mean = historicalIVs.reduce((sum, iv) => sum + iv, 0) / historicalIVs.length;

  // Standard deviation
  const variance =
    historicalIVs.reduce((sum, iv) => sum + Math.pow(iv - mean, 2), 0) /
    historicalIVs.length;
  const stddev = Math.sqrt(variance);

  // IV Rank: percentile in range
  // Formula: (current - low) / (high - low) * 100
  let ivRank: number | null = null;
  if (high > low) {
    ivRank = ((currentIV - low) / (high - low)) * 100;
    ivRank = Math.max(0, Math.min(100, ivRank)); // Clamp to [0, 100]
  } else {
    // All IVs are the same
    ivRank = 50; // Middle of range
  }

  return {
    iv_rank_52w: ivRank,
    iv_52w_high: high,
    iv_52w_low: low,
    iv_52w_mean: mean,
    iv_52w_stddev: stddev,
  };
}

/**
 * Stress Scenario
 *
 * Defines a single stress scenario for expected value calculation
 */
export interface StressScenario {
  underlying_move_pct: number; // Percentage move in underlying (e.g., -10 = -10%)
  probability: number; // Probability weight (sum to 1.0 across all scenarios)
}

/**
 * Default Stress Scenarios (11 scenarios, normal distribution)
 *
 * Covers -40% to +40% with higher probability near center
 * Based on simplified normal distribution approximation
 * Total probability = 1.0 (100%)
 */
export const DEFAULT_STRESS_SCENARIOS: StressScenario[] = [
  { underlying_move_pct: -40, probability: 0.005 }, // Tail risk
  { underlying_move_pct: -30, probability: 0.01 },
  { underlying_move_pct: -20, probability: 0.05 },
  { underlying_move_pct: -10, probability: 0.12 },
  { underlying_move_pct: -5, probability: 0.17 },
  { underlying_move_pct: 0, probability: 0.29 }, // Highest probability (no move)
  { underlying_move_pct: 5, probability: 0.17 },
  { underlying_move_pct: 10, probability: 0.12 },
  { underlying_move_pct: 20, probability: 0.05 },
  { underlying_move_pct: 30, probability: 0.01 },
  { underlying_move_pct: 40, probability: 0.005 }, // Tail risk
];

/**
 * Expected Value (Stress Scenarios)
 *
 * Calculates probability-weighted expected P&L across stress scenarios
 * Useful for risk-adjusted strategy evaluation
 *
 * @param premium - Option price received (BTC) - for short positions
 * @param strike - Strike price (USD)
 * @param indexPrice - Current underlying price (USD)
 * @param optionType - 'call' or 'put'
 * @param scenarios - Array of stress scenarios (default: normal distribution)
 * @returns Expected value metrics (EV, win probability, max loss/gain, Sharpe)
 */
export interface ExpectedValueMetrics {
  expected_value_btc: number; // Probability-weighted P&L in BTC
  win_probability: number; // Probability of profit (%)
  max_loss_btc: number; // Maximum loss across all scenarios (BTC)
  max_gain_btc: number; // Maximum gain across all scenarios (BTC)
  sharpe_ratio: number | null; // Risk-adjusted return (EV / stddev)
}

export function calculateExpectedValue(
  premium: number,
  strike: number,
  indexPrice: number,
  optionType: "call" | "put",
  scenarios: StressScenario[] = DEFAULT_STRESS_SCENARIOS
): ExpectedValueMetrics {
  // Calculate P&L for each scenario
  const scenarioPnLs: Array<{ pnl: number; probability: number }> = [];

  for (const scenario of scenarios) {
    // Future price under this scenario
    const futurePrice = indexPrice * (1 + scenario.underlying_move_pct / 100);

    // Intrinsic value at expiry
    let intrinsicValue = 0;
    if (optionType === "call") {
      intrinsicValue = Math.max(0, futurePrice - strike);
    } else {
      intrinsicValue = Math.max(0, strike - futurePrice);
    }

    // Convert to BTC (option buyer's payout)
    const intrinsicValueBTC = intrinsicValue / futurePrice;

    // P&L = premium received - intrinsic value paid out (short option perspective)
    const pnl = premium - intrinsicValueBTC;

    scenarioPnLs.push({
      pnl,
      probability: scenario.probability,
    });
  }

  // Expected value (probability-weighted mean)
  const expectedValue = scenarioPnLs.reduce(
    (sum, s) => sum + s.pnl * s.probability,
    0
  );

  // Win probability (probability of positive P&L)
  const winProbability =
    scenarioPnLs
      .filter((s) => s.pnl > 0)
      .reduce((sum, s) => sum + s.probability, 0) * 100;

  // Max loss/gain
  const maxLoss = Math.min(...scenarioPnLs.map((s) => s.pnl));
  const maxGain = Math.max(...scenarioPnLs.map((s) => s.pnl));

  // Sharpe ratio (risk-adjusted return)
  // Standard deviation of P&L
  const variance = scenarioPnLs.reduce(
    (sum, s) => sum + Math.pow(s.pnl - expectedValue, 2) * s.probability,
    0
  );
  const stddev = Math.sqrt(variance);

  const sharpeRatio = stddev > 0 ? expectedValue / stddev : null;

  return {
    expected_value_btc: expectedValue,
    win_probability: winProbability,
    max_loss_btc: maxLoss,
    max_gain_btc: maxGain,
    sharpe_ratio: sharpeRatio,
  };
}
