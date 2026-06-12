import type { Clock, RateLimitStore } from "./types.js";

export interface RateLimiterOptions {
  store: RateLimitStore;
  /** Max requests allowed per key within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** ms; default Date.now. Injectable for tests. */
  now?: Clock;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Timestamp (ms) when the window will have room again. */
  resetAt: number;
  /** ms to wait before retrying (0 when allowed). Maps to a Retry-After header. */
  retryAfterMs: number;
}

/**
 * Sliding-window rate limiter — smoother than fixed windows (no burst at the
 * boundary). This is the shape of the per-IP limiter in EduScale and the kind
 * of quota guard you'd put in front of any write API. Counting/pruning is
 * atomic in the store, so swapping the in-memory store for a Redis Lua script
 * makes it correct across instances with no change here.
 */
export class RateLimiter {
  private readonly now: Clock;

  constructor(private readonly opts: RateLimiterOptions) {
    if (opts.limit < 1) throw new Error("limit must be >= 1");
    if (opts.windowMs < 1) throw new Error("windowMs must be >= 1");
    this.now = opts.now ?? (() => Date.now());
  }

  /** Record an attempt for `key` and decide if it's allowed. */
  async check(key: string): Promise<RateLimitResult> {
    const now = this.now();
    const { limit, windowMs } = this.opts;
    const { allowed, count, oldest } = await this.opts.store.record(
      key,
      now,
      windowMs,
      limit,
    );

    // The window frees a slot windowMs after its oldest hit.
    const resetAt = oldest !== null ? oldest + windowMs : now + windowMs;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
    };
  }
}
