import { RateLimiter } from "./rate-limiter.ts";
import {
  DeribitTradesResponseSchema,
  DeribitDeliveryPricesResponseSchema,
  DeribitInstrumentsResponseSchema,
  DeribitHistoricalVolatilityResponseSchema,
  type DeribitTrade,
  type DeribitDeliveryPrice,
  type DeribitInstrument,
  type DeribitHistoricalVolatility,
} from "../domain/models.ts";

export class DeribitAPIError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown
  ) {
    super(message);
    this.name = "DeribitAPIError";
  }
}

export class DeribitRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeribitRateLimitError";
  }
}

export interface DeribitClientConfig {
  baseUrl?: string;
  historyBaseUrl?: string;
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Deribit JSON-RPC 2.0 API Client
 *
 * Handles HTTP communication with Deribit public API endpoints
 * with built-in rate limiting, retries, and error handling
 */
export class DeribitClient {
  private readonly baseUrl: string;
  private readonly historyBaseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private requestId = 1;

  constructor(config: DeribitClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://www.deribit.com/api/v2";
    this.historyBaseUrl = config.historyBaseUrl ?? "https://history.deribit.com/api/v2";
    this.rateLimiter =
      config.rateLimiter ?? new RateLimiter(15, 15); // 15 req/s
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000; // 1 second
  }

  /**
   * Make a JSON-RPC request to Deribit API
   */
  private async request<T>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const id = this.requestId++;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Wait for rate limiter
        await this.rateLimiter.acquire();

        const response = await fetch(`${this.baseUrl}/public/${method}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000), // 60 second timeout
        });

        if (!response.ok) {
          if (response.status === 429) {
            throw new DeribitRateLimitError(
              `Rate limit exceeded (HTTP 429)`
            );
          }
          throw new DeribitAPIError(
            `HTTP error: ${response.status} ${response.statusText}`,
            response.status
          );
        }

        const data = await response.json();

        // Check for JSON-RPC error
        if (data.error) {
          const error = data.error;
          // Error code 10028 = too_many_requests
          if (error.code === 10028) {
            throw new DeribitRateLimitError(
              `Rate limit exceeded (error 10028): ${error.message}`
            );
          }
          throw new DeribitAPIError(
            error.message ?? "Unknown API error",
            error.code,
            error.data
          );
        }

        return data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on non-retryable errors
        if (
          !(error instanceof DeribitRateLimitError) &&
          !(error instanceof DeribitAPIError && error.code === 503)
        ) {
          throw error;
        }

        // Exponential backoff
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new DeribitAPIError(
      `Max retries (${this.maxRetries}) exceeded: ${lastError?.message}`,
      undefined,
      lastError
    );
  }

  /**
   * Fetch historical delivery prices for an index
   *
   * @param indexName - e.g., "btc_usd"
   * @param offset - Pagination offset (default 0)
   * @param count - Max records to return (default 100)
   * @returns Array of delivery prices and total records
   */
  async getDeliveryPrices(
    indexName: string,
    offset: number = 0,
    count: number = 100
  ): Promise<{ data: DeribitDeliveryPrice[]; recordsTotal: number }> {
    // Wait for rate limiter
    await this.rateLimiter.acquire();

    // Build query params
    const params = new URLSearchParams({
      index_name: indexName,
      offset: String(offset),
      count: String(count),
    });

    const url = `${this.baseUrl}/public/get_delivery_prices?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!response.ok) {
      throw new DeribitAPIError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    const validated = DeribitDeliveryPricesResponseSchema.parse(data);
    return {
      data: validated.result.data,
      recordsTotal: validated.result.records_total,
    };
  }

  /**
   * Fetch all delivery prices for an index (handles pagination automatically)
   *
   * @param indexName - e.g., "btc_usd"
   * @param batchSize - Records per request (default 100)
   * @returns All delivery prices
   */
  async *getAllDeliveryPrices(
    indexName: string,
    batchSize: number = 100
  ): AsyncGenerator<DeribitDeliveryPrice[]> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, recordsTotal } = await this.getDeliveryPrices(
        indexName,
        offset,
        batchSize
      );

      if (data.length > 0) {
        yield data;
      }

