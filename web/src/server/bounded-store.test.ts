/**
 * Unit tests for BoundedStore — the LRU + idle-TTL store backing the fix for
 * C1 (unbounded in-memory stores). Pure: no DB, no async, deterministic `now`.
 *
 * Every test passes an explicit, monotonically non-decreasing `now` so the
 * LRU-order invariant (Map insertion order == last-access order) is exercised
 * deterministically.
 */

import { describe, expect, it } from "vitest";

import { BoundedStore } from "@/server/bounded-store";

describe("BoundedStore — construction guards", () => {
  it("throws when maxEntries < 1", () => {
    expect(() => new BoundedStore({ maxEntries: 0, ttlMs: 1000 })).toThrow(RangeError);
    expect(() => new BoundedStore({ maxEntries: -5, ttlMs: 1000 })).toThrow(RangeError);
  });

  it("throws on a non-finite maxEntries or negative ttl", () => {
    expect(() => new BoundedStore({ maxEntries: Infinity, ttlMs: 1000 })).toThrow(RangeError);
    expect(() => new BoundedStore({ maxEntries: 10, ttlMs: -1 })).toThrow(RangeError);
  });
});

describe("BoundedStore — basic get/set/delete/size/clear", () => {
  it("returns undefined for a missing key", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 1000 });
    expect(s.get("nope", 0)).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("stores and reads a value, reflecting size", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 1000 });
    s.set("a", 42, 0);
    expect(s.get("a", 1)).toBe(42);
    expect(s.size).toBe(1);
  });

  it("delete removes a key; clear empties the store", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 1000 });
    s.set("a", 1, 0);
    s.set("b", 2, 0);
    expect(s.size).toBe(2);
    s.delete("a");
    expect(s.get("a", 1)).toBeUndefined();
    expect(s.size).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.get("b", 1)).toBeUndefined();
  });
});

describe("BoundedStore — reference identity (guards in-place counter mutation)", () => {
  it("get returns the SAME object reference that was set, so in-place mutation persists", () => {
    const s = new BoundedStore<{ count: number }>({ maxEntries: 10, ttlMs: 1000 });
    s.set("k", { count: 1 }, 0);

    const state = s.get("k", 1);
    expect(state).toBeDefined();
    state!.count += 1; // mimic the fixed-window limiter's `state.count += 1`

    // The mutation is visible on the next read (same underlying object).
    expect(s.get("k", 2)!.count).toBe(2);
  });
});

describe("BoundedStore — LRU cap eviction", () => {
  it("evicts the least-recently-inserted entry once over the cap", () => {
    const s = new BoundedStore<string>({ maxEntries: 3, ttlMs: 1_000_000 });
    s.set("a", "a", 1);
    s.set("b", "b", 2);
    s.set("c", "c", 3);
    s.set("d", "d", 4); // over cap → evict "a" (oldest access)

    expect(s.size).toBe(3);
    expect(s.get("a", 5)).toBeUndefined();
    expect(s.get("b", 5)).toBe("b");
    expect(s.get("c", 5)).toBe("c");
    expect(s.get("d", 5)).toBe("d");
  });

  it("a get hit refreshes recency, so a later overflow evicts a different victim", () => {
    const s = new BoundedStore<string>({ maxEntries: 3, ttlMs: 1_000_000 });
    s.set("a", "a", 1);
    s.set("b", "b", 2);
    s.set("c", "c", 3);

    s.get("a", 4); // touch "a" → now "b" is least-recently-accessed
    s.set("d", "d", 5); // over cap → evict "b", NOT "a"

    expect(s.get("a", 6)).toBe("a");
    expect(s.get("b", 6)).toBeUndefined();
    expect(s.get("c", 6)).toBe("c");
    expect(s.get("d", 6)).toBe("d");
  });

  it("re-setting an existing key refreshes recency", () => {
    const s = new BoundedStore<string>({ maxEntries: 3, ttlMs: 1_000_000 });
    s.set("a", "a", 1);
    s.set("b", "b", 2);
    s.set("c", "c", 3);

    s.set("a", "a2", 4); // overwrite → "a" moves to back; "b" now oldest
    s.set("d", "d", 5); // over cap → evict "b"

    expect(s.get("a", 6)).toBe("a2");
    expect(s.get("b", 6)).toBeUndefined();
    expect(s.get("c", 6)).toBe("c");
    expect(s.get("d", 6)).toBe("d");
  });

  it("maxEntries=1 keeps only the latest entry", () => {
    const s = new BoundedStore<string>({ maxEntries: 1, ttlMs: 1_000_000 });
    s.set("a", "a", 1);
    s.set("b", "b", 2);
    s.set("c", "c", 3);
    expect(s.size).toBe(1);
    expect(s.get("a", 4)).toBeUndefined();
    expect(s.get("b", 4)).toBeUndefined();
    expect(s.get("c", 4)).toBe("c");
  });

  it("never evicts the just-inserted entry (cap is the memory backstop)", () => {
    const s = new BoundedStore<number>({ maxEntries: 2, ttlMs: 1_000_000 });
    for (let i = 0; i < 50; i++) s.set(`k${i}`, i, i + 1);
    expect(s.size).toBe(2);
    expect(s.get("k49", 100)).toBe(49); // last insert always survives
    expect(s.get("k48", 100)).toBe(48);
    expect(s.get("k47", 100)).toBeUndefined();
  });
});

