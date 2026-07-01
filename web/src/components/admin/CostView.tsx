"use client";

/**
 * CostView — the render body of the admin Cost & tokens screen
 * (`/admin/cost`). Phase 7 observability screen for ADMIN-US-3 (cost & token
 * view): input/output/thinking token totals broken down by model
 * (ADMIN-AC-3.1) plus an ESTIMATED dollar cost with a trend over time
 * (ADMIN-AC-3.2), clearly labelled as an estimate and NOT authoritative
 * provider billing (ADMIN-BR-5 / AD-6).
 *
 * Pure & presentational (the ConversationList pattern): all data arrives via
 * props from the thin `app/admin/cost/page.tsx`, which owns the
 * `GET /api/admin/cost` fetch keyed off the global date range. This component
 * holds NO state, performs NO fetch, and imports NO db/repo/runtime — only the
 * client-safe wire types (`@/lib/admin/admin-types`), the client-safe model
 * registry (`@/agent/models`), and the shared admin primitives (`KpiCard`,
 * `TimeSeriesChart`, `DataTable`). That keeps it trivially fixture-renderable
 * under the jsdom component project (CLAUDE.md component-test rule), where the
 * Cost screen's logic is tested (`src/app/**` is not scanned for tests).
 *
 * Refs:
 *   - docs/features/admin-panel/architecture/design.md
 *       § API Design (`GET /api/admin/cost → CostResponse`, `estimated: true`)
 *       § Component Design › 5 (screens render with shared admin primitives)
 *       § Implementation Phases › Phase 7, AD-6 (cost is a static estimate).
 *   - requirements.md ADMIN-US-3, ADMIN-AC-3.1/3.2, ADMIN-BR-5/BR-8.
 *
 * CLIENT-SAFE: types + client-safe registry + sibling client primitives only.
 */

import type { CSSProperties, ReactElement } from "react";

import { isModelKey, modelLabel } from "@/agent/models";
import { enumerateBuckets } from "@/lib/admin/bucket-axis";
import type { CostByModel, CostResponse } from "@/lib/admin/admin-types";

import DataTable, { type Column } from "./DataTable";
import KpiCard from "./KpiCard";
import TimeSeriesChart, { type ChartSeries } from "./TimeSeriesChart";

export interface CostViewProps {
  /** The fetched cost breakdown, or null before the first response lands. */
  data: CostResponse | null;
  /** True while a (re)fetch is in flight — drives the first-load placeholder. */
  loading?: boolean;
  /** Set to a message when the fetch failed (transport / non-2xx). */
  error?: string | null;
}

/**
 * Format an estimated USD amount. Tiny non-zero amounts (sub-cent, common at
 * hobby volume) keep four decimals so they don't collapse to "$0.00"; otherwise
 * two decimals. Always prefixed with the unit; never the source of truth
 * (ADMIN-BR-5).
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Group a token count with thousands separators (deterministic en-US locale). */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/** Display name for a stored model value (known ModelKey → label, else raw). */
function modelDisplay(model: string): string {
  return isModelKey(model) ? modelLabel(model) : model;
}

/** Section heading shared by the chart + table cards (no extra CSS dependency). */
function sectionTitle(text: string): ReactElement {
  return (
    <h2
      className="admin-page__section-title"
      style={{
        margin: 0,
        fontSize: "var(--text-md, 0.95rem)",
        fontWeight: 600,
        color: "var(--text-strong, inherit)",
      }}
    >
      {text}
    </h2>
  );
}

const MUTED_STATE: CSSProperties = {
  padding: "var(--space-8, 2rem)",
  textAlign: "center",
  color: "var(--text-faint, #94867a)",
};

export default function CostView({ data, loading = false, error = null }: CostViewProps) {
  return (
    <section className="admin-page" data-testid="cost-view">
      <h1 className="admin-page__title">Cost &amp; tokens</h1>

      {error != null ? (
        <p style={MUTED_STATE} data-testid="cost-error">
          Couldn&apos;t load cost data. {error}
        </p>
      ) : data == null ? (
        <p style={MUTED_STATE} data-testid="cost-loading">
          {loading ? "Loading cost data…" : "No cost data."}
        </p>
      ) : (
        <CostBody data={data} />
      )}
    </section>
  );
}