      offset += data.length;
      hasMore = offset < recordsTotal;
    }
  }

  /**
   * Fetch all instruments for a currency
   *
   * @param currency - e.g., "BTC", "ETH"
   * @param kind - Instrument type (option, future, spot)
   * @param expired - Include expired instruments (default false)
   * @returns Array of instruments
   */
  async getInstruments(
    currency: string,
    kind?: "future" | "option" | "spot",
    expired: boolean = false
  ): Promise<DeribitInstrument[]> {
    // Wait for rate limiter
    await this.rateLimiter.acquire();

    // Build query params
    const params = new URLSearchParams({
      currency,
      expired: String(expired),
    });

    if (kind) {
      params.set("kind", kind);
    }

    const url = `${this.historyBaseUrl}/public/get_instruments?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!response.ok) {
      throw new DeribitAPIError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    const validated = DeribitInstrumentsResponseSchema.parse(data);
    return validated.result;
  }

  /**
   * Fetch historical volatility data for a currency
   *
   * @param currency - e.g., "BTC", "ETH"
   * @returns Array of [timestamp, volatility] tuples
   */
  async getHistoricalVolatility(
    currency: string
  ): Promise<DeribitHistoricalVolatility[]> {
    // Wait for rate limiter
    await this.rateLimiter.acquire();

    // Build query params
    const params = new URLSearchParams({
      currency,
    });

    const url = `${this.baseUrl}/public/get_historical_volatility?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!response.ok) {
      throw new DeribitAPIError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    const validated = DeribitHistoricalVolatilityResponseSchema.parse(data);
    return validated.result;
  }

  /**
   * Get the last trade_seq for an instrument (from history API)
   * Returns null if instrument has no trades, or if API call fails after retries
   *
   * @param instrumentName - e.g., "BTC-PERPETUAL"
   * @returns Last trade_seq, 0 if no trades, null if could not be determined
   */
  async getLastTradeSeq(instrumentName: string): Promise<number | null> {
    try {
      await this.rateLimiter.acquire();

      // Fetch one trade in descending order to get the latest trade_seq
      const params = new URLSearchParams({
        instrument_name: instrumentName,
        count: "1",
        include_old: "true",
      });

      const url = `${this.historyBaseUrl}/public/get_last_trades_by_instrument?${params}`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(60000), // 60 second timeout
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 400) {
          // 404: Instrument exists but has no trades
          // 400: Instrument doesn't exist or invalid name
          return 0;
        }
        throw new DeribitAPIError(
          `HTTP error: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();
      const validated = DeribitTradesResponseSchema.parse(data);

      if (validated.result.trades.length === 0) {
        return 0;
      }

      return validated.result.trades[0]!.trade_seq;
    } catch (error) {
      console.error(`Failed to get last_seq for ${instrumentName}:`, error);
      return null;
    }
  }

  /**
   * Fetch trades by trade_seq range using history API
   * Follows design decision #1: page by trade_seq, not time
   *
   * @param instrumentName - e.g., "BTC-PERPETUAL"
   * @param startSeq - Starting trade_seq (inclusive)
   * @param endSeq - Ending trade_seq (inclusive)
   * @param count - Max trades per request (default 10000, Deribit's max)
   * @returns Trades and hasMore flag
   */
  async getTradesBySeq(
    instrumentName: string,
    startSeq: number,
    endSeq: number,
    count: number = 10000
  ): Promise<{ trades: DeribitTrade[]; hasMore: boolean }> {
    await this.rateLimiter.acquire();

    const params = new URLSearchParams({
      instrument_name: instrumentName,
      start_seq: String(startSeq),
      end_seq: String(endSeq),
      count: String(count),
      include_old: "true",
    });

    const url = `${this.historyBaseUrl}/public/get_last_trades_by_instrument?${params}`;

    console.log(`📡 API Request: ${url}`);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!response.ok) {
      throw new DeribitAPIError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    const validated = DeribitTradesResponseSchema.parse(data);

    const firstSeq = validated.result.trades.length > 0 ? validated.result.trades[0].trade_seq : null;
    const lastSeq = validated.result.trades.length > 0 ? validated.result.trades[validated.result.trades.length - 1].trade_seq : null;

    console.log(`📨 API Response: ${instrumentName} | received ${validated.result.trades.length} trades | first_seq=${firstSeq} | last_seq=${lastSeq} | has_more=${validated.result.has_more}`);

    return {
      trades: validated.result.trades,
      hasMore: validated.result.has_more,
    };
  }

  /**
   * Fetch all trades in a seq range (handles pagination)
   * Generator that yields batches of trades
   *
   * @param instrumentName - e.g., "BTC-PERPETUAL"
   * @param startSeq - Starting trade_seq (inclusive)
   * @param endSeq - Ending trade_seq (inclusive)
   * @param batchSize - Trades per request (default 10000)
   */
  async *getAllTradesBySeq(
    instrumentName: string,
    startSeq: number,
    endSeq: number,
    batchSize: number = 10000
  ): AsyncGenerator<DeribitTrade[]> {
    let currentSeq = startSeq;
    let previousSeq = -1; // Loop detection

    while (currentSeq <= endSeq) {
      // Safety: detect infinite loop
      if (currentSeq === previousSeq) {
        console.error(`🚨 LOOP DETECTED: ${instrumentName} stuck at seq=${currentSeq} - breaking to prevent infinite loop`);
        break;
      }
      previousSeq = currentSeq;

      const { trades, hasMore } = await this.getTradesBySeq(
        instrumentName,
        currentSeq,
        endSeq,
        batchSize
      );

      if (trades.length > 0) {
        yield trades;
        // API returns trades in descending order (newest first)
        // Use Math.max() to find highest trade_seq regardless of order
        const lastTradeSeq = Math.max(...trades.map(t => t.trade_seq));
        currentSeq = lastTradeSeq + 1;
      }

      // hasMore means "more within requested range", not "beyond it"
      if (!hasMore) {
        break;
      }
    }
  }
}
