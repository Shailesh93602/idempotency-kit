/**
 * idempotency-kit — make write endpoints retry-safe and abuse-resistant.
 *
 * - withIdempotency: run an operation at most once per key (Stripe pattern).
 * - RateLimiter: sliding-window rate limiting.
 *
 * Both use a tiny pluggable async Store. In-memory stores are included; bring
 * your own Redis/Postgres implementation of the same interface for distributed
 * use.
 */

export type {
  Clock,
  IdempotencyStatus,
  IdempotencyRecord,
  IdempotencyStore,
  RateLimitDecision,
  RateLimitStore,
} from "./types.js";

export {
  withIdempotency,
  fingerprint,
  IdempotencyInProgressError,
  IdempotencyFingerprintMismatchError,
  type WithIdempotencyOptions,
  type IdempotentResult,
} from "./idempotency.js";

export {
  RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from "./rateLimit.js";

export {
  MemoryIdempotencyStore,
  MemoryRateLimitStore,
} from "./stores/memory.js";
