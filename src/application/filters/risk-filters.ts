import { Database } from "../../infrastructure/database.ts";
import { calculateMoneyness } from "../../domain/moneyness.ts";
import { parseInstrumentName, Moneyness, type Greeks, type RiskFilter } from "../../domain/models.ts";

export interface FilterResult {
  instrumentName: string;
  timestamp: number;
  greeks: Greeks;
  moneyness?: Moneyness;
  passed: boolean;
  failedChecks: string[];
}

export interface RiskFilterConfig {
  database: Database;
}

/**
 * RiskFilters - Apply risk-based filters to options using greeks and moneyness
 *
 * Filters options based on configurable thresholds per underlying
 */
export class RiskFilters {
  private database: Database;

  constructor(config: RiskFilterConfig) {
    this.database = config.database;
  }

  /**
   * Apply risk filter to greeks data
   *
   * @param greeks - Greeks data to filter
   * @param filter - Risk filter criteria
   * @param deliveryPrice - Optional delivery price for moneyness calculation
   * @returns Filter result with pass/fail status
   */
  applyFilter(
    greeks: Greeks,
    filter: RiskFilter,
    deliveryPrice?: number
  ): FilterResult {
    const failedChecks: string[] = [];
    let moneyness: Moneyness | undefined;

    // Check delta bounds
    if (filter.deltaMin !== undefined && greeks.delta < filter.deltaMin) {
      failedChecks.push(`delta ${greeks.delta.toFixed(4)} < min ${filter.deltaMin}`);
    }
    if (filter.deltaMax !== undefined && greeks.delta > filter.deltaMax) {
      failedChecks.push(`delta ${greeks.delta.toFixed(4)} > max ${filter.deltaMax}`);
    }

    // Check gamma bounds
    if (filter.gammaMin !== undefined && greeks.gamma < filter.gammaMin) {
      failedChecks.push(`gamma ${greeks.gamma.toFixed(6)} < min ${filter.gammaMin}`);
    }
    if (filter.gammaMax !== undefined && greeks.gamma > filter.gammaMax) {
      failedChecks.push(`gamma ${greeks.gamma.toFixed(6)} > max ${filter.gammaMax}`);
    }

    // Check vega bounds
    if (filter.vegaMin !== undefined && greeks.vega < filter.vegaMin) {
      failedChecks.push(`vega ${greeks.vega.toFixed(4)} < min ${filter.vegaMin}`);
    }
    if (filter.vegaMax !== undefined && greeks.vega > filter.vegaMax) {
      failedChecks.push(`vega ${greeks.vega.toFixed(4)} > max ${filter.vegaMax}`);
    }

    // Check theta bounds
    if (filter.thetaMin !== undefined && greeks.theta < filter.thetaMin) {
      failedChecks.push(`theta ${greeks.theta.toFixed(4)} < min ${filter.thetaMin}`);
    }
    if (filter.thetaMax !== undefined && greeks.theta > filter.thetaMax) {
      failedChecks.push(`theta ${greeks.theta.toFixed(4)} > max ${filter.thetaMax}`);
    }

    // Check moneyness filter
    if (filter.moneynessFilter && deliveryPrice !== undefined) {
      const instrument = parseInstrumentName(greeks.instrumentName);
      if (instrument && instrument.instrumentType === "option") {
        moneyness = calculateMoneyness(
          instrument.strike,
          deliveryPrice,
          instrument.optionType
        );

        if (!filter.moneynessFilter.includes(moneyness)) {
          failedChecks.push(`moneyness ${moneyness} not in allowed ${filter.moneynessFilter.join(", ")}`);
        }
      }
    }

    return {
      instrumentName: greeks.instrumentName,
      timestamp: greeks.timestamp,
      greeks,
      moneyness,
      passed: failedChecks.length === 0,
      failedChecks,
    };
  }

  /**
   * Filter all greeks for an instrument
   *
   * @param instrumentName - Instrument name
   * @param filter - Risk filter criteria
   * @param deliveryPrice - Optional delivery price for moneyness
   * @returns Array of filter results
   */
  filterInstrument(
    instrumentName: string,
    filter: RiskFilter,
    deliveryPrice?: number
  ): FilterResult[] {
    const greeksList = this.database.getGreeks(instrumentName);
    return greeksList.map((greeks) =>
      this.applyFilter(greeks, filter, deliveryPrice)
    );
  }

  /**
   * Get passing greeks for an instrument (convenience method)
   *
   * @param instrumentName - Instrument name
   * @param filter - Risk filter criteria
   * @param deliveryPrice - Optional delivery price
   * @returns Array of greeks that pass the filter
   */
  getPassingGreeks(
    instrumentName: string,
    filter: RiskFilter,
    deliveryPrice?: number
  ): Greeks[] {
    const results = this.filterInstrument(instrumentName, filter, deliveryPrice);
    return results.filter((r) => r.passed).map((r) => r.greeks);
  }

  /**
   * Get filter statistics for an instrument
   *
   * @param instrumentName - Instrument name
   * @param filter - Risk filter criteria
   * @param deliveryPrice - Optional delivery price
   * @returns Filter pass/fail statistics
   */
  getFilterStats(
    instrumentName: string,
    filter: RiskFilter,
    deliveryPrice?: number
  ): {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  } {
    const results = this.filterInstrument(instrumentName, filter, deliveryPrice);
    const passed = results.filter((r) => r.passed).length;

    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? passed / results.length : 0,
    };
  }
}

/**
 * Pre-configured risk filters for common strategies
 */
export const PresetFilters = {
  /**
   * Conservative filter for BTC - avoid extreme greeks
   */
  btcConservative: {
    name: "BTC Conservative",
    underlying: "BTC",
    deltaMin: -0.8,
    deltaMax: 0.8,
    gammaMax: 0.001,
    vegaMax: 100,
    thetaMin: -50,
  } as RiskFilter,

  /**
   * Aggressive filter for BTC - allow wider ranges
   */
  btcAggressive: {
    name: "BTC Aggressive",
    underlying: "BTC",
    deltaMin: -1.0,
    deltaMax: 1.0,
    gammaMax: 0.01,
    vegaMax: 500,
  } as RiskFilter,

  /**
   * Only ITM options at expiry
   */
  itmOnly: {
    name: "ITM Only",
    underlying: "ALL",
    moneynessFilter: [Moneyness.ITM],
  } as RiskFilter,

  /**
   * Only OTM options (for selling strategies)
   */
  otmOnly: {
    name: "OTM Only",
    underlying: "ALL",
    moneynessFilter: [Moneyness.OTM],
  } as RiskFilter,

  /**
   * High delta calls (near ITM or ITM)
   */
  highDeltaCalls: {
    name: "High Delta Calls",
    underlying: "ALL",
    deltaMin: 0.6,
    deltaMax: 1.0,
  } as RiskFilter,

  /**
   * Low theta decay options
   */
  lowThetaDecay: {
    name: "Low Theta Decay",
    underlying: "ALL",
    thetaMin: -10,
    thetaMax: 0,
  } as RiskFilter,
};
