# idempotency-kit

> Make write endpoints retry-safe and abuse-resistant — in a few lines.

Two primitives every write API eventually needs, done right and dependency-free:

- **`withIdempotency`** — run an operation **at most once per key**. The Stripe `Idempotency-Key` pattern: networks retry, clients double-click, webhooks redeliver — and you still charge/send/create exactly once.
- **`RateLimiter`** — a **sliding-window** rate limiter (smoother than fixed windows, no boundary bursts).

Both run on a tiny pluggable async **Store**. An in-memory store is included; implement the same interface over Redis/Postgres for distributed use — nothing above the store changes.

- **Zero runtime dependencies.** TypeScript, ESM, fully typed.
- **Deterministic + offline-testable.** Inject the clock; no real time or network needed in tests.
- **Correctness-first.** The one operation that must be atomic lives in the store (a SETNX / Lua script in Redis) — not smeared across app code.

---

## Install

```bash
npm install idempotency-kit
```

## Idempotency

```ts
import { withIdempotency, MemoryIdempotencyStore } from "idempotency-kit";

const store = new MemoryIdempotencyStore(); // swap for a Redis-backed store in prod

async function createCharge(req) {
  const { value, replayed } = await withIdempotency(
    req.headers["idempotency-key"],
    () => psp.charge(req.body), // runs at most once per key
    { store },
  );
  return { charge: value, replayed };
}
```

- First call runs `psp.charge` and stores the result.
- Any retry with the same key returns the **stored** result (`replayed: true`) — no second charge.
- Two **concurrent** calls race on the store; exactly one runs. The other fails fast with `IdempotencyInProgressError` (return a 409), or set `waitRetries` to have it wait for the winner and replay:

```ts
await withIdempotency(key, fn, { store, waitRetries: 10, waitIntervalMs: 100 });
```

- If `fn` **throws**, the claim is released so a later retry can run — a transient failure doesn't permanently poison the key.
- Non-JSON results? Pass `serialize` / `deserialize`.

## Rate limiting

```ts
import { RateLimiter, MemoryRateLimitStore } from "idempotency-kit";

const limiter = new RateLimiter({
  store: new MemoryRateLimitStore(),
  limit: 100,
  windowMs: 15 * 60 * 1000, // 100 requests / 15 min
});

const { allowed, remaining, retryAfterMs } = await limiter.check(req.ip);
if (!allowed) {
  res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
  return res.status(429).end();
}
```

- **Sliding window**, so 100/15min can't be bypassed by bunching requests at a window edge.
- **Rejected requests don't consume slots**, so a flood can't keep its own window full forever.
- `check` returns `{ allowed, limit, remaining, resetAt, retryAfterMs }` — everything you need for `X-RateLimit-*` / `Retry-After` headers.

## Bring your own store (Redis, Postgres, …)

Implement the small interface and stay correct across instances:

```ts
interface IdempotencyStore {
  claim(key, now): Promise<IdempotencyRecord | null>; // atomic insert-if-absent (SETNX)
  complete(key, result, now): Promise<void>;
  release(key): Promise<void>;
  get(key): Promise<IdempotencyRecord | null>;
}

interface RateLimitStore {
  // atomic: prune window, allow+record if under limit, else reject (a Redis Lua script)
  record(key, now, windowMs, limit): Promise<RateLimitDecision>;
}
```

The atomic step is deliberately the _only_ thing the store does — that's the part a distributed system must get right, and it's where you'd drop a Lua script.

## Why these two together

A reliable write endpoint needs both: idempotency so **correct** clients can safely retry, and rate limiting so **abusive** ones can't take you down. They're the patterns behind real payment integrations (Stripe/Razorpay idempotency keys), an inventory reservation engine's exactly-once guarantee, and a production per-IP API limiter.

## License

MIT
