"use client";

import { useRef, useState } from "react";

import type { BucketSize } from "@/lib/admin/admin-types";

/**
 * TimeSeriesChart — a bucketed line / area chart for the admin observability
 * screens (Overview usage series, Cost trend, etc.). HAND-ROLLED inline SVG;
 * NO charting dependency (ADR / design § Tech Stack: "the charts can be
 * hand-rolled as inline SVG/CSS sparklines"). One or more named series of
 * `(t, value)` points are plotted over a shared time axis.
 *
 * Rendering strategy (jsdom-safe, no layout measurement):
 *   - A fixed LOGICAL coordinate space (`VIEW_W` × `height`) drives all path
 *     math. The <svg> declares `width="100%"` + a fixed pixel `height`, with
 *     `preserveAspectRatio="none"` so the logical width stretches to the
 *     container while the vertical axis stays 1:1 with the pixel height.
 *   - Every stroked element carries `vector-effect="non-scaling-stroke"`, so
 *     lines and single-point dots (zero-length round-capped <line>s) stay crisp
 *     and undistorted at any container width.
 *   - Axis tick labels and the legend are plain HTML positioned by percentage
 *     (text never goes through the distorting viewBox). Because the SVG's
 *     vertical axis is 1:1 with its pixel height, `top: <pct>%` overlays align
 *     exactly with the SVG y-scale.
 *
 * Interactivity: a pointer (or touch) over the plot snaps a vertical crosshair +
 * a per-series dot to the NEAREST bucket and shows an HTML tooltip of that
 * bucket's values (local `hoverT` state only — the crosshair/dots/tooltip render
 * only while hovering, so the static DOM is unchanged). It still reads NO
 * db/repo/runtime and renders from its props, so the jsdom component test renders
 * it from fixtures (and an empty series) without a Postgres connection.
 */

/** A single plotted point: x is a bucket-start epoch-ms, y is the value. */
export interface TimeSeriesPoint {
  /** Bucket start, epoch ms (x axis). */
  t: number;
  /** Value at this bucket (y axis). */
  value: number;
}

/** A named, colored series of points (one line + optional area fill). */
export interface ChartSeries {
  /** Stable id (used for React keys + `data-testid`). */
  key: string;
  /** Legend label. */
  label: string;
  /**
   * Stroke/fill color. Defaults to the next entry in {@link DEFAULT_PALETTE}.
   * Any CSS color string (incl. `var(--token, #fallback)`).
   */
  color?: string;
  /** The series' points; may be empty (renders nothing for that series). */
  points: TimeSeriesPoint[];
}

export interface TimeSeriesChartProps {
  /** One or more series to plot over a shared time axis. */
  series: ChartSeries[];
  /** Rendered pixel height of the plot (also the logical viewBox height). Default 180. */
  height?: number;
  /** Fill the area under each line. Default false (line only). */
  area?: boolean;
  /** Bucket granularity — only affects x-axis label formatting. Default "day". */
  bucket?: BucketSize;
  /** y-axis tick / value formatter. Default: compact integer-ish formatting. */
  yFormat?: (value: number) => string;
  /** Number of horizontal gridline / y-tick rows (incl. min & max). Default 3. */
  yTicks?: number;
  /** Copy shown when there are no points across all series. */
  emptyLabel?: string;
  /** Accessible label for the chart figure. */
  ariaLabel?: string;
  /** Extra class on the root element (composed after `time-series-chart`). */
  className?: string;
}

/** Logical viewBox width — the x axis stretches to fill the container. */
const VIEW_W = 1000;
const DEFAULT_HEIGHT = 180;

/**
 * Default series colors, drawn from the app's design tokens (globals.css) with
 * hex fallbacks so the chart still colors correctly outside the token context
 * (e.g. in the jsdom test render).
 */
const DEFAULT_PALETTE = [
  "var(--azure, #3aa0e3)",
  "var(--sunflower, #f5a524)",
  "var(--success, #2fb573)",
  "var(--poke-red, #ee5a5a)",
  "var(--type-psychic, #f95587)",
  "var(--type-dragon, #6f35fc)",
];

