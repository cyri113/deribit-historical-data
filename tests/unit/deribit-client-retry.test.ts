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
//
// Follow-up regression: the initial fix only retried HTTP 429 and exactly
// HTTP 503, not the general 5xx class -- a real production run hit HTTP 500
// from getInstruments and failed immediately instead of retrying. Fixed to
// retry any 5xx, while structurally distinguishing HTTP status codes from
// Deribit's separate JSON-RPC error-code numeric space (via
// DeribitAPIError.isHttpStatus) so a JSON-RPC protocol error can never be
// misclassified as a retryable HTTP 5xx just because its numeric code
// happens to fall in 500-599.

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

  test("getInstruments retries on HTTP 500 (regression: real production failure -- only 429/503 were retried initially, not the general 5xx class)", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.getInstruments("BTC", "option", true);

    expect(result).toEqual([]);
    expect(callCount).toBe(3);
  });

  test("retries any 5xx status (502, 504), not just 500/503 specifically", async () => {
    for (const status of [502, 504]) {
      let callCount = 0;
      global.fetch = (async () => {
        callCount++;
        if (callCount < 2) {
          return new Response("Gateway Error", { status });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
      }) as typeof fetch;

      const client = makeClient();
      const result = await client.getInstruments("BTC");

      expect(result).toEqual([]);
      expect(callCount).toBe(2);
    }
  });

  test("a DeribitAPIError with a 5xx-range code is NOT retried unless isHttpStatus is set (structural HTTP-status vs JSON-RPC-code distinction)", async () => {
    // Deribit's JSON-RPC error codes are a separate numeric space from HTTP
    // status codes (documented codes cluster in -32000..-32700 and
    // 10000-13999; none currently sit in 500-599). isHttpStatus makes the
    // distinction structural rather than relying on that coincidence never
    // changing. Every live GET-based endpoint (getInstruments, etc.) always
    // sets isHttpStatus=true on its DeribitAPIError (via throwForResponse),
    // so this exercises the underlying classification directly rather than
    // through a live endpoint -- there's currently no reachable code path
    // that constructs a DeribitAPIError with a 5xx code and isHttpStatus
    // unset (the JSON-RPC-error branch that would is unreachable dead code,
    // see `request()`), but the classification itself must still be correct
    // in case that ever changes.
    const { DeribitAPIError, DeribitRateLimitError } = await import(
      "../../src/infrastructure/deribit-client.ts"
    );
    const client = makeClient() as any;

    const httpStatusError = new DeribitAPIError("server error", 500, undefined, true);
    const jsonRpcCodeError = new DeribitAPIError("protocol error", 500, undefined, false);
    const jsonRpcCodeErrorOmitted = new DeribitAPIError("protocol error", 500);

    expect(client.isRetryable(httpStatusError)).toBe(true);
    expect(client.isRetryable(jsonRpcCodeError)).toBe(false);
    expect(client.isRetryable(jsonRpcCodeErrorOmitted)).toBe(false);
    expect(client.isRetryable(new DeribitRateLimitError("rate limited"))).toBe(true);
    expect(client.isRetryable(new DeribitAPIError("bad request", 400, undefined, true))).toBe(false);
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
