import type { Clock, IdempotencyStore } from "./types.js";

/** Thrown when a request with the same key is already running (Stripe returns 409 for this). */
export class IdempotencyInProgressError extends Error {
  constructor(public readonly key: string) {
    super(`An operation with idempotency key "${key}" is already in progress`);
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * Thrown when a key is reused with a different request fingerprint — i.e. the
 * same Idempotency-Key was sent for a *different* operation. Stripe returns a
 * 400 for this; replaying the first result would be silently wrong, so we fail
 * loudly instead.
 */
export class IdempotencyFingerprintMismatchError extends Error {
  constructor(
    public readonly key: string,
    public readonly expected: string,
    public readonly received: string,
  ) {
    super(
      `Idempotency key "${key}" was already used with a different request fingerprint`,
    );
    this.name = "IdempotencyFingerprintMismatchError";
  }
}

/**
 * Canonical-JSON fingerprint of a request payload: object keys are sorted
 * recursively so `{a,b}` and `{b,a}` hash equal, then hashed (FNV-1a, mixed
 * with a second pass + length) to a short hex string. Stable across processes
 * and runtime-agnostic — no node:crypto, so it runs on edge/Deno/browsers too.
 *
 * Pass the result as `fingerprint` to withIdempotency to reject a key reused
 * for a different payload. Not a cryptographic hash — it guards against
 * accidental key reuse, not adversarial collisions.
 */
export function fingerprint(value: unknown): string {
  const canonical = canonicalize(value);
  // FNV-1a 32-bit, plus a djb2-style second accumulator, combined with the
  // input length — cheap and low-collision for this guard's purposes.
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 =
      (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${canonical.length.toString(16)}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  // Default (code-unit) sort is intentional: a canonical fingerprint must order
  // keys identically on every machine. localeCompare would vary by locale.
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
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
  /**
   * A fingerprint of this request's payload (see the `fingerprint` helper). If
   * the key was first claimed with a different fingerprint, throws
   * IdempotencyFingerprintMismatchError instead of replaying the wrong result.
   */
  fingerprint?: string;
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
    const existing = await opts.store.claim(key, now(), opts.fingerprint);

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

    // Same key, different request → loud failure, never a wrong replay.
    if (
      opts.fingerprint !== undefined &&
      existing.fingerprint !== undefined &&
      existing.fingerprint !== opts.fingerprint
    ) {
      throw new IdempotencyFingerprintMismatchError(
        key,
        existing.fingerprint,
        opts.fingerprint,
      );
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
