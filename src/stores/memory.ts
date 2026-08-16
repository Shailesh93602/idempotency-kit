import type {
  IdempotencyRecord,
  IdempotencyStore,
  RateLimitDecision,
  RateLimitStore,
} from "../types.js";

/**
 * In-memory idempotency store. Correct for a single process (JS is
 * single-threaded, so claim() is atomic by construction). Swap for a
 * Redis-backed store in a multi-instance deployment.
 *
 * Records expire after `ttlMs`. Expiry alone isn't enough to bound memory:
 * idempotency keys are unique per request, so a stale record is almost never
 * re-claimed and would sit in the map forever. Expired entries are therefore
 * actively evicted by an amortized sweep every `sweepEvery` claims — O(n) work
 * spread over n calls, so the steady-state map holds only live records.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();
  private claimsSinceSweep = 0;

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    /** Run an eviction sweep once every this many claims. */
    private readonly sweepEvery = 1000,
  ) {}

  /** Live record count. Exposed so memory behaviour is observable/testable. */
  get size(): number {
    return this.map.size;
  }

  /** Drop every record older than `ttlMs`. Returns how many were evicted. */
  sweep(now: number): number {
    let evicted = 0;
    for (const [key, rec] of this.map) {
      if (now - rec.createdAt >= this.ttlMs) {
        this.map.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  private fresh(rec: IdempotencyRecord | undefined, now: number): boolean {
    return !!rec && now - rec.createdAt < this.ttlMs;
  }

  async claim(
    key: string,
    now: number,
    fingerprint?: string,
  ): Promise<IdempotencyRecord | null> {
    if (++this.claimsSinceSweep >= this.sweepEvery) {
      this.claimsSinceSweep = 0;
      this.sweep(now);
    }
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
 *
 * Per-call pruning only shrinks keys you touch again — for a per-IP limiter
 * that means every IP ever seen stays resident. Keys whose whole window has
 * drained are therefore evicted by an amortized sweep every `sweepEvery`
 * records, bounding memory to roughly the set of currently-active keys.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private recordsSinceSweep = 0;

  constructor(
    /** Run an eviction sweep once every this many records. */
    private readonly sweepEvery = 1000,
  ) {}

  /** Tracked key count. Exposed so memory behaviour is observable/testable. */
  get size(): number {
    return this.hits.size;
  }

  /** Drop keys with no hits left inside the window. Returns how many. */
  sweep(now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    let evicted = 0;
    for (const [key, times] of this.hits) {
      if (!times.length || times[times.length - 1]! <= cutoff) {
        this.hits.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  async record(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<RateLimitDecision> {
    if (++this.recordsSinceSweep >= this.sweepEvery) {
      this.recordsSinceSweep = 0;
      this.sweep(now, windowMs);
    }
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
