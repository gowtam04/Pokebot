import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

afterEach(() => cleanup());

import CostView, { formatUsd, formatTokens } from "./CostView";
import { enumerateBuckets } from "@/lib/admin/bucket-axis";
import type { CostResponse } from "@/lib/admin/admin-types";

// --- Fixtures (no db/repo imports — this is the jsdom component project) -----

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1); // 2026-01-01

/**
 * A realistic CostResponse: two priced models (grok-4.3, claude) + one model
 * value with no price entry (priced:false → estUsd 0), a multi-bucket cost
 * trend, and `estimated: true` (ADMIN-BR-5).
 */
const FIXTURE: CostResponse = {
  range: { from: BASE, to: BASE + 7 * DAY, bucket: "day" },
  byModel: [
    {
      model: "grok-4.3",
      inputTokens: 120_000,
      outputTokens: 45_000,
      thinkingTokens: 30_000,
      estUsd: 1.234,
      priced: true,
    },
    {
      model: "claude",
      inputTokens: 80_000,
      outputTokens: 20_000,
      thinkingTokens: 0,
      estUsd: 0.567,
      priced: true,
    },
    {
      model: "mystery-model",
      inputTokens: 5_000,
      outputTokens: 1_000,
      thinkingTokens: 0,
      estUsd: 0,
      priced: false,
    },
  ],
  series: [
    { t: BASE, estUsd: 0.5 },
    { t: BASE + DAY, estUsd: 0.9 },
    { t: BASE + 2 * DAY, estUsd: 0.401 },
  ],
  totalEstUsd: 1.801,
  estimated: true,
};

