import type { Clock, IdempotencyStore } from "./types.js";

/** Thrown when a request with the same key is already running (Stripe returns 409 for this). */
export class IdempotencyInProgressError extends Error {
  constructor(public readonly key: string) {
    super(`An operation with idempotency key "${key}" is already in progress`);
    this.name = "IdempotencyInProgressError";
  }
}

export interface WithIdempotencyOptions<T> {
  store: IdempotencyStore;
  /** ms; default Date.now. Injectable for tests. */
  now?: Clock;
  /** Serialize the result for storage. Default JSON.stringify. */
  serialize?: (value: T) => string;
  /** Deserialize a replayed result. Default JSON.parse. */
  deserialize?: (raw: string) => T;
  /**
   * If a concurrent request holds the key, poll this many times (default 0 =
   * fail fast with IdempotencyInProgressError) waiting for it to complete.
   */
  waitRetries?: number;
  /** ms between waitRetries polls. Default 100. */
  waitIntervalMs?: number;
}

export interface IdempotentResult<T> {
  value: T;
  /** True if this returned a stored result instead of running `fn`. */
  replayed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` at most once per `key`. The first call executes and stores the
 * result; later calls with the same key return the stored result without
 * re-running. This is the Stripe Idempotency-Key pattern — safe retries, no
 * double-charges/double-sends — and the same exactly-once idea behind a
 * reservation engine like Holdfast.
 *
 * Concurrency: two simultaneous calls race on store.claim(); exactly one wins
 * and runs `fn`. The loser either fails fast (default) or, with `waitRetries`,
 * polls until the winner's result is available.
 *
 * Failure: if `fn` throws, the claim is released so a later retry can run — a
 * transient error doesn't permanently poison the key.
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  opts: WithIdempotencyOptions<T>,
): Promise<IdempotentResult<T>> {
  const now = opts.now ?? (() => Date.now());
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize = opts.deserialize ?? ((r: string) => JSON.parse(r) as T);
  const waitRetries = opts.waitRetries ?? 0;
  const waitIntervalMs = opts.waitIntervalMs ?? 100;

  for (let attempt = 0; ; attempt++) {
    const existing = await opts.store.claim(key, now());

    if (existing === null) {
      // We own execution.
      try {
        const value = await fn();
        await opts.store.complete(key, serialize(value), now());
        return { value, replayed: false };
      } catch (err) {
        await opts.store.release(key);
        throw err;
      }
    }

    if (existing.status === "completed" && existing.result !== undefined) {
      return { value: deserialize(existing.result), replayed: true };
    }

    // in_progress held by someone else.
    if (attempt < waitRetries) {
      await sleep(waitIntervalMs);
      continue;
    }
    throw new IdempotencyInProgressError(key);
  }
}
