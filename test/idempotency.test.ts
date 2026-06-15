import { describe, it, expect, vi } from "vitest";
import {
  withIdempotency,
  fingerprint,
  IdempotencyInProgressError,
  IdempotencyFingerprintMismatchError,
  MemoryIdempotencyStore,
} from "../src/index.js";

describe("withIdempotency", () => {
  it("runs fn once, replays the stored result on retry", async () => {
    const store = new MemoryIdempotencyStore();
    const fn = vi.fn(async () => ({ chargeId: "ch_1" }));

    const first = await withIdempotency("k1", fn, { store });
    const second = await withIdempotency("k1", fn, { store });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ value: { chargeId: "ch_1" }, replayed: false });
    expect(second).toEqual({ value: { chargeId: "ch_1" }, replayed: true });
  });

  it("collapses concurrent same-key calls to a single execution", async () => {
    const store = new MemoryIdempotencyStore();
    let running = 0;
    let maxConcurrent = 0;
    const fn = vi.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return "ok";
    });

    // One winner runs; the other waits for it and replays.
    const [a, b] = await Promise.all([
      withIdempotency("dup", fn, { store, waitRetries: 10, waitIntervalMs: 5 }),
      withIdempotency("dup", fn, { store, waitRetries: 10, waitIntervalMs: 5 }),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
    expect(a.value).toBe("ok");
    expect(b.value).toBe("ok");
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1); // exactly one replay
  });

  it("fails fast with IdempotencyInProgressError when not waiting", async () => {
    const store = new MemoryIdempotencyStore();
    // Manually leave an in_progress claim.
    await store.claim("busy", Date.now());
    await expect(
      withIdempotency("busy", async () => "x", { store }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it("releases the claim when fn throws, so a retry can run", async () => {
    const store = new MemoryIdempotencyStore();
    await expect(
      withIdempotency(
        "k",
        async () => {
          throw new Error("boom");
        },
        { store },
      ),
    ).rejects.toThrow("boom");

    // Key is free again — a retry executes.
    const retry = await withIdempotency("k", async () => "recovered", {
      store,
    });
    expect(retry).toEqual({ value: "recovered", replayed: false });
  });

  it("expires records after ttl so the key can be reused", async () => {
    let t = 1000;
    const store = new MemoryIdempotencyStore(100); // 100ms ttl
    const r1 = await withIdempotency("k", async () => "first", {
      store,
      now: () => t,
    });
    expect(r1.replayed).toBe(false);

    t += 50;
    const r2 = await withIdempotency("k", async () => "second", {
      store,
      now: () => t,
    });
    expect(r2).toEqual({ value: "first", replayed: true }); // still fresh

    t += 100; // now past ttl
    const r3 = await withIdempotency("k", async () => "third", {
      store,
      now: () => t,
    });
    expect(r3).toEqual({ value: "third", replayed: false }); // expired → re-runs
  });

  it("rejects a key reused with a different request fingerprint", async () => {
    const store = new MemoryIdempotencyStore();
    const charge = vi.fn(async () => ({ chargeId: "ch_1" }));

    const first = await withIdempotency("key-A", charge, {
      store,
      fingerprint: fingerprint({ amount: 1000, currency: "usd" }),
    });
    expect(first.replayed).toBe(false);

    // Same key, different payload → must fail loudly, not replay the $10 charge.
    await expect(
      withIdempotency("key-A", charge, {
        store,
        fingerprint: fingerprint({ amount: 9999, currency: "usd" }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyFingerprintMismatchError);
    expect(charge).toHaveBeenCalledTimes(1);

    // Same key, same payload (retry) → replays cleanly.
    const retry = await withIdempotency("key-A", charge, {
      store,
      fingerprint: fingerprint({ amount: 1000, currency: "usd" }),
    });
    expect(retry).toEqual({ value: { chargeId: "ch_1" }, replayed: true });
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("fingerprint is key-order independent and distinguishes different values", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1, b: { c: 3, d: 4 } })).toBe(
      fingerprint({ b: { d: 4, c: 3 }, a: 1 }),
    );
    expect(fingerprint({ amount: 1000 })).not.toBe(
      fingerprint({ amount: 1001 }),
    );
    expect(fingerprint([1, 2, 3])).not.toBe(fingerprint([3, 2, 1]));
    expect(fingerprint("10")).not.toBe(fingerprint(10));
  });

  it("supports custom serialize/deserialize", async () => {
    const store = new MemoryIdempotencyStore();
    const opts = {
      store,
      serialize: (v: Date) => v.toISOString(),
      deserialize: (r: string) => new Date(r),
    };
    const d = new Date("2026-06-12T00:00:00.000Z");
    await withIdempotency("k", async () => d, opts);
    const replay = await withIdempotency("k", async () => new Date(), opts);
    expect(replay.value.toISOString()).toBe(d.toISOString());
    expect(replay.replayed).toBe(true);
  });
});
