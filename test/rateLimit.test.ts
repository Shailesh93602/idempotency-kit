import { describe, it, expect } from "vitest";
import { RateLimiter, MemoryRateLimitStore } from "../src/index.js";

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks within the window", async () => {
    const clock = fixedClock();
    const rl = new RateLimiter({
      store: new MemoryRateLimitStore(),
      limit: 3,
      windowMs: 1000,
      now: clock.now,
    });

    const r1 = await rl.check("ip");
    const r2 = await rl.check("ip");
    const r3 = await rl.check("ip");
    const r4 = await rl.check("ip");

    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r1.remaining).toBe(2);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("slides: a slot frees once the oldest hit ages out", async () => {
    const clock = fixedClock();
    const rl = new RateLimiter({
      store: new MemoryRateLimitStore(),
      limit: 2,
      windowMs: 1000,
      now: clock.now,
    });

    await rl.check("ip"); // t=1000
    clock.advance(500);
    await rl.check("ip"); // t=1500 → window full
    expect((await rl.check("ip")).allowed).toBe(false); // t=1500 still full

    clock.advance(600); // t=2100 → first hit (1000) now outside 1000ms window
    const after = await rl.check("ip");
    expect(after.allowed).toBe(true);
  });

  it("isolates keys", async () => {
    const clock = fixedClock();
    const rl = new RateLimiter({
      store: new MemoryRateLimitStore(),
      limit: 1,
      windowMs: 1000,
      now: clock.now,
    });
    expect((await rl.check("a")).allowed).toBe(true);
    expect((await rl.check("a")).allowed).toBe(false);
    expect((await rl.check("b")).allowed).toBe(true); // different key, fresh
  });

  it("rejected requests don't consume window slots (flood can't self-extend)", async () => {
    const clock = fixedClock();
    const rl = new RateLimiter({
      store: new MemoryRateLimitStore(),
      limit: 1,
      windowMs: 1000,
      now: clock.now,
    });
    await rl.check("ip"); // t=1000, allowed
    clock.advance(900);
    await rl.check("ip"); // t=1900, blocked, NOT recorded
    clock.advance(200); // t=2100 → original (1000) aged out
    expect((await rl.check("ip")).allowed).toBe(true);
  });

  it("validates options", () => {
    const store = new MemoryRateLimitStore();
    expect(
      () => new RateLimiter({ store, limit: 0, windowMs: 1000 }),
    ).toThrow();
    expect(() => new RateLimiter({ store, limit: 1, windowMs: 0 })).toThrow();
  });
});
