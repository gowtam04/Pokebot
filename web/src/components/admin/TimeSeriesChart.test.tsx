import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

afterEach(() => cleanup());

import TimeSeriesChart, {
  formatValue,
  formatTime,
  type ChartSeries,
} from "./TimeSeriesChart";

// --- Fixtures (no db/repo imports — this is the jsdom project) --------------

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1); // 2026-01-01

/** A realistic multi-bucket usage series (mirrors UsageBucket → series shape). */
const TURNS_SERIES: ChartSeries = {
  key: "turns",
  label: "Turns",
  points: [
    { t: BASE, value: 12 },
    { t: BASE + DAY, value: 30 },
    { t: BASE + 2 * DAY, value: 18 },
    { t: BASE + 3 * DAY, value: 41 },
  ],
};

const SIGNUPS_SERIES: ChartSeries = {
  key: "signups",
  label: "Signups",
  color: "var(--success, #2fb573)",
  points: [
    { t: BASE, value: 1 },
    { t: BASE + DAY, value: 4 },
    { t: BASE + 2 * DAY, value: 0 },
    { t: BASE + 3 * DAY, value: 2 },
  ],
};

describe("TimeSeriesChart", () => {
  it("renders without crashing on a fixture series", () => {
    render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    expect(screen.getByTestId("time-series-chart")).toBeInTheDocument();
    expect(screen.getByTestId("time-series-chart-svg")).toBeInTheDocument();
  });

  it("renders without crashing on an empty series array", () => {
    render(<TimeSeriesChart series={[]} />);
    // No SVG is rendered; the empty-state placeholder is shown instead.
    expect(screen.getByTestId("time-series-chart")).toBeInTheDocument();
    expect(screen.getByTestId("time-series-chart-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("time-series-chart-svg")).toBeNull();
  });

  it("treats a series whose points array is empty as empty (no points anywhere)", () => {
    render(<TimeSeriesChart series={[{ key: "k", label: "K", points: [] }]} />);
    expect(screen.getByTestId("time-series-chart-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("time-series-chart-svg")).toBeNull();
  });

  it("shows the custom empty label", () => {
    render(<TimeSeriesChart series={[]} emptyLabel="Nothing yet" />);
    expect(screen.getByTestId("time-series-chart-empty")).toHaveTextContent(
      "Nothing yet",
    );
  });

  it("renders a polyline path for a series with multiple points", () => {
    const { container } = render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    const group = screen.getByTestId("ts-series-turns");
    expect(group).toBeInTheDocument();
    expect(container.querySelector("polyline.time-series-chart__line")).not.toBeNull();
  });

  it("renders one legend entry per series", () => {
    render(<TimeSeriesChart series={[TURNS_SERIES, SIGNUPS_SERIES]} />);
    expect(screen.getByTestId("ts-legend-turns")).toHaveTextContent("Turns");
    expect(screen.getByTestId("ts-legend-signups")).toHaveTextContent("Signups");
  });

  it("plots multiple series together (multi-line)", () => {
    const { container } = render(
      <TimeSeriesChart series={[TURNS_SERIES, SIGNUPS_SERIES]} />,
    );
    expect(screen.getByTestId("ts-series-turns")).toBeInTheDocument();
    expect(screen.getByTestId("ts-series-signups")).toBeInTheDocument();
    expect(
      container.querySelectorAll("polyline.time-series-chart__line"),
    ).toHaveLength(2);
  });

  it("renders an area fill path when area={true}", () => {
    const { container } = render(
      <TimeSeriesChart series={[TURNS_SERIES]} area />,
    );
    expect(container.querySelector("path.time-series-chart__area")).not.toBeNull();
  });

  it("omits the area path by default", () => {
    const { container } = render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    expect(container.querySelector("path.time-series-chart__area")).toBeNull();
  });

  it("renders a single-point series as a dot (not a line) without crashing", () => {
    const single: ChartSeries = {
      key: "solo",
      label: "Solo",
      points: [{ t: BASE, value: 7 }],
    };
    const { container } = render(<TimeSeriesChart series={[single]} />);
    expect(screen.getByTestId("ts-series-solo")).toBeInTheDocument();
    expect(container.querySelector("line.time-series-chart__dot")).not.toBeNull();
    expect(container.querySelector("polyline.time-series-chart__line")).toBeNull();
  });

  it("handles an all-zero series without dividing by zero", () => {
    const zeros: ChartSeries = {
      key: "z",
      label: "Z",
      points: [
        { t: BASE, value: 0 },
        { t: BASE + DAY, value: 0 },
      ],
    };
    const { container } = render(<TimeSeriesChart series={[zeros]} />);
    const polyline = container.querySelector("polyline.time-series-chart__line");
    expect(polyline).not.toBeNull();
    // Every coordinate must be a finite number (no NaN from a zero y-span).
    const pointsAttr = polyline!.getAttribute("points") ?? "";
    expect(pointsAttr.length).toBeGreaterThan(0);
    expect(pointsAttr).not.toMatch(/NaN/);
  });

  it("renders y-axis tick labels (default 3)", () => {
    render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    expect(screen.getByTestId("ts-ytick-0")).toBeInTheDocument();
    expect(screen.getByTestId("ts-ytick-1")).toBeInTheDocument();
    expect(screen.getByTestId("ts-ytick-2")).toBeInTheDocument();
  });

  it("uses a custom yFormat for tick labels", () => {
    render(
      <TimeSeriesChart
        series={[TURNS_SERIES]}
        yFormat={(v) => `$${v.toFixed(0)}`}
      />,
    );
    // The top tick is the data max (41) → "$41".
    expect(screen.getByTestId("ts-ytick-0")).toHaveTextContent("$41");
  });

  it("renders the figure with an accessible role and label", () => {
    render(<TimeSeriesChart series={[TURNS_SERIES]} ariaLabel="Turns per day" />);
    const fig = screen.getByTestId("time-series-chart");
    expect(fig.tagName).toBe("FIGURE");
    expect(fig).toHaveAttribute("role", "img");
    expect(fig).toHaveAttribute("aria-label", "Turns per day");
  });

  it("applies an extra className alongside the base class", () => {
    render(<TimeSeriesChart series={[TURNS_SERIES]} className="cost-chart" />);
    const fig = screen.getByTestId("time-series-chart");
    expect(fig).toHaveClass("time-series-chart");
    expect(fig).toHaveClass("cost-chart");
  });
});

describe("TimeSeriesChart hover", () => {
  /** Mock the plot's layout box so clientX maps 1:1 to the logical VIEW_W=1000. */
  function mockPlotWidth(plot: HTMLElement, width = 1000) {
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width,
      height: 180,
      right: width,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("shows a crosshair + tooltip for the nearest bucket on mousemove", () => {
    const { container } = render(
      <TimeSeriesChart series={[TURNS_SERIES, SIGNUPS_SERIES]} />,
    );
    const plot = screen.getByTestId("time-series-chart-plot");
    mockPlotWidth(plot);

    // Buckets sit at logical x = 0 / 333 / 667 / 1000; clientX 700 → bucket #2
    // (BASE+2*DAY) unambiguously (nearest to 667, not 1000).
    fireEvent.mouseMove(plot, { clientX: 700 });

    expect(container.querySelector(".time-series-chart__crosshair")).not.toBeNull();
    const tooltip = screen.getByTestId("time-series-chart-tooltip");
    // Tooltip header = that bucket's time (tz-agnostic via the shared helper).
    expect(tooltip).toHaveTextContent(formatTime(BASE + 2 * DAY, "day"));
    // Per-series values at BASE+2*DAY: turns 18, signups 0.
    expect(screen.getByTestId("ts-tooltip-turns")).toHaveTextContent("Turns");
    expect(screen.getByTestId("ts-tooltip-turns")).toHaveTextContent("18");
    expect(screen.getByTestId("ts-tooltip-signups")).toHaveTextContent("Signups");
  });

  it("clears the crosshair + tooltip on mouseleave", () => {
    const { container } = render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    const plot = screen.getByTestId("time-series-chart-plot");
    mockPlotWidth(plot);

    fireEvent.mouseMove(plot, { clientX: 500 });
    expect(container.querySelector(".time-series-chart__crosshair")).not.toBeNull();

    fireEvent.mouseLeave(plot);
    expect(container.querySelector(".time-series-chart__crosshair")).toBeNull();
    expect(screen.queryByTestId("time-series-chart-tooltip")).toBeNull();
  });

  it("is a no-op when the plot has no layout box (0 width) — never NaNs", () => {
    // No rect mock: jsdom reports width 0, so hover must guard and do nothing.
    const { container } = render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    const plot = screen.getByTestId("time-series-chart-plot");
    expect(() => fireEvent.mouseMove(plot, { clientX: 100 })).not.toThrow();
    expect(container.querySelector(".time-series-chart__crosshair")).toBeNull();
    expect(screen.queryByTestId("time-series-chart-tooltip")).toBeNull();
  });

  it("snaps to the sole bucket of a single-point series (centered)", () => {
    const single: ChartSeries = {
      key: "solo",
      label: "Solo",
      points: [{ t: BASE, value: 7 }],
    };
    const { container } = render(<TimeSeriesChart series={[single]} />);
    const plot = screen.getByTestId("time-series-chart-plot");
    mockPlotWidth(plot);

    fireEvent.mouseMove(plot, { clientX: 250 });
    expect(container.querySelector(".time-series-chart__crosshair")).not.toBeNull();
    expect(screen.getByTestId("ts-tooltip-solo")).toHaveTextContent("Solo");
    expect(screen.getByTestId("ts-tooltip-solo")).toHaveTextContent("7");
  });

  it("does not render hover elements before any pointer interaction", () => {
    const { container } = render(<TimeSeriesChart series={[TURNS_SERIES]} />);
    expect(container.querySelector(".time-series-chart__crosshair")).toBeNull();
    expect(screen.queryByTestId("time-series-chart-tooltip")).toBeNull();
  });
});

describe("TimeSeriesChart helpers", () => {
  it("formatValue compacts thousands and millions", () => {
    expect(formatValue(950)).toBe("950");
    expect(formatValue(12_345)).toBe("12.3k");
    expect(formatValue(2_500_000)).toBe("2.5M");
  });

  it("formatValue keeps integers whole", () => {
    expect(formatValue(0)).toBe("0");
    expect(formatValue(42)).toBe("42");
  });

  it("formatValue is safe on non-finite input", () => {
    expect(formatValue(NaN)).toBe("0");
  });

  it("formatTime returns a non-empty label for a valid epoch (day bucket)", () => {
    expect(formatTime(BASE, "day").length).toBeGreaterThan(0);
  });

  it("formatTime returns empty string for an invalid timestamp", () => {
    expect(formatTime(NaN, "day")).toBe("");
  });
});