/** The populated body — split out so the loading/error branches stay readable. */
function CostBody({ data }: { data: CostResponse }) {
  const byModel = Array.isArray(data.byModel) ? data.byModel : [];

  // Token totals across all models (ADMIN-AC-3.1).
  const totalInput = byModel.reduce((s, m) => s + (m.inputTokens || 0), 0);
  const totalOutput = byModel.reduce((s, m) => s + (m.outputTokens || 0), 0);
  const totalThinking = byModel.reduce((s, m) => s + (m.thinkingTokens || 0), 0);
  const hasUnpriced = byModel.some((m) => !m.priced);

  // Cost trend over the range (ADMIN-AC-3.2): one estUsd point per bucket.
  // Densify like the Overview usage chart — the repo emits only non-empty
  // buckets, so plot every bucket the range covers (zeros for the gaps) for a
  // continuous axis. Gated on `series.length` so an empty range keeps the
  // chart's empty-state placeholder.
  const rawSeries = Array.isArray(data.series) ? data.series : [];
  const domain = rawSeries.length === 0 ? [] : enumerateBuckets(data.range);
  const estByT = new Map<number, number>(rawSeries.map((b) => [b.t, b.estUsd]));
  const costSeries: ChartSeries = {
    key: "estUsd",
    label: "Estimated cost",
    color: "var(--success, #2fb573)",
    points: domain.map((t) => ({ t, value: estByT.get(t) ?? 0 })),
  };

  const columns: Column<CostByModel>[] = [
    {
      key: "model",
      header: "Model",
      sortValue: (r) => modelDisplay(r.model),
      render: (r) => (
        <span data-testid={`cost-model-${r.model}`}>
          {modelDisplay(r.model)}
          {!r.priced && (
            <span
              className="kpi-card__badge"
              data-testid={`cost-unpriced-${r.model}`}
              style={{ marginLeft: "var(--space-2, 0.5rem)" }}
            >
              unpriced
            </span>
          )}
        </span>
      ),
    },
    {
      key: "inputTokens",
      header: "Input",
      align: "right",
      sortValue: (r) => r.inputTokens,
      render: (r) => formatTokens(r.inputTokens),
    },
    {
      key: "outputTokens",
      header: "Output",
      align: "right",
      sortValue: (r) => r.outputTokens,
      render: (r) => formatTokens(r.outputTokens),
    },
    {
      key: "thinkingTokens",
      header: "Thinking",
      align: "right",
      sortValue: (r) => r.thinkingTokens,
      render: (r) => formatTokens(r.thinkingTokens),
    },
    {
      key: "estUsd",
      header: "Est. cost",
      align: "right",
      sortValue: (r) => r.estUsd,
      render: (r) => formatUsd(r.estUsd),
    },
  ];

  return (
    <>
      {/* Estimate caveat — ADMIN-BR-5 / AD-6: figures are estimates, not billing. */}
      <p
        data-testid="cost-estimate-note"
        style={{
          margin: 0,
          fontSize: "var(--text-sm, 0.85rem)",
          color: "var(--text-muted, #6e625a)",
        }}
      >
        Dollar figures are <strong>estimates</strong> from a static per-model
        price table — not authoritative provider billing.
      </p>

      <div className="admin-kpi-grid" data-testid="cost-kpis">
        <KpiCard
          label="Estimated cost"
          value={formatUsd(data.totalEstUsd)}
          estimated
          hint="over the selected range"
        />
        <KpiCard label="Input tokens" value={formatTokens(totalInput)} />
        <KpiCard label="Output tokens" value={formatTokens(totalOutput)} />
        <KpiCard label="Thinking tokens" value={formatTokens(totalThinking)} />
      </div>

      <div
        data-testid="cost-trend"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 0.5rem)" }}
      >
        {sectionTitle("Estimated cost over time")}
        <TimeSeriesChart
          series={[costSeries]}
          area
          bucket={data.range.bucket}
          yFormat={formatUsd}
          ariaLabel="Estimated cost over time"
          emptyLabel="No cost recorded for this range"
        />
      </div>

      <div
        data-testid="cost-by-model"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 0.5rem)" }}
      >
        {sectionTitle("By model")}
        <DataTable
          columns={columns}
          rows={byModel}
          rowKey={(r) => r.model}
          initialSort={{ key: "estUsd", dir: "desc" }}
          emptyMessage="No model usage in this range."
          caption="Tokens and estimated cost by model"
        />
        {hasUnpriced && (
          <p
            data-testid="cost-unpriced-note"
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.75rem)",
              color: "var(--text-faint, #94867a)",
            }}
          >
            Models marked <em>unpriced</em> have no entry in the price table, so
            their estimated cost reads $0.00.
          </p>
        )}
      </div>
    </>
  );
}
