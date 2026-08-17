import { RateLimiter } from "./rate-limiter.ts";
import {
  DeribitTradesResponseSchema,
  DeribitDeliveryPricesResponseSchema,
  DeribitInstrumentsResponseSchema,
  type DeribitTrade,
  type DeribitDeliveryPrice,
  type DeribitInstrument,
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
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private requestId = 1;

  constructor(config: DeribitClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://www.deribit.com/api/v2";
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
   * Fetch historical trades for an instrument within a time range
   *
   * @param instrumentName - e.g., "BTC-29MAR24-50000-C"
   * @param startTimestamp - Start time in milliseconds
   * @param endTimestamp - End time in milliseconds
   * @param count - Max number of trades to return (default 1000)
   * @returns Array of trades and hasMore flag
   */
  async getLastTradesByInstrumentAndTime(
    instrumentName: string,
    startTimestamp: number,
    endTimestamp: number,
    count: number = 1000
  ): Promise<{ trades: DeribitTrade[]; hasMore: boolean }> {
    // Wait for rate limiter
    await this.rateLimiter.acquire();

    // Build query params
    const params = new URLSearchParams({
      instrument_name: instrumentName,
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
      count: String(count),
    });

    const url = `${this.baseUrl}/public/get_last_trades_by_instrument_and_time?${params}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new DeribitAPIError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    const validated = DeribitTradesResponseSchema.parse(data);
    return {
      trades: validated.result.trades,
      hasMore: validated.result.has_more,
    };
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
    const response = await this.request<unknown>("get_delivery_prices", {
      index_name: indexName,
      offset,
      count,
    });

    const validated = DeribitDeliveryPricesResponseSchema.parse(response);
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
   * Fetch all trades for an instrument in a time range (handles pagination)
   *
   * @param instrumentName - e.g., "BTC-29MAR24-50000-C"
   * @param startTimestamp - Start time in milliseconds
   * @param endTimestamp - End time in milliseconds
   * @param batchSize - Trades per request (default 1000)
   * @returns Generator yielding batches of trades
   */
  async *getAllTrades(
    instrumentName: string,
    startTimestamp: number,
    endTimestamp: number,
    batchSize: number = 1000
  ): AsyncGenerator<DeribitTrade[]> {
    let currentStart = startTimestamp;
    let hasMore = true;

    while (hasMore && currentStart < endTimestamp) {
      const { trades, hasMore: more } =
        await this.getLastTradesByInstrumentAndTime(
          instrumentName,
          currentStart,
          endTimestamp,
          batchSize
        );

      if (trades.length > 0) {
        yield trades;
        // Update start to last trade timestamp + 1
        currentStart = trades[trades.length - 1]!.timestamp + 1;
      }

      hasMore = more;
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

    const url = `${this.baseUrl}/public/get_instruments?${params}`;

    const response = await fetch(url);

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
}
