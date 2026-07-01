"use client";

/**
 * OverviewView — the render logic for the admin panel's Overview screen
 * (Phase 7; ADMIN-US-2/3/4 headline). The owning page
 * (`src/app/admin/page.tsx`) stays a thin fetch-and-pass-through shell; ALL the
 * presentational logic lives here so it can be fixture-rendered under the jsdom
 * component project (which never scans `src/app/**` and must not import
 * db/repos/runtime — CLAUDE.md component-test rule).
 *
 * It renders, from one {@link OverviewResponse}:
 *   - A KPI grid (ADMIN-AC-2.1): total turns (with the guest-vs-signed split as
 *     its hint), active signed-in accounts, active guest sessions, new signups,
 *     the headline ESTIMATED cost over the range (ADMIN-BR-5 — flagged "est."),
 *     and the headline error rate (ADMIN-BR-9; tinted warn/danger as it climbs).
 *   - A usage trend chart (ADMIN-AC-2.2): the per-bucket turns / active-signed /
 *     active-guest / signups series over the selected window, plotted by the
 *     shared hand-rolled {@link TimeSeriesChart} (no charting dependency).
 *
 * State is driven entirely by props so each of the three states (data, loading,
 * error) is renderable from a fixture: `data` wins (a background refetch keeps
 * the last figures on screen with a subtle "Updating…" marker), then `error`,
 * then the initial loading placeholder.
 *
 * READ-ONLY (ADMIN-BR-2): nothing here mutates server state — the only
 * interaction is an optional retry that re-fetches the same GET endpoint.
 *
 * Refs:
 *   - docs/features/admin-panel/architecture/design.md
 *       § Component Design › 5, § API Design (`OverviewResponse`),
 *       § Implementation Phases Phase 7, AD-6 (cost is an estimate).
 *   - requirements.md ADMIN-US-2/3/4, ADMIN-AC-2.1/2.2/2.3, ADMIN-BR-5/8/9.
 *
 * CLIENT-SAFE: imports only the client-safe wire types + sibling client
 * primitives; never touches db/repos/runtime.
 */

import { enumerateBuckets } from "@/lib/admin/bucket-axis";
import type { OverviewResponse, UsageBucket } from "@/lib/admin/admin-types";

import KpiCard, { type KpiTone } from "./KpiCard";
import TimeSeriesChart, { type ChartSeries } from "./TimeSeriesChart";

export interface OverviewViewProps {
  /** The resolved overview payload, or null while it has never loaded. */
  data: OverviewResponse | null;
  /** True while a fetch is in flight (initial load or a range-change refetch). */
  loading?: boolean;
  /** True when the last fetch failed and there is nothing to show. */
  error?: boolean;
  /** Re-runs the fetch (shown only in the error state). Read-only navigation. */
  onRetry?: () => void;
}

/** Integer with thousands separators; tolerant of a non-finite input. */
function formatInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/**
 * Headline estimated USD (ADMIN-BR-5). Sub-dollar costs keep more precision so a
 * real-but-tiny hobby spend doesn't collapse to "$0.00".
 */
function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n > 0 && n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Percentage to one decimal place (e.g. 12.5 → "12.5%"). */
function formatPct(n: number): string {
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

/**
 * Visual tone for the error-rate tile: calm under 10%, `warn` from 10%, `danger`
 * from 25% (ADMIN-BR-9 failures are anything non-`answered` plus tool/OTP/rate
 * failures, surfaced as a single headline rate here).
 */
export function errorRateTone(pct: number): KpiTone {
  if (!Number.isFinite(pct) || pct < 10) return "default";
  if (pct >= 25) return "danger";
  return "warn";
}

export default function OverviewView({
  data,
  loading = false,
  error = false,
  onRetry,
}: OverviewViewProps) {
  return (
    <section className="admin-page" data-testid="overview-view">
      <h1 className="admin-page__title">Overview</h1>

      {data ? (
        <OverviewContent data={data} refreshing={loading} />
      ) : error ? (
        <div className="admin-page__state" data-testid="overview-error" role="alert">
          <p className="admin-page__state-text">
            Couldn&rsquo;t load the overview for this range.
          </p>
          {onRetry && (
            <button
              type="button"
              className="admin-table__load-more"
              data-testid="overview-retry"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      ) : (
        <div
          className="admin-page__state"
          data-testid="overview-loading"
          aria-busy="true"
        >
          <p className="admin-page__state-text">Loading overview…</p>
        </div>
      )}
    </section>
  );
}

/** The populated body — KPI grid + usage trend chart for a resolved payload. */
function OverviewContent({
  data,
  refreshing,
}: {
  data: OverviewResponse;
  refreshing: boolean;
}) {
  const { totals, buckets, totalEstUsd, errorRatePct, range } = data;

  // Densify the axis: the repo emits only NON-EMPTY buckets, so plot every bucket
  // the selected range covers (zeros for the gaps). This gives the chart a
  // continuous, evenly-spaced x-axis over the whole window instead of a few
  // clustered points. Gated on `buckets.length` so an empty range still yields
  // empty series → the chart's empty-state placeholder (not flat zero-lines).
  const domain = buckets.length === 0 ? [] : enumerateBuckets(range);
  const byT = new Map<number, UsageBucket>(buckets.map((b) => [b.t, b]));
  const seriesPoints = (pick: (b: UsageBucket) => number) =>
    domain.map((t) => {
      const b = byT.get(t);
      return { t, value: b ? pick(b) : 0 };
    });

  // Per-bucket usage series (ADMIN-AC-2.2): one line per tracked dimension over
  // the shared time axis. Keys/labels mirror the UsageBucket fields.
  const usageSeries: ChartSeries[] = [
    { key: "turns", label: "Turns", points: seriesPoints((b) => b.turns) },
    {
      key: "activeSigned",
      label: "Active signed-in",
      points: seriesPoints((b) => b.activeSigned),
    },
    {
      key: "activeGuest",
      label: "Active guests",
      points: seriesPoints((b) => b.activeGuest),
    },
    { key: "signups", label: "Signups", points: seriesPoints((b) => b.signups) },
  ];

  return (
    <>
      {refreshing && (
        <span className="admin-page__refreshing" data-testid="overview-refreshing">
          Updating…
        </span>
      )}

      <div className="admin-kpi-grid" data-testid="overview-kpis">
        <KpiCard
          label="Total turns"
          value={formatInt(totals.turns)}
          hint={`${formatInt(totals.signedTurns)} signed-in · ${formatInt(
            totals.guestTurns,
          )} guest`}
        />
        <KpiCard
          label="Active signed-in"
          value={formatInt(totals.activeSigned)}
          hint="accounts"
        />
        <KpiCard
          label="Active guests"
          value={formatInt(totals.activeGuest)}
          hint="sessions"
        />
        <KpiCard label="New signups" value={formatInt(totals.signups)} />
        <KpiCard
          label="Est. cost"
          value={formatUsd(totalEstUsd)}
          hint="this range"
          estimated
        />
        <KpiCard
          label="Error rate"
          value={formatPct(errorRatePct)}
          tone={errorRateTone(errorRatePct)}
        />
      </div>

      <section
        className="admin-page__chart"
        data-testid="overview-usage-chart"
        aria-label="Usage over time"
      >
        <h2 className="admin-page__chart-title">Usage over time</h2>
        <TimeSeriesChart
          series={usageSeries}
          bucket={range.bucket}
          area
          ariaLabel="Usage over the selected range"
          emptyLabel="No activity recorded for this range"
        />
      </section>
    </>
  );
}
