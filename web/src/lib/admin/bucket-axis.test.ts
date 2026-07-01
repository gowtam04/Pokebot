import { describe, it, expect } from "vitest";

import { enumerateBuckets } from "./bucket-axis";

// UTC-aligned constants (no db imports — pure helper, runs in the node project).
const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 5); // 2026-01-05 00:00 UTC — a day boundary.

describe("enumerateBuckets", () => {
  it("spaces day buckets by exactly one UTC day, all on a day boundary", () => {
    const ts = enumerateBuckets({ from: BASE, to: BASE + 3 * DAY, bucket: "day" });
    expect(ts).toEqual([BASE, BASE + DAY, BASE + 2 * DAY]);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(DAY);
    for (const t of ts) expect(t % DAY).toBe(0);
  });

  it("spaces hour buckets by exactly one UTC hour", () => {
    const ts = enumerateBuckets({ from: BASE, to: BASE + 4 * HOUR, bucket: "hour" });
    expect(ts).toEqual([BASE, BASE + HOUR, BASE + 2 * HOUR, BASE + 3 * HOUR]);
    for (const t of ts) expect(t % HOUR).toBe(0);
  });

  it("treats `to` as EXCLUSIVE (half-open [from, to))", () => {
    // to = BASE + 2*DAY excludes the BASE+2*DAY bucket (nothing lands in it).
    expect(enumerateBuckets({ from: BASE, to: BASE + 2 * DAY, bucket: "day" })).toEqual([
      BASE,
      BASE + DAY,
    ]);
  });

  it("includes the final partial bucket that contains up to `to - 1`", () => {
    // A range ending mid-day still includes that day's bucket.
    const ts = enumerateBuckets({ from: BASE, to: BASE + 2 * DAY + 5 * HOUR, bucket: "day" });
    expect(ts).toEqual([BASE, BASE + DAY, BASE + 2 * DAY]);
  });

  it("floors an unaligned `from` down to its bucket start", () => {
    const ts = enumerateBuckets({
      from: BASE + 3 * HOUR, // mid-day start
      to: BASE + 2 * DAY + 5 * HOUR,
      bucket: "day",
    });
    expect(ts).toEqual([BASE, BASE + DAY, BASE + 2 * DAY]);
    expect(ts[0]).toBe(Math.floor((BASE + 3 * HOUR) / DAY) * DAY);
  });

  it("returns a single bucket for a sub-bucket-width window", () => {
    const ts = enumerateBuckets({
      from: BASE + 2 * HOUR,
      to: BASE + 5 * HOUR,
      bucket: "day",
    });
    expect(ts).toEqual([BASE]);
  });

  it("returns [] for a degenerate window (to <= from)", () => {
    expect(enumerateBuckets({ from: BASE, to: BASE, bucket: "day" })).toEqual([]);
    expect(enumerateBuckets({ from: BASE, to: BASE - DAY, bucket: "day" })).toEqual([]);
  });

  it("returns [] for a non-finite bound (defensive)", () => {
    expect(enumerateBuckets({ from: NaN, to: BASE, bucket: "day" })).toEqual([]);
    expect(enumerateBuckets({ from: BASE, to: NaN, bucket: "day" })).toEqual([]);
  });

  it("aligns with the repo's UTC date_trunc bucket start", () => {
    // The repo emits floor(created_at/step)*step; a JS UTC-midnight equals that.
    const createdAt = Date.UTC(2026, 0, 5, 14, 32, 7, 123); // arbitrary intra-day
    const bucketStart = Math.floor(createdAt / DAY) * DAY;
    expect(bucketStart).toBe(Date.UTC(2026, 0, 5));
    // …and that bucket start is a member of the enumerated axis over a wider range.
    const ts = enumerateBuckets({ from: BASE - DAY, to: BASE + 2 * DAY, bucket: "day" });
    expect(ts).toContain(bucketStart);
  });
});
