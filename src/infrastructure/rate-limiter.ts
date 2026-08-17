/**
 * Token Bucket Rate Limiter
 *
 * Implements a token bucket algorithm for rate limiting API requests.
 * Tokens are added at a fixed rate and consumed by requests.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly queue: Array<{
    resolve: () => void;
    tokensNeeded: number;
  }> = [];
  private processingQueue = false;

  /**
   * @param maxTokens - Maximum tokens in bucket (burst capacity)
   * @param refillRate - Tokens added per second
   */
  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Acquire tokens (blocking)
   * Waits until tokens are available
   *
   * @param tokensNeeded - Number of tokens to consume (default 1)
   */
  async acquire(tokensNeeded: number = 1): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ resolve, tokensNeeded });
      this.processQueue();
    });
  }

  /**
   * Process queued requests
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.queue.length > 0) {
      this.refill();

      const next = this.queue[0];
      if (!next) break;

      if (this.tokens >= next.tokensNeeded) {
        this.tokens -= next.tokensNeeded;
        this.queue.shift();
        next.resolve();
      } else {
        // Wait until we have enough tokens
        const tokensNeeded = next.tokensNeeded - this.tokens;
        const waitTime = (tokensNeeded / this.refillRate) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.processingQueue = false;
  }

  /**
   * Try to acquire tokens without blocking
   *
   * @param tokensNeeded - Number of tokens to consume
   * @returns true if tokens were acquired, false otherwise
   */
  tryAcquire(tokensNeeded: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return true;
    }

    return false;
  }

  /**
   * Execute a function with rate limiting
   *
   * @param fn - Function to execute
   * @param tokensNeeded - Tokens to consume (default 1)
   * @returns Result of function execution
   */
  async execute<T>(fn: () => Promise<T>, tokensNeeded: number = 1): Promise<T> {
    await this.acquire(tokensNeeded);
    return fn();
  }

  /**
   * Get current token count
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset limiter to full capacity
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

/**
 * Create a rate limiter configured for Deribit API
 * Deribit limit: 20 req/s, we use 15 req/s for safety (75% capacity)
 */
export function createDeribitRateLimiter(): RateLimiter {
  return new RateLimiter(15, 15); // 15 tokens max, refill at 15/sec
}
