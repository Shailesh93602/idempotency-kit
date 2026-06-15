import type {
  IdempotencyRecord,
  IdempotencyStore,
  RateLimitDecision,
  RateLimitStore,
} from "../types.js";

/**
 * In-memory idempotency store. Correct for a single process (JS is
 * single-threaded, so claim() is atomic by construction). Records expire after
 * `ttlMs` so the map doesn't grow forever. Swap for a Redis-backed store in a
 * multi-instance deployment.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private fresh(rec: IdempotencyRecord | undefined, now: number): boolean {
    return !!rec && now - rec.createdAt < this.ttlMs;
  }

  async claim(
    key: string,
    now: number,
    fingerprint?: string,
  ): Promise<IdempotencyRecord | null> {
    const existing = this.map.get(key);
    if (this.fresh(existing, now)) return existing!;
    const rec: IdempotencyRecord = {
      status: "in_progress",
      createdAt: now,
      fingerprint,
    };
    this.map.set(key, rec);
    return null;
  }

  async complete(key: string, result: string, now: number): Promise<void> {
    // Preserve the fingerprint captured at claim time — it identifies the
    // request for the key's whole lifetime, including after completion.
    const fingerprint = this.map.get(key)?.fingerprint;
    this.map.set(key, {
      status: "completed",
      result,
      createdAt: now,
      fingerprint,
    });
  }

  async release(key: string): Promise<void> {
    const rec = this.map.get(key);
    if (rec && rec.status === "in_progress") this.map.delete(key);
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.map.get(key) ?? null;
  }
}

/**
 * In-memory sliding-window-log rate limiter store. Keeps the timestamps of
 * recent hits per key and prunes the window on each call. Single-process only;
 * for distributed limits implement record() as a Redis Lua script.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  async record(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<RateLimitDecision> {
    const cutoff = now - windowMs;
    const pruned = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (pruned.length < limit) {
      pruned.push(now);
      this.hits.set(key, pruned);
      return { allowed: true, count: pruned.length, oldest: pruned[0]! };
    }

    this.hits.set(key, pruned);
    return {
      allowed: false,
      count: pruned.length,
      oldest: pruned.length ? pruned[0]! : null,
    };
  }
}
