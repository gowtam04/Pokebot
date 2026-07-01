/**
 * bucket-axis.ts — the CLIENT-SAFE time-axis densifier for the admin charts.
 *
 * The analytics repo (`getUsageSeries` / `getCostBreakdown`) aggregates with SQL
 * `GROUP BY date_trunc(...)`, which emits NO row for a bucket with no activity —
 * an intentional, unit-tested sparse contract (an empty window returns `[]`). But
 * a line chart needs a CONTINUOUS, evenly-spaced axis over the whole selected
 * range: without it, a few clustered points drive the x-domain (data extent) and
 * the lines hug the bottom then jerk up at the far right.
 *
 * `enumerateBuckets` produces every bucket-start (epoch ms) the selected range
 * covers, so the view can zero-fill the gaps (`Map<t, bucket>.get(t) ?? 0`) and
 * hand the chart a dense series. It is PURE and has no db/repo/React/Node
 * imports (only an erased type import), so it lives in `@/lib/admin` alongside
 * the wire types and is unit-tested in the node project.
 *
 * ── Alignment with the repo (why the zero-fill is lossless) ──────────────────
 * The repo's bucket start is `date_trunc('day'|'hour', ts AT TIME ZONE 'UTC')`
 * converted back to an epoch-ms instant. Because Unix time carries no leap
 * seconds and UTC has no DST, that is EXACTLY `floor(t / step) * step` with
 * `step` = 86_400_000 (day) / 3_600_000 (hour). We enumerate with the same
 * `step`, so every repo bucket key for a `created_at ∈ [from, to)` is guaranteed
 * to be a member of the returned array — the merge never misaligns.
 */

import type { BucketSize, Range } from "@/lib/admin/admin-types";

/** UTC bucket widths in ms — a UTC day/hour is a fixed multiple (no DST/leap). */
const STEP_MS: Record<BucketSize, number> = {
  day: 86_400_000,
  hour: 3_600_000,
};

/**
 * The ordered bucket-start instants (epoch ms) a range covers, one per bucket at
 * the range's granularity. The window is half-open `[from, to)` (matching the
 * `Range` contract), so the last bucket is the one containing `to - 1`.
 *
 * Returns `[]` for a degenerate window (`to <= from`), which lets callers keep
 * the chart's empty-state placeholder instead of drawing flat zero-lines.
 */
export function enumerateBuckets(
  range: Pick<Range, "from" | "to" | "bucket">,
): number[] {
  const step = STEP_MS[range.bucket] ?? STEP_MS.day;
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return [];
  if (range.to <= range.from) return [];

  const first = Math.floor(range.from / step) * step;
  const last = Math.floor((range.to - 1) / step) * step; // `to` is exclusive

  const out: number[] = [];
  for (let t = first; t <= last; t += step) out.push(t);
  return out;
}
