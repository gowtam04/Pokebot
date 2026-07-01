/**
 * OverviewView — jsdom component test (Phase 7). Renders the Overview screen's
 * extracted view logic from FIXTURES only; imports no db/repos/runtime, so it is
 * safe under the jsdom project that has no Postgres (CLAUDE.md component rule).
 *
 * Covers: the KPI grid values + guest/signed split (ADMIN-AC-2.1), the estimated
 * cost flag (ADMIN-BR-5), the error-rate tone ramp (ADMIN-BR-9), the usage trend
 * chart (ADMIN-AC-2.2), and the loading / error+retry states.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

afterEach(() => cleanup());

import OverviewView, { errorRateTone } from "./OverviewView";
import { enumerateBuckets } from "@/lib/admin/bucket-axis";
import type { OverviewResponse } from "@/lib/admin/admin-types";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1); // 2026-01-01

/**
 * A realistic resolved overview payload over a 4-bucket daily window. `to` is
 * BASE + 4*DAY so the half-open `[from, to)` window exactly covers the four
 * bucket-starts BASE … BASE+3*DAY (densify is then lossless).
 */
const FIXTURE: OverviewResponse = {
  range: { from: BASE, to: BASE + 4 * DAY, bucket: "day" },
  totals: {
    turns: 101,
    activeSigned: 7,
    activeGuest: 12,
    signups: 3,
    guestTurns: 40,
    signedTurns: 61,
  },
  buckets: [
    { t: BASE, turns: 12, activeSigned: 2, activeGuest: 3, signups: 1 },
    { t: BASE + DAY, turns: 30, activeSigned: 3, activeGuest: 5, signups: 1 },
    { t: BASE + 2 * DAY, turns: 18, activeSigned: 2, activeGuest: 4, signups: 0 },
    { t: BASE + 3 * DAY, turns: 41, activeSigned: 4, activeGuest: 6, signups: 1 },
  ],
  totalEstUsd: 3.4123,
  estimated: true,
  errorRatePct: 12.5,
};

