import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { DeribitClient } from "../../src/infrastructure/deribit-client.ts";
import { RateLimiter } from "../../src/infrastructure/rate-limiter.ts";

// Regression coverage for: every real Deribit endpoint (getInstruments,
// getTradesBySeq, getHistoricalVolatility, getDeliveryPrices,
// getLastTradeSeq) used to bypass DeribitClient's retry/backoff logic
// entirely -- that logic only lived in the never-called private `request()`
// method. A single transient 429/503 mid-pagination would throw immediately
// and silently drop that instrument's trade history for the run, with no
// automatic recovery -- a real survivorship-bias mechanism for a historical
// dataset. Fixed by routing every endpoint through a shared `withRetry`
// helper. These tests mock `fetch` to verify retry actually happens now.

describe("DeribitClient retry/backoff (regression: endpoints bypassing retry logic)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeClient() {
    // High-capacity rate limiter and near-zero retry delay so tests run fast.
    return new DeribitClient({
      rateLimiter: new RateLimiter(1000, 1000),
      maxRetries: 3,
      retryDelay: 1,
    });
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("getInstruments retries on HTTP 429 and eventually succeeds", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getInstruments("BTC", "option", true);

    expect(result).toEqual([]);
    expect(callCount).toBe(3);
  });

  test("getTradesBySeq (the pagination hot path) retries on HTTP 429 instead of throwing immediately", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount < 2) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { trades: [], has_more: false },
      });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getTradesBySeq("BTC-1JAN24-50000-C", 1, 100);

    expect(result.hasMore).toBe(false);
    expect(callCount).toBe(2);
  });

  test("getHistoricalVolatility retries on HTTP 503", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount < 2) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getHistoricalVolatility("BTC");

    expect(result).toEqual([]);
    expect(callCount).toBe(2);
  });

  test("getDeliveryPrices retries on HTTP 429", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount < 2) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { data: [], records_total: 0 },
      });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getDeliveryPrices("btc_usd");

    expect(result.recordsTotal).toBe(0);
    expect(callCount).toBe(2);
  });

  test("a fatal (non-retryable) error still throws immediately without retrying", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    }) as typeof fetch;

    const client = makeClient();
    await expect(client.getInstruments("BTC")).rejects.toThrow();
    // Non-retryable errors (not 429/503) must fail on the first attempt, not
    // silently retry and mask the real error.
    expect(callCount).toBe(1);
  });

  test("getLastTradeSeq treats HTTP 404 as 'no trades' (0) without retrying, but still retries transient 429s", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getLastTradeSeq("BTC-1JAN24-50000-C");

    // 429 on attempt 1 retried, then 404 on attempt 2 resolves to 0 (no
    // trades) rather than being retried forever or thrown as fatal.
    expect(result).toBe(0);
    expect(callCount).toBe(2);
  });

  test("exhausting all retries on persistent 429s throws (not an infinite loop)", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("Too Many Requests", { status: 429 });
    }) as typeof fetch;

    const client = makeClient();
    await expect(client.getInstruments("BTC")).rejects.toThrow(/Max retries/);
    // maxRetries=3 means attempts 0,1,2,3 = 4 total calls.
    expect(callCount).toBe(4);
  });
});
