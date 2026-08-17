import { Moneyness } from "./models.ts";

/**
 * Determine the moneyness of an option at expiry
 *
 * @param strike - Strike price of the option
 * @param deliveryPrice - Settlement/delivery price at expiration
 * @param optionType - 'call' or 'put'
 * @param atmThreshold - Threshold percentage to consider ATM (default 0.5% = 0.005)
 * @returns Moneyness classification (ITM, ATM, or OTM)
 */
export function calculateMoneyness(
  strike: number,
  deliveryPrice: number,
  optionType: "call" | "put",
  atmThreshold: number = 0.005
): Moneyness {
  const relativeDistance = Math.abs(deliveryPrice - strike) / deliveryPrice;

  // Check if approximately at-the-money
  if (relativeDistance <= atmThreshold) {
    return Moneyness.ATM;
  }

  // For calls: ITM if delivery price > strike
  // For puts: ITM if delivery price < strike
  if (optionType === "call") {
    return deliveryPrice > strike ? Moneyness.ITM : Moneyness.OTM;
  } else {
    return deliveryPrice < strike ? Moneyness.ITM : Moneyness.OTM;
  }
}

/**
 * Calculate intrinsic value of an option
 *
 * @param strike - Strike price
 * @param underlyingPrice - Current or delivery price of underlying
 * @param optionType - 'call' or 'put'
 * @returns Intrinsic value (always >= 0)
 */
export function calculateIntrinsicValue(
  strike: number,
  underlyingPrice: number,
  optionType: "call" | "put"
): number {
  if (optionType === "call") {
    return Math.max(0, underlyingPrice - strike);
  } else {
    return Math.max(0, strike - underlyingPrice);
  }
}

/**
 * Calculate the percentage by which an option is ITM or OTM
 *
 * @param strike - Strike price
 * @param underlyingPrice - Current or delivery price
 * @param optionType - 'call' or 'put'
 * @returns Positive percentage if ITM, negative if OTM, 0 if ATM
 */
export function calculateMoneynessPercentage(
  strike: number,
  underlyingPrice: number,
  optionType: "call" | "put"
): number {
  if (optionType === "call") {
    return ((underlyingPrice - strike) / strike) * 100;
  } else {
    return ((strike - underlyingPrice) / strike) * 100;
  }
}

/**
 * Determine if an option expired in-the-money
 *
 * @param strike - Strike price
 * @param deliveryPrice - Settlement price at expiry
 * @param optionType - 'call' or 'put'
 * @returns true if option expired ITM
 */
export function isInTheMoney(
  strike: number,
  deliveryPrice: number,
  optionType: "call" | "put"
): boolean {
  const moneyness = calculateMoneyness(strike, deliveryPrice, optionType);
  return moneyness === Moneyness.ITM;
}