describe("CostView", () => {
  it("renders the screen shell and title", () => {
    render(<CostView data={FIXTURE} />);
    expect(screen.getByTestId("cost-view")).toBeInTheDocument();
    expect(screen.getByTestId("cost-view")).toHaveTextContent("Cost & tokens");
  });

  it("shows the estimate caveat — figures are estimates, not billing (ADMIN-BR-5)", () => {
    render(<CostView data={FIXTURE} />);
    const note = screen.getByTestId("cost-estimate-note");
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(/estimate/i);
    expect(note).toHaveTextContent(/not authoritative provider billing/i);
  });

  it("renders the estimated-cost KPI with the est. badge (ADMIN-AC-3.2)", () => {
    render(<CostView data={FIXTURE} />);
    // The cost KPI carries the estimate marker; 1.801 → "$1.80".
    expect(screen.getByTestId("kpi-card-estimated")).toBeInTheDocument();
    const kpis = within(screen.getByTestId("cost-kpis"));
    expect(kpis.getByText("Estimated cost")).toBeInTheDocument();
    expect(kpis.getByText(/\$1\.80/)).toBeInTheDocument();
  });

  it("shows input/output/thinking token totals across all models (ADMIN-AC-3.1)", () => {
    render(<CostView data={FIXTURE} />);
    const kpis = within(screen.getByTestId("cost-kpis"));
    // input 120k+80k+5k = 205,000 · output 45k+20k+1k = 66,000 · thinking 30,000
    expect(kpis.getByText("Input tokens")).toBeInTheDocument();
    expect(kpis.getByText("205,000")).toBeInTheDocument();
    expect(kpis.getByText("66,000")).toBeInTheDocument();
    expect(kpis.getByText("30,000")).toBeInTheDocument();
  });

  it("renders the cost trend chart over time (ADMIN-AC-3.2)", () => {
    render(<CostView data={FIXTURE} />);
    expect(screen.getByTestId("cost-trend")).toBeInTheDocument();
    // The hand-rolled TimeSeriesChart renders an SVG when there are points.
    expect(screen.getByTestId("time-series-chart-svg")).toBeInTheDocument();
    expect(screen.getByTestId("ts-series-estUsd")).toBeInTheDocument();
  });

  it("densifies the cost trend to one point per bucket over the range", () => {
    const { container } = render(<CostView data={FIXTURE} />);
    // FIXTURE.range spans 7 daily buckets; the repo returned only 3 → densify
    // fills the other 4 with $0 so the axis is continuous.
    const expected = enumerateBuckets(FIXTURE.range).length;
    expect(expected).toBe(7);
    const line = container.querySelector(
      '[data-testid="ts-series-estUsd"] polyline.time-series-chart__line',
    );
    expect(line).not.toBeNull();
    const coords = (line!.getAttribute("points") ?? "").trim().split(/\s+/);
    expect(coords).toHaveLength(expected);
  });

  it("renders a by-model breakdown row per model (ADMIN-AC-3.1)", () => {
    render(<CostView data={FIXTURE} />);
    const table = within(screen.getByTestId("cost-by-model"));
    expect(table.getByTestId("cost-model-grok-4.3")).toHaveTextContent(
      "xAI Grok 4.3",
    );
    expect(table.getByTestId("cost-model-claude")).toHaveTextContent(
      "Claude Sonnet 4.6",
    );
    // An unknown stored model value falls back to its raw key.
    expect(table.getByTestId("cost-model-mystery-model")).toHaveTextContent(
      "mystery-model",
    );
  });

  it("flags a model with no price entry as unpriced", () => {
    render(<CostView data={FIXTURE} />);
    expect(screen.getByTestId("cost-unpriced-mystery-model")).toHaveTextContent(
      "unpriced",
    );
    expect(screen.getByTestId("cost-unpriced-note")).toBeInTheDocument();
    // Priced models carry no unpriced badge.
    expect(screen.queryByTestId("cost-unpriced-grok-4.3")).toBeNull();
  });

  it("does not show the unpriced note when every model is priced", () => {
    const allPriced: CostResponse = {
      ...FIXTURE,
      byModel: FIXTURE.byModel.filter((m) => m.priced),
    };
    render(<CostView data={allPriced} />);
    expect(screen.queryByTestId("cost-unpriced-note")).toBeNull();
  });

  it("renders a loading placeholder before the first response", () => {
    render(<CostView data={null} loading />);
    expect(screen.getByTestId("cost-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-kpis")).toBeNull();
  });

  it("renders an error state when the fetch failed", () => {
    render(<CostView data={null} error="Request failed (503)" />);
    const err = screen.getByTestId("cost-error");
    expect(err).toBeInTheDocument();
    expect(err).toHaveTextContent("Request failed (503)");
    expect(screen.queryByTestId("cost-kpis")).toBeNull();
  });

  it("handles an empty range — zeroed KPIs, empty chart and table", () => {
    const empty: CostResponse = {
      range: { from: BASE, to: BASE + DAY, bucket: "day" },
      byModel: [],
      series: [],
      totalEstUsd: 0,
      estimated: true,
    };
    render(<CostView data={empty} />);
    // Cost view still renders with the caveat + zeroed cost KPI.
    expect(screen.getByTestId("cost-estimate-note")).toBeInTheDocument();
    expect(within(screen.getByTestId("cost-kpis")).getByText("$0.00")).toBeInTheDocument();
    // Empty chart placeholder + empty table message.
    expect(screen.getByTestId("time-series-chart-empty")).toBeInTheDocument();
    expect(screen.getByTestId("admin-table-empty")).toHaveTextContent(
      "No model usage in this range.",
    );
  });
});

describe("CostView formatters", () => {
  it("formatUsd uses two decimals for normal amounts", () => {
    expect(formatUsd(1.801)).toBe("$1.80");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("formatUsd keeps four decimals for tiny sub-cent amounts", () => {
    expect(formatUsd(0.0034)).toBe("$0.0034");
  });

  it("formatUsd is safe on non-finite input", () => {
    expect(formatUsd(NaN)).toBe("$0.00");
  });

  it("formatTokens groups with thousands separators", () => {
    expect(formatTokens(205_000)).toBe("205,000");
    expect(formatTokens(0)).toBe("0");
  });

  it("formatTokens is safe on non-finite input", () => {
    expect(formatTokens(Infinity)).toBe("0");
  });
});
