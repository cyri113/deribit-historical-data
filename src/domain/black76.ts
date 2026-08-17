/**
 * Black-76 Option Pricing Model
 *
 * The Black-76 model is used for pricing European options on futures contracts.
 * It's a variant of the Black-Scholes model where the underlying is a forward/future price.
 *
 * Key formula:
 * C = e^(-r*T) * [F*N(d1) - K*N(d2)]
 * P = e^(-r*T) * [K*N(-d2) - F*N(-d1)]
 *
 * where:
 * d1 = [ln(F/K) + (σ²/2)*T] / (σ*√T)
 * d2 = d1 - σ*√T
 *
 * For crypto derivatives, r (risk-free rate) is typically 0
 */

/**
 * Standard normal cumulative distribution function
 * Approximation using Abramowitz and Stegun formula
 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

  return x > 0 ? 1 - prob : prob;
}

/**
 * Standard normal probability density function
 */
function normalPDF(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate d1 and d2 for Black-76 model
 */
function calculateD1D2(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number
): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 =
    (Math.log(forwardPrice / strike) + (volatility * volatility * timeToExpiry) / 2) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  return { d1, d2 };
}

/**
 * Black-76 Call Option Price
 *
 * @param forwardPrice - Current forward/future price
 * @param strike - Strike price
 * @param timeToExpiry - Time to expiration in years
 * @param volatility - Implied volatility (annualized, e.g., 0.8 for 80%)
 * @param discountFactor - e^(-r*T), typically 1 for crypto (r=0)
 * @returns Call option price
 */
export function black76Call(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor: number = 1
): number {
  if (timeToExpiry <= 0) {
    return Math.max(0, forwardPrice - strike);
  }

  const { d1, d2 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);

  return discountFactor * (forwardPrice * normalCDF(d1) - strike * normalCDF(d2));
}

/**
 * Black-76 Put Option Price
 *
 * @param forwardPrice - Current forward/future price
 * @param strike - Strike price
 * @param timeToExpiry - Time to expiration in years
 * @param volatility - Implied volatility (annualized, e.g., 0.8 for 80%)
 * @param discountFactor - e^(-r*T), typically 1 for crypto (r=0)
 * @returns Put option price
 */
export function black76Put(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor: number = 1
): number {
  if (timeToExpiry <= 0) {
    return Math.max(0, strike - forwardPrice);
  }

  const { d1, d2 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);

  return discountFactor * (strike * normalCDF(-d2) - forwardPrice * normalCDF(-d1));
}

/**
 * Delta: Rate of change of option price with respect to underlying price
 *
 * Call Delta = e^(-r*T) * N(d1)
 * Put Delta = -e^(-r*T) * N(-d1)
 */
export function delta(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor: number = 1
): number {
  if (timeToExpiry <= 0) {
    if (optionType === "call") {
      return forwardPrice > strike ? 1 : 0;
    } else {
      return forwardPrice < strike ? -1 : 0;
    }
  }

  const { d1 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);

  if (optionType === "call") {
    return discountFactor * normalCDF(d1);
  } else {
    return -discountFactor * normalCDF(-d1);
  }
}

/**
 * Gamma: Rate of change of delta with respect to underlying price
 *
 * Gamma = e^(-r*T) * N'(d1) / (F * σ * √T)
 * (Same for both calls and puts)
 */
export function gamma(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor: number = 1
): number {
  if (timeToExpiry <= 0) {
    return 0;
  }

  const { d1 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);
  const sqrtT = Math.sqrt(timeToExpiry);

  return (discountFactor * normalPDF(d1)) / (forwardPrice * volatility * sqrtT);
}

/**
 * Vega: Rate of change of option price with respect to volatility
 *
 * Vega = e^(-r*T) * F * N'(d1) * √T
 * (Same for both calls and puts)
 *
 * Note: Returns vega per 1% change in volatility (divide by 100)
 */
export function vega(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  discountFactor: number = 1
): number {
  if (timeToExpiry <= 0) {
    return 0;
  }

  const { d1 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);
  const sqrtT = Math.sqrt(timeToExpiry);

  // Return vega per 1% change (divide by 100)
  return (discountFactor * forwardPrice * normalPDF(d1) * sqrtT) / 100;
}

/**
 * Theta: Rate of change of option price with respect to time
 *
 * Call Theta = -e^(-r*T) * [F*N'(d1)*σ / (2*√T)] + r*F*e^(-r*T)*N(d1) - r*K*e^(-r*T)*N(d2)
 * Put Theta = -e^(-r*T) * [F*N'(d1)*σ / (2*√T)] - r*F*e^(-r*T)*N(-d1) + r*K*e^(-r*T)*N(-d2)
 *
 * For crypto (r=0), simplifies significantly
 *
 * Returns theta per day (divide by 365)
 */
export function theta(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor: number = 1,
  riskFreeRate: number = 0
): number {
  if (timeToExpiry <= 0) {
    return 0;
  }

  const { d1, d2 } = calculateD1D2(forwardPrice, strike, timeToExpiry, volatility);
  const sqrtT = Math.sqrt(timeToExpiry);

  const term1 =
    (-discountFactor * forwardPrice * normalPDF(d1) * volatility) / (2 * sqrtT);

  if (riskFreeRate === 0) {
    // Simplified for crypto (r=0)
    return term1 / 365; // Per day
  }

  // General case with risk-free rate
  if (optionType === "call") {
    const term2 = riskFreeRate * forwardPrice * discountFactor * normalCDF(d1);
    const term3 = riskFreeRate * strike * discountFactor * normalCDF(d2);
    return (term1 + term2 - term3) / 365;
  } else {
    const term2 = riskFreeRate * forwardPrice * discountFactor * normalCDF(-d1);
    const term3 = riskFreeRate * strike * discountFactor * normalCDF(-d2);
    return (term1 - term2 + term3) / 365;
  }
}

/**
 * Calculate all Greeks at once
 */
export interface Black76Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export function calculateGreeks(
  forwardPrice: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  optionType: "call" | "put",
  discountFactor: number = 1,
  riskFreeRate: number = 0
): Black76Greeks {
  const price =
    optionType === "call"
      ? black76Call(forwardPrice, strike, timeToExpiry, volatility, discountFactor)
      : black76Put(forwardPrice, strike, timeToExpiry, volatility, discountFactor);

  return {
    price,
    delta: delta(
      forwardPrice,
      strike,
      timeToExpiry,
      volatility,
      optionType,
      discountFactor
    ),
    gamma: gamma(forwardPrice, strike, timeToExpiry, volatility, discountFactor),
    vega: vega(forwardPrice, strike, timeToExpiry, volatility, discountFactor),
    theta: theta(
      forwardPrice,
      strike,
      timeToExpiry,
      volatility,
      optionType,
      discountFactor,
      riskFreeRate
    ),
  };
}