describe("BoundedStore — idle TTL", () => {
  it("a get hit refreshes the idle timer (sliding TTL)", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 10 });
    s.set("a", 1, 0);
    expect(s.get("a", 9)).toBe(1); // 9 - 0 = 9 < 10 → live; refreshes lastAccess to 9
    expect(s.get("a", 18)).toBe(1); // 18 - 9 = 9 < 10 → still live; refreshes to 18
    expect(s.get("a", 28)).toBeUndefined(); // 28 - 18 = 10 >= 10 → expired
  });

  it("expiry boundary is exactly ttlMs with >= semantics", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 10 });
    s.set("a", 1, 0);
    expect(s.get("a", 10)).toBeUndefined(); // 10 - 0 = 10 >= 10 → expired
    expect(s.size).toBe(0); // and deleted
  });

  it("just-under-ttl is still live", () => {
    const s = new BoundedStore<number>({ maxEntries: 10, ttlMs: 10 });
    s.set("a", 1, 0);
    expect(s.get("a", 9)).toBe(1);
  });

  it("set front-sweeps all contiguous expired entries and stops at the first live one", () => {
    const s = new BoundedStore<string>({ maxEntries: 100, ttlMs: 10 });
    s.set("a", "a", 0);
    s.set("b", "b", 1);
    s.set("c", "c", 2);

    // At now=12: a (idle 12) and b (idle 11) are expired; c (idle 10) also expired
    // (>=). Insert d → sweep removes a,b,c, leaving c? Verify precisely with a live one.
    s.set("d", "d", 5); // c is idle 3 here — still live
    // Now a idle 5, b idle 4, c idle 3, d idle 0 — none expired yet.
    expect(s.size).toBe(4);

    s.set("e", "e", 12); // a idle12(exp), b idle11(exp), c idle10(exp), d idle7(live) → stop at d
    expect(s.get("a", 12)).toBeUndefined();
    expect(s.get("b", 12)).toBeUndefined();
    expect(s.get("c", 12)).toBeUndefined();
    expect(s.get("d", 12)).toBe("d");
    expect(s.get("e", 12)).toBe("e");
  });

  it("a get refreshes the TTL so the entry survives a later front-sweep", () => {
    const s = new BoundedStore<string>({ maxEntries: 100, ttlMs: 10 });
    s.set("a", "a", 0);
    s.set("b", "b", 1);
    s.set("c", "c", 2);

    s.get("a", 3); // refresh a's lastAccess to 3 → a now most-recent

    s.set("d", "d", 12);
    // b idle 11 (exp), c idle 10 (exp), a idle 9 (live) → b,c swept, a survives.
    expect(s.get("b", 12)).toBeUndefined();
    expect(s.get("c", 12)).toBeUndefined();
    expect(s.get("a", 12)).toBe("a");
    expect(s.get("d", 12)).toBe("d");
  });

  it("cap-evict still applies when nothing has expired (huge ttl)", () => {
    const s = new BoundedStore<number>({ maxEntries: 2, ttlMs: Number.MAX_SAFE_INTEGER });
    s.set("a", 1, 1);
    s.set("b", 2, 2);
    s.set("c", 3, 3);
    s.set("d", 4, 4);
    expect(s.size).toBe(2);
    expect(s.get("c", 5)).toBe(3);
    expect(s.get("d", 5)).toBe(4);
    expect(s.get("a", 5)).toBeUndefined();
    expect(s.get("b", 5)).toBeUndefined();
  });
});
