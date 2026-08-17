import { Database } from "../../infrastructure/database.ts";
import { calculateGreeks } from "../../domain/black76.ts";
import { parseInstrumentName, type Greeks } from "../../domain/models.ts";

export interface GreeksCalculatorConfig {
  database: Database;
  batchSize?: number; // Trades per batch for calculation
  dbBatchSize?: number; // Greeks per DB transaction
}

export interface CalculationProgress {
  instrument: string;
  totalCalculated: number;
  batchesProcessed: number;
  startTime: number;
  endTime?: number;
}

/**
 * GreeksCalculator - Computes Black-76 greeks from historical trade data
 *
 * Retrieves trades from DB, calculates greeks, and stores results
 */
export class GreeksCalculator {
  private database: Database;
  private batchSize: number;
  private dbBatchSize: number;

  constructor(config: GreeksCalculatorConfig) {
    this.database = config.database;
    this.batchSize = config.batchSize ?? 1000;
    this.dbBatchSize = config.dbBatchSize ?? 5000;
  }

  /**
   * Calculate greeks for all trades of an instrument
   *
   * @param instrumentName - e.g., "BTC-29MAR24-50000-C"
   * @param startTimestamp - Optional start time filter
   * @param endTimestamp - Optional end time filter
   * @param onProgress - Optional progress callback
   * @returns Calculation progress
   */
  async calculateForInstrument(
    instrumentName: string,
    startTimestamp?: number,
    endTimestamp?: number,
    onProgress?: (progress: CalculationProgress) => void
  ): Promise<CalculationProgress> {
    const progress: CalculationProgress = {
      instrument: instrumentName,
      totalCalculated: 0,
      batchesProcessed: 0,
      startTime: Date.now(),
    };

    // Parse instrument to get strike, expiry, option type
    const instrument = parseInstrumentName(instrumentName);
    if (!instrument || instrument.instrumentType !== "option") {
      throw new Error(
        `Invalid option instrument: ${instrumentName} (must be an option, not future/perpetual)`
      );
    }

    const { strike, expiration, optionType } = instrument;

    // Get trades from database
    const trades = this.database.getTrades(
      instrumentName,
      startTimestamp,
      endTimestamp
    );

    if (trades.length === 0) {
      progress.endTime = Date.now();
      return progress;
    }

    const greeksBuffer: Greeks[] = [];

    for (const trade of trades) {
      // Skip trades without implied volatility
      if (!trade.impliedVolatility) {
        continue;
      }

      // Calculate time to expiry in years
      const timeToExpiry = Math.max(
        0,
        (expiration - trade.timestamp) / (365.25 * 24 * 60 * 60 * 1000)
      );

      // Use index price as forward price (for crypto, spot ≈ forward)
      const forwardPrice = trade.indexPrice;

      // Calculate greeks
      const result = calculateGreeks(
        forwardPrice,
        strike,
        timeToExpiry,
        trade.impliedVolatility,
        optionType
      );

      greeksBuffer.push({
        instrumentName,
        timestamp: trade.timestamp,
        delta: result.delta,
        gamma: result.gamma,
        vega: result.vega,
        theta: result.theta,
        price: result.price,
        underlyingPrice: forwardPrice,
        impliedVolatility: trade.impliedVolatility,
      });

      progress.totalCalculated++;

      // Flush to database when buffer is full
      if (greeksBuffer.length >= this.dbBatchSize) {
        this.database.insertGreeks(greeksBuffer);
        progress.batchesProcessed++;
        greeksBuffer.length = 0;

        if (onProgress) {
          onProgress({ ...progress });
        }
      }
    }

    // Flush remaining greeks
    if (greeksBuffer.length > 0) {
      this.database.insertGreeks(greeksBuffer);
      progress.batchesProcessed++;
    }

    progress.endTime = Date.now();

    if (onProgress) {
      onProgress({ ...progress });
    }

    return progress;
  }

  /**
   * Calculate greeks for multiple instruments
   *
   * @param instrumentNames - Array of instrument names
   * @param startTimestamp - Optional start time filter
   * @param endTimestamp - Optional end time filter
   * @param onProgress - Optional progress callback
   * @returns Array of calculation progress
   */
  async calculateForMultipleInstruments(
    instrumentNames: string[],
    startTimestamp?: number,
    endTimestamp?: number,
    onProgress?: (progress: CalculationProgress) => void
  ): Promise<CalculationProgress[]> {
    const results: CalculationProgress[] = [];

    for (const instrumentName of instrumentNames) {
      try {
        const progress = await this.calculateForInstrument(
          instrumentName,
          startTimestamp,
          endTimestamp,
          onProgress
        );
        results.push(progress);
      } catch (error) {
        console.error(
          `Failed to calculate greeks for ${instrumentName}:`,
          error
        );
        // Continue with other instruments
      }
    }

    return results;
  }

  /**
   * Calculate greeks for all instruments in the database
   *
   * @param onProgress - Optional progress callback
   * @returns Array of calculation progress
   */
  async calculateForAllInstruments(
    onProgress?: (progress: CalculationProgress) => void
  ): Promise<CalculationProgress[]> {
    const instruments = this.database.getInstruments();
    return this.calculateForMultipleInstruments(
      instruments,
      undefined,
      undefined,
      onProgress
    );
  }

  /**
   * Get greeks summary statistics for an instrument
   *
   * @param instrumentName - Instrument name
   * @returns Summary stats (min, max, avg for each greek)
   */
  getGreeksSummary(instrumentName: string): {
    count: number;
    delta: { min: number; max: number; avg: number };
    gamma: { min: number; max: number; avg: number };
    vega: { min: number; max: number; avg: number };
    theta: { min: number; max: number; avg: number };
  } | null {
    const greeks = this.database.getGreeks(instrumentName);

    if (greeks.length === 0) {
      return null;
    }

    const calculateStats = (values: number[]) => ({
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    });

    return {
      count: greeks.length,
      delta: calculateStats(greeks.map((g) => g.delta)),
      gamma: calculateStats(greeks.map((g) => g.gamma)),
      vega: calculateStats(greeks.map((g) => g.vega)),
      theta: calculateStats(greeks.map((g) => g.theta)),
    };
  }
}