describe("OverviewView", () => {
  it("always renders the screen title", () => {
    render(<OverviewView data={FIXTURE} />);
    expect(screen.getByTestId("overview-view")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
  });

  it("renders the KPI totals from the payload (ADMIN-AC-2.1)", () => {
    render(<OverviewView data={FIXTURE} />);
    const kpis = within(screen.getByTestId("overview-kpis"));

    expect(kpis.getByText("Total turns")).toBeInTheDocument();
    expect(kpis.getByText("101")).toBeInTheDocument();

    expect(kpis.getByText("Active signed-in")).toBeInTheDocument();
    expect(kpis.getByText("7")).toBeInTheDocument();

    expect(kpis.getByText("Active guests")).toBeInTheDocument();
    expect(kpis.getByText("12")).toBeInTheDocument();

    expect(kpis.getByText("New signups")).toBeInTheDocument();
    expect(kpis.getByText("3")).toBeInTheDocument();
  });

  it("shows the guest-vs-signed-in split as the total-turns hint (ADMIN-AC-2.1)", () => {
    render(<OverviewView data={FIXTURE} />);
    const kpis = within(screen.getByTestId("overview-kpis"));
    expect(kpis.getByText("61 signed-in · 40 guest")).toBeInTheDocument();
  });

  it("renders the estimated cost flagged as an estimate (ADMIN-BR-5)", () => {
    render(<OverviewView data={FIXTURE} />);
    const kpis = within(screen.getByTestId("overview-kpis"));
    expect(kpis.getByText("$3.41")).toBeInTheDocument();
    // exactly one tile carries the "est." badge — the cost tile
    expect(kpis.getByTestId("kpi-card-estimated")).toBeInTheDocument();
  });

  it("renders the error rate with a warn tone at 12.5% (ADMIN-BR-9)", () => {
    render(<OverviewView data={FIXTURE} />);
    const kpis = within(screen.getByTestId("overview-kpis"));
    const card = kpis.getByText("12.5%").closest(".kpi-card");
    expect(card).not.toBeNull();
    expect(card).toHaveClass("kpi-card--warn");
  });

  it("renders the usage trend chart with all four series (ADMIN-AC-2.2)", () => {
    render(<OverviewView data={FIXTURE} />);
    const chart = within(screen.getByTestId("overview-usage-chart"));
    expect(chart.getByTestId("time-series-chart")).toBeInTheDocument();
    expect(chart.getByTestId("time-series-chart-svg")).toBeInTheDocument();
    expect(chart.getByTestId("ts-series-turns")).toBeInTheDocument();
    expect(chart.getByTestId("ts-series-activeSigned")).toBeInTheDocument();
    expect(chart.getByTestId("ts-series-activeGuest")).toBeInTheDocument();
    expect(chart.getByTestId("ts-series-signups")).toBeInTheDocument();
  });

  it("densifies the series to one point per bucket over the whole range (ADMIN-AC-2.2)", () => {
    const { container } = render(<OverviewView data={FIXTURE} />);
    const expected = enumerateBuckets(FIXTURE.range).length; // 4 daily buckets
    expect(expected).toBe(4);
    const line = container.querySelector(
      '[data-testid="ts-series-turns"] polyline.time-series-chart__line',
    );
    expect(line).not.toBeNull();
    const coords = (line!.getAttribute("points") ?? "").trim().split(/\s+/);
    expect(coords).toHaveLength(expected);
  });

  it("zero-fills interior gaps so the axis stays continuous (no missing days)", () => {
    // A range that spans 4 days but whose repo output skips the 2nd and 3rd days
    // (the repo emits no row for empty buckets) — densify must fill them with 0.
    const gappy: OverviewResponse = {
      ...FIXTURE,
      buckets: [
        { t: BASE, turns: 12, activeSigned: 2, activeGuest: 3, signups: 1 },
        { t: BASE + 3 * DAY, turns: 41, activeSigned: 4, activeGuest: 6, signups: 1 },
      ],
    };
    const { container } = render(<OverviewView data={gappy} />);
    const line = container.querySelector(
      '[data-testid="ts-series-turns"] polyline.time-series-chart__line',
    );
    const pointsAttr = line!.getAttribute("points") ?? "";
    // Full enumerated length (gaps filled), and no NaN from a densified point.
    expect(pointsAttr.trim().split(/\s+/)).toHaveLength(
      enumerateBuckets(FIXTURE.range).length,
    );
    expect(pointsAttr).not.toMatch(/NaN/);
  });

  it("renders a loading placeholder before any data arrives", () => {
    render(<OverviewView data={null} loading />);
    expect(screen.getByTestId("overview-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-kpis")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-error")).not.toBeInTheDocument();
  });

  it("renders an error state with a working retry when the fetch failed", () => {
    const onRetry = vi.fn();
    render(<OverviewView data={null} error onRetry={onRetry} />);
    expect(screen.getByTestId("overview-error")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-kpis")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("overview-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps showing data during a background refetch, with an updating marker", () => {
    render(<OverviewView data={FIXTURE} loading />);
    // data wins over the loading flag (no flash of the empty placeholder)
    expect(screen.getByTestId("overview-kpis")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("overview-refreshing")).toBeInTheDocument();
  });

  it("renders the chart empty state when the range has no buckets", () => {
    const empty: OverviewResponse = {
      ...FIXTURE,
      totals: {
        turns: 0,
        activeSigned: 0,
        activeGuest: 0,
        signups: 0,
        guestTurns: 0,
        signedTurns: 0,
      },
      buckets: [],
      totalEstUsd: 0,
      errorRatePct: 0,
    };
    render(<OverviewView data={empty} />);
    // KPIs still render (all zero); the chart shows its empty placeholder
    expect(screen.getByTestId("overview-kpis")).toBeInTheDocument();
    const chart = within(screen.getByTestId("overview-usage-chart"));
    expect(chart.getByTestId("time-series-chart-empty")).toBeInTheDocument();
  });
});

describe("errorRateTone (ADMIN-BR-9 thresholds)", () => {
  it("is calm under 10%", () => {
    expect(errorRateTone(0)).toBe("default");
    expect(errorRateTone(9.9)).toBe("default");
  });

  it("warns from 10% to under 25%", () => {
    expect(errorRateTone(10)).toBe("warn");
    expect(errorRateTone(24.9)).toBe("warn");
  });

  it("is danger from 25% up", () => {
    expect(errorRateTone(25)).toBe("danger");
    expect(errorRateTone(100)).toBe("danger");
  });

  it("treats a non-finite rate as calm", () => {
    expect(errorRateTone(Number.NaN)).toBe("default");
  });
});
