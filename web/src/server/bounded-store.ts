/**
 * Bounded in-memory key→value store with LRU eviction + idle TTL (fix for the
 * assessment's C1 — "unbounded in-memory stores").
 *
 * Backs the process-local stores that were previously bare `Map`s and grew
 * without bound (`session-store.ts`, `rate-limit.ts`, `auth/otp-throttle.ts`):
 * every distinct key left a permanent entry until process restart, a direct OOM
 * vector on the small deploy machine.
 *
 * Two bounds are enforced, both LAZILY on writes — no `setInterval`/cron, matching
 * the repo's "lazy cleanup, no cron" convention (see `auth/sessions.ts`,
 * `rate-limit.ts`):
 *  - **Idle TTL** — an entry not touched within `ttlMs` is dropped.
 *  - **Max entries (LRU)** — once `size` exceeds `maxEntries`, the
 *    least-recently-accessed entries are evicted until back within the cap. This
 *    is the hard memory backstop (it holds even if nothing has expired).
 *
 * LRU order is maintained via JS `Map` insertion order: every touch (a hit on
 * `get`, or any `set`) re-inserts the entry at the *back*, so the *front* is
 * always the least-recently-accessed key and expired entries are contiguous at
 * the front. Eviction/expiry therefore just deletes from the front until the
 * first live/in-cap entry — amortized O(1) per write.
 *
 * `now` is an injectable epoch-ms clock defaulting to `Date.now()` (the repo's
 * testability convention — see `rate-limit.ts`, `champions-usage/usage-client.ts`).
 * There is no I/O and no async; call these synchronously.
 *
 * IMPORTANT — reference identity: `get` returns the SAME value object that was
 * `set` (only the wrapper is reordered), so callers that mutate the stored value
 * in place (e.g. `state.count += 1` in the fixed-window limiters) keep working.
 *
 * Pure (no `server-only`, no Node/Next/DB imports) so it can be unit-tested
 * directly, like the store modules it backs.
 */

export interface BoundedStoreOptions {
  /** Hard cap on resident entries; the least-recently-accessed are evicted past it. */
  maxEntries: number;
  /**
   * Idle time-to-live in ms. An entry untouched for at least this long is
   * treated as absent (evicted on the next touch or read). For fixed-window
   * limiters this MUST be `>=` the window length, or a key could be evicted
   * mid-window and reset its counter.
   */
  ttlMs: number;
}

interface Entry<V> {
  value: V;
  /** Epoch-ms of the most recent touch (get hit or set). */
  lastAccess: number;
}

export class BoundedStore<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor({ maxEntries, ttlMs }: BoundedStoreOptions) {
    // A cap below 1 would make cap-evict delete the just-inserted entry, leaving
    // the store permanently empty — reject it rather than silently misbehave.
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new RangeError(`BoundedStore: maxEntries must be >= 1 (got ${maxEntries})`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError(`BoundedStore: ttlMs must be a non-negative number (got ${ttlMs})`);
    }
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Returns the value for `key`, or `undefined` if absent or idle past `ttlMs`
   * (an expired entry is deleted). On a live hit, refreshes the entry's
   * last-access time and moves it to the back (most-recently-used), returning
   * the SAME value reference that was stored.
   */
  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;

    if (now - entry.lastAccess >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }

    // Reorder to the back (LRU): delete + re-insert with a refreshed timestamp.
    // The value object is reused, so callers holding/mutating it are unaffected.
    this.map.delete(key);
    entry.lastAccess = now;
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Inserts/overwrites `key` at the back (most-recently-used), then enforces the
   * bounds: first sweeps idle-expired entries from the front, then evicts the
   * least-recently-used entries until `size <= maxEntries`.
   */
  set(key: string, value: V, now: number = Date.now()): void {
    // Delete-then-set moves an existing key to the back (fresh insertion order).
    this.map.delete(key);
    this.map.set(key, { value, lastAccess: now });

    // Front-sweep expired: entries are ordered oldest-access-first, so all
    // idle-expired entries are contiguous at the front. Stop at the first live
    // one. The just-inserted entry (lastAccess === now) is never swept.
    for (const [k, entry] of this.map) {
      if (now - entry.lastAccess < this.ttlMs) break;
      this.map.delete(k);
    }

    // Cap-evict (LRU): drop from the front until within the cap. Order-independent
    // memory backstop that holds even when nothing has expired.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Removes `key` if present. */
  delete(key: string): void {
    this.map.delete(key);
  }

  /** Number of resident entries (including any not-yet-swept expired ones). */
  get size(): number {
    return this.map.size;
  }

  /** Removes all entries. */
  clear(): void {
    this.map.clear();
  }
}
