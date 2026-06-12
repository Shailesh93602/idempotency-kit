import { describe, it, expect, vi } from "vitest";
import {
  withIdempotency,
  IdempotencyInProgressError,
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