/** Compact default y/value formatter: 12 345 → "12.3k", integers stay whole. */
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trimZeros(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZeros(v / 1_000)}k`;
  if (Number.isInteger(v)) return String(v);
  return trimZeros(v);
}

function trimZeros(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** Format a bucket-start epoch-ms for the x axis, by bucket granularity. */
function formatTime(t: number, bucket: BucketSize): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  if (bucket === "hour") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TimeSeriesChart({
  series,
  height = DEFAULT_HEIGHT,
  area = false,
  bucket = "day",
  yFormat = formatValue,
  yTicks = 3,
  emptyLabel = "No data for this range",
  ariaLabel = "Time series chart",
  className,
}: TimeSeriesChartProps) {
  const allSeries = Array.isArray(series) ? series : [];
  const allPoints = allSeries.flatMap((s) => (Array.isArray(s.points) ? s.points : []));

  const rootClass = className
    ? `time-series-chart ${className}`
    : "time-series-chart";

  // Hover state — declared BEFORE any early return (Rules of Hooks). `hoverT` is
  // the bucket-start the crosshair/tooltip snap to; null when not hovering.
  const [hoverT, setHoverT] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  // ---- Empty state: no points anywhere ------------------------------------
  if (allPoints.length === 0) {
    return (
      <figure
        className={`${rootClass} time-series-chart--empty`}
        data-testid="time-series-chart"
        role="img"
        aria-label={ariaLabel}
        style={{ margin: 0 }}
      >
        <div
          className="time-series-chart__empty"
          data-testid="time-series-chart-empty"
          style={{
            height,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-faint, #94867a)",
            font: "500 13px/1.4 var(--body, system-ui, sans-serif)",
          }}
        >
          {emptyLabel}
        </div>
      </figure>
    );
  }

  // ---- Domains ------------------------------------------------------------
  const xs = allPoints.map((p) => p.t);
  const ys = allPoints.map((p) => p.value);
  const xMin = Math.min(...xs);
  const xMaxRaw = Math.max(...xs);
  // Avoid a zero-width x domain (single distinct bucket) → place it mid-chart.
  const xSpan = xMaxRaw - xMin || 1;

  const dataMax = Math.max(...ys);
  const yMin = Math.min(0, ...ys); // baseline at 0 for the usual non-negative data
  const yMax = dataMax > yMin ? dataMax : yMin + 1; // avoid a zero-height y domain
  const ySpan = yMax - yMin;

  const sx = (t: number) =>
    xMaxRaw === xMin ? VIEW_W / 2 : ((t - xMin) / xSpan) * VIEW_W;
  const sy = (v: number) => height - ((v - yMin) / ySpan) * height;

  // Baseline (where the area fill closes to): the y=0 line if 0 is in range,
  // else the bottom of the chart.
  const baselineV = Math.min(Math.max(0, yMin), yMax);
  const baselineY = sy(baselineV);

  // ---- y ticks (top → bottom) ---------------------------------------------
  const tickCount = Math.max(2, Math.floor(yTicks));
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const v = yMin + (ySpan * i) / (tickCount - 1);
    return { v, pct: (1 - (v - yMin) / ySpan) * 100 };
  }).reverse(); // highest value first (renders top → bottom)

  // Series color resolver — shared by the legend, lines, hover dots, and tooltip
  // so all four always agree on a series' color.
  const colorAt = (i: number) =>
    allSeries[i]?.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];

  // ---- Hover: snap to the nearest distinct bucket -------------------------
  // The distinct bucket-starts across all series; the pointer picks the closest.
  const domain = [...new Set(xs)].sort((a, b) => a - b);
  const snapToNearest = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return; // not laid out (or jsdom) → no-op
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const logicalX = frac * VIEW_W;
    let best = domain[0];
    let bestDist = Infinity;
    for (const t of domain) {
      const dist = Math.abs(sx(t) - logicalX);
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    if (best !== hoverT) setHoverT(best);
  };

  // The hovered bucket's per-series rows (only series that have that bucket) +
  // the crosshair's logical-x. Used by the SVG overlay and the HTML tooltip.
  const hoverX = hoverT == null ? 0 : sx(hoverT);
  const hoverRows =
    hoverT == null
      ? []
      : allSeries
          .map((s, i) => {
            const pt = (Array.isArray(s.points) ? s.points : []).find(
              (p) => p.t === hoverT,
            );
            return pt
              ? { key: s.key, label: s.label, color: colorAt(i), value: pt.value }
              : null;
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <figure
      className={rootClass}
      data-testid="time-series-chart"
      role="img"
      aria-label={ariaLabel}
      style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}
    >
      {/* Legend */}
      <div
        className="time-series-chart__legend"
        data-testid="time-series-chart-legend"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          font: "500 12px/1 var(--body, system-ui, sans-serif)",
          color: "var(--text-muted, #6e625a)",
        }}
      >
        {allSeries.map((s, i) => (
          <span
            key={s.key}
            className="time-series-chart__legend-item"
            data-testid={`ts-legend-${s.key}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              aria-hidden="true"
              className="time-series-chart__swatch"
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: colorAt(i),
                display: "inline-block",
              }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {/* Plot area: SVG + percentage-positioned y-axis labels */}
      <div
        ref={plotRef}
        className="time-series-chart__plot"
        data-testid="time-series-chart-plot"
        onMouseMove={(e) => snapToNearest(e.clientX)}
        onMouseLeave={() => setHoverT(null)}
        onTouchMove={(e) => {
          const touch = e.touches[0];
          if (touch) snapToNearest(touch.clientX);
        }}
        onTouchEnd={() => setHoverT(null)}
        style={{
          position: "relative",
          width: "100%",
          height,
          cursor: "crosshair",
          touchAction: "pan-y",
        }}
      >
        <svg
          className="time-series-chart__svg"
          data-testid="time-series-chart-svg"
          width="100%"
          height={height}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          role="presentation"
          style={{ display: "block", overflow: "visible" }}
        >
          {/* Horizontal gridlines at each y tick */}
          {ticks.map((tick, i) => {
            const y = sy(tick.v);
            return (
              <line
                key={`grid-${i}`}
                className="time-series-chart__grid"
                x1={0}
                y1={y}
                x2={VIEW_W}
                y2={y}
                stroke="var(--border, #e9e0d8)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                shapeRendering="crispEdges"
              />
            );
          })}

          {/* Series: optional area fill + line (or a dot for a single point) */}
          {allSeries.map((s, i) => {
            const color = colorAt(i);
            const pts = (Array.isArray(s.points) ? s.points : [])
              .slice()
              .sort((a, b) => a.t - b.t);
            if (pts.length === 0) return null;

            const coords = pts.map((p) => ({ x: sx(p.t), y: sy(p.value) }));
            const linePoints = coords
              .map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`)
              .join(" ");

            if (coords.length === 1) {
              // Single point → a zero-length round-capped line renders as a
              // crisp, non-distorted dot under preserveAspectRatio="none".
              const c = coords[0];
              return (
                <line
                  key={s.key}
                  className="time-series-chart__dot"
                  data-testid={`ts-series-${s.key}`}
                  x1={c.x}
                  y1={c.y}
                  x2={c.x}
                  y2={c.y}
                  stroke={color}
                  strokeWidth={7}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            }

            const areaPath = area
              ? `M ${coords[0].x.toFixed(2)},${baselineY.toFixed(2)} ` +
                coords
                  .map((c) => `L ${c.x.toFixed(2)},${c.y.toFixed(2)}`)
                  .join(" ") +
                ` L ${coords[coords.length - 1].x.toFixed(2)},${baselineY.toFixed(2)} Z`
              : null;

            return (
              <g key={s.key} data-testid={`ts-series-${s.key}`}>
                {areaPath && (
                  <path
                    className="time-series-chart__area"
                    d={areaPath}
                    fill={color}
                    fillOpacity={0.12}
                    stroke="none"
                  />
                )}
                <polyline
                  className="time-series-chart__line"
                  points={linePoints}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}

          {/* Hover crosshair + per-series dots (only while hovering). Dots reuse
              the zero-length round-cap <line> trick so they stay round under
              preserveAspectRatio="none" (a <circle> would distort to an ellipse). */}
          {hoverT != null && (
            <g className="time-series-chart__hover" aria-hidden="true">
              <line
                className="time-series-chart__crosshair"
                x1={hoverX}
                y1={0}
                x2={hoverX}
                y2={height}
                stroke="var(--text-muted, #6e625a)"
                strokeWidth={1}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
              {hoverRows.map((r) => {
                const cy = sy(r.value);
                return (
                  <g key={r.key}>
                    {/* white halo so the dot reads over a same-colored line */}
                    <line
                      className="time-series-chart__hover-halo"
                      x1={hoverX}
                      y1={cy}
                      x2={hoverX}
                      y2={cy}
                      stroke="var(--surface, #fff)"
                      strokeWidth={9}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      className="time-series-chart__hover-dot"
                      x1={hoverX}
                      y1={cy}
                      x2={hoverX}
                      y2={cy}
                      stroke={r.color}
                      strokeWidth={6}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })}
            </g>
          )}
        </svg>

        {/* y-axis tick labels overlaid on the plot (aligned to the gridlines) */}
        <div
          className="time-series-chart__yaxis"
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {ticks.map((tick, i) => (
            <span
              key={`ylabel-${i}`}
              className="time-series-chart__ytick"
              data-testid={`ts-ytick-${i}`}
              style={{
                position: "absolute",
                left: 0,
                top: `${tick.pct}%`,
                transform: "translateY(-50%)",
                padding: "0 4px",
                font: "500 10px/1 var(--mono, ui-monospace, monospace)",
                color: "var(--text-faint, #94867a)",
                background: "var(--surface, #fff)",
              }}
            >
              {yFormat(tick.v)}
            </span>
          ))}
        </div>

        {/* Hover tooltip: the hovered bucket's time + each series' value. Anchored
            to the crosshair via left:% (same logical→% mapping as the crosshair),
            flipped past the midpoint so it never overflows the right edge. */}
        {hoverT != null && hoverRows.length > 0 && (
          <div
            className="time-series-chart__tooltip"
            data-testid="time-series-chart-tooltip"
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 4,
              left: `${(hoverX / VIEW_W) * 100}%`,
              transform:
                hoverX / VIEW_W >= 0.5
                  ? "translateX(calc(-100% - 10px))"
                  : "translateX(10px)",
              pointerEvents: "none",
              zIndex: 2,
              background: "var(--surface, #fff)",
              border: "1px solid var(--border, #e9e0d8)",
              borderRadius: 6,
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)",
              padding: "6px 8px",
              font: "500 11px/1.35 var(--body, system-ui, sans-serif)",
              color: "var(--text-strong, #2b2320)",
              whiteSpace: "nowrap",
            }}
          >
            <div
              className="time-series-chart__tooltip-time"
              style={{ marginBottom: 4, color: "var(--text-muted, #6e625a)" }}
            >
              {formatTime(hoverT, bucket)}
            </div>
            {hoverRows.map((r) => (
              <div
                key={r.key}
                className="time-series-chart__tooltip-row"
                data-testid={`ts-tooltip-${r.key}`}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: r.color,
                    display: "inline-block",
                    flex: "0 0 auto",
                  }}
                />
                <span style={{ flex: "1 1 auto" }}>{r.label}</span>
                <span
                  style={{
                    marginLeft: 10,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {yFormat(r.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* x-axis tick labels (first / middle / last bucket) */}
      <div
        className="time-series-chart__xaxis"
        data-testid="time-series-chart-xaxis"
        style={{
          display: "flex",
          justifyContent: "space-between",
          font: "500 10px/1 var(--mono, ui-monospace, monospace)",
          color: "var(--text-faint, #94867a)",
        }}
      >
        <span className="time-series-chart__xtick">
          {formatTime(xMin, bucket)}
        </span>
        {xMaxRaw !== xMin && (
          <span className="time-series-chart__xtick">
            {formatTime(xMaxRaw, bucket)}
          </span>
        )}
      </div>
    </figure>
  );
}

/** Re-exported helpers (pure) — handy for callers shaping repo data into series. */
export { formatValue, formatTime };
