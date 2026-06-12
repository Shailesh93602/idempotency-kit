/**
 * Core contracts for idempotency-kit.
 *
 * Both features (idempotency + rate limiting) push their one atomic operation
 * down into a Store. The in-memory stores are correct for a single process;
 * for a distributed setup you implement the same tiny interface over Redis (a
 * SETNX for idempotency, a Lua script for the rate-limit window) and everything
 * above stays the same.
 */

/** A monotonic-ish clock in milliseconds. Injectable so tests are deterministic. */
export type Clock = () => number;

// ── Idempotency ────────────────────────────────────────────────────────────

export type IdempotencyStatus = "in_progress" | "completed";

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  /** Serialized result, present once status is "completed". */
  result?: string;
  createdAt: number;
}

export interface IdempotencyStore {
  /**
   * Atomically claim a key. If the key is free, create an `in_progress` record
   * and return null (caller now owns execution). If it already exists, return
   * the existing record without modifying it. This atomicity is the whole point
   * — it's what makes two concurrent retries collapse to one execution.
   */
  claim(key: string, now: number): Promise<IdempotencyRecord | null>;
  /** Mark a claimed key completed with its serialized result. */
  complete(key: string, result: string, now: number): Promise<void>;
  /** Drop an in_progress claim (on failure) so a later retry can run. */
  release(key: string): Promise<void>;
  /** Read a record without mutating it. */
  get(key: string): Promise<IdempotencyRecord | null>;
}

// ── Rate limiting ──────────────────────────────────────────────────────────

export interface RateLimitDecision {
  allowed: boolean;
  /** Hits counted in the current window (including this one if allowed). */
  count: number;
  /** Timestamp (ms) of the oldest hit still in the window, or null if none. */
  oldest: number | null;
}

export interface RateLimitStore {
  /**
   * Atomically, for a sliding window of `windowMs` ending at `now`: prune hits
   * older than the window; if the remaining count is below `limit`, record a hit
   * at `now` and return allowed=true; otherwise return allowed=false without
   * recording. Returns the post-decision count and the oldest in-window hit.
   */
  record(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<RateLimitDecision>;
}
