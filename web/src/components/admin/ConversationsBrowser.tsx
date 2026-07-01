"use client";

import type { ReactNode } from "react";

import DataTable, { type Column } from "./DataTable";
import type { ConversationSummary } from "@/lib/admin/admin-types";

/**
 * ConversationsBrowser — the render half of the admin Conversations screen
 * (ADMIN-US-9, ADMIN-AC-9.1): a searchable, format-filterable, keyset-paginated
 * table of saved conversations ACROSS ALL accounts (ADMIN-BR-4 owner-only
 * cross-account read access), with a row click that opens the full thread reader
 * (`/admin/conversations/[id]`, ADMIN-AC-9.2). Rows also include guest sessions
 * (synthesized from `turn_record`, not a real saved conversation) — a row with
 * `accountId: null` shows "Guest" in the Account column.
 *
 * Deliberately PURE + CONTROLLED (the admin component-test rule): it imports no
 * db/repos/runtime and holds no fetch/network state. The owning thin page
 * (`app/admin/conversations/page.tsx`) owns the
 * `fetch('/api/admin/conversations')` orchestration, the keyset cursor, and
 * routing; it threads everything in as props so this view renders identically
 * from fixtures in jsdom. That keeps the screen's render logic fully testable
 * while the page stays a thin integrator.
 *
 * The conversation browser is NOT date-range scoped — the API takes only
 * `q` (title-or-message substring search, ilike, AD-7) and `format`, so its own
 * lightweight controls live here rather than reusing the turns `FilterBar`
 * (whose model/mode/status/kind dimensions don't apply to saved threads) or the
 * global `DateRangePicker`.
 *
 * READ-ONLY (ADMIN-BR-2 / ADMIN-AC-9.3): every control is a query refinement and
 * the row click is drill-down navigation only — nothing here deletes, edits,
 * redacts, or flags a conversation or message.
 *
 * Refs:
 *   - docs/features/admin-panel/architecture/design.md § Component Design §5,
 *     § API Design (`GET /api/admin/conversations → ConversationsListResponse`;
 *     keyset cursor on (updated_at, id)), § Implementation Phases Phase 8.
 *   - requirements.md ADMIN-US-9, ADMIN-AC-9.1/9.2/9.3, ADMIN-BR-2/4.
 */

/**
 * The searchable/filterable subset this browser controls. An absent (undefined)
 * field means "no constraint" — the API treats it as the un-filtered default.
 * Keeping it a small explicit shape (rather than the wire `ConversationListOpts`,
 * which also carries `limit`/`cursor` wiring the page owns) means the dimensions
 * this bar emits can't drift from what the page sends.
 */
export interface ConversationFilterValue {
  q?: string;
  format?: string;
}

/** Human-readable label for a stored conversation format (matches the team UI). */
function formatLabel(format: string): string {
  if (format === "champions") return "Champions";
  if (format === "scarlet-violet") return "Scarlet/Violet";
  return format;
}

/** Compact epoch-ms → local datetime; tolerant of a 0/NaN value. */
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Integer with thousands separators; tolerant of nullish. */
function formatInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/** A title preview, collapsed + clipped for the table cell. */
function titlePreview(text: string, max = 80): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return "Untitled conversation";
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Format options for the dropdown (empty value = all formats). */
const FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: "scarlet-violet", label: "Scarlet/Violet" },
  { value: "champions", label: "Champions" },
];

export interface ConversationsBrowserProps {
  /** Current filter value (controlled by the page). */
  filter: ConversationFilterValue;
  /** Emits the full next filter object on any control change. */
  onFilterChange: (next: ConversationFilterValue) => void;
  /** The conversation rows fetched for the current filter/page. */
  rows: ConversationSummary[];
  /** True while the first page is loading (filter change). */
  loading?: boolean;
  /** A transport/HTTP error message, or null when healthy. */
  error?: string | null;
  /** True when another keyset page is available. */
  hasMore?: boolean;
  /** Invoked when "Load more" is activated. */
  onLoadMore?: () => void;
  /** True while a load-more fetch is in flight. */
  loadingMore?: boolean;
  /** Read-only drill-down navigation: open a thread (never a mutation). */
  onRowClick?: (conversation: ConversationSummary) => void;
}

export default function ConversationsBrowser({
  filter,
  onFilterChange,
  rows,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  onRowClick,
}: ConversationsBrowserProps) {
  // Emit the full next object; an empty raw value DROPS the dimension so the API
  // sees no constraint there (mirrors FilterBar's behavior).
  function update<K extends keyof ConversationFilterValue>(key: K, raw: string) {
    const next: ConversationFilterValue = { ...filter };
    if (raw === "") {
      delete next[key];
    } else {
      next[key] = raw as ConversationFilterValue[K];
    }
    onFilterChange(next);
  }

  const hasAnyFilter = Boolean(
    (filter.q && filter.q !== "") || (filter.format && filter.format !== ""),
  );

  const columns: Column<ConversationSummary>[] = [
    {
      key: "updated",
      header: "Updated",
      sortValue: (r) => r.updatedAt,
      render: (r) => (
        <span className="conversations-browser__time">
          {formatTimestamp(r.updatedAt)}
        </span>
      ),
    },
    {
      key: "title",
      header: "Title",
      sortValue: (r) => (r.title ?? "").toLowerCase(),
      render: (r) => (
        <span className="conversations-browser__title" title={r.title}>
          {titlePreview(r.title)}
        </span>
      ),
    },
    {
      key: "account",
      header: "Account",
      sortValue: (r) => r.accountEmail ?? r.accountId ?? "Guest",
      render: (r) => (r.accountId ? (r.accountEmail ?? r.accountId) : "Guest"),
    },
    {
      key: "format",
      header: "Format",
      sortValue: (r) => r.format,
      render: (r) => formatLabel(r.format),
    },
    {
      key: "messages",
      header: "Messages",
      align: "right",
      sortValue: (r) => r.messageCount,
      render: (r) => formatInt(r.messageCount),
    },
    {
      key: "created",
      header: "Created",
      sortValue: (r) => r.createdAt,
      render: (r) => (
        <span className="conversations-browser__time">
          {formatTimestamp(r.createdAt)}
        </span>
      ),
    },
  ];

  const emptyMessage: ReactNode = loading
    ? "Loading conversations…"
    : error
      ? "Could not load conversations."
      : "No conversations match this search.";

  return (
    <section
      className="admin-page conversations-browser"
      data-testid="conversations-browser"
    >
      <h1 className="admin-page__title">Conversations</h1>

      {/* Search + format controls (read-only query refinement). */}
      <div className="conversations-browser__filters" data-testid="conversations-filter">
        <label className="filter-bar__field filter-bar__field--search">
          <span className="filter-bar__label">Search</span>
          <input
            type="search"
            className="filter-bar__search"
            data-testid="conversations-search"
            aria-label="Search conversation title or message text"
            placeholder="Search title or message…"
            value={filter.q ?? ""}
            onChange={(e) => update("q", e.target.value)}
          />
        </label>
        <label className="filter-bar__field">
          <span className="filter-bar__label">Format</span>
          <select
            className="filter-bar__select"
            data-testid="conversations-format"
            aria-label="Format"
            value={filter.format ?? ""}
            onChange={(e) => update("format", e.target.value)}
          >
            <option value="">All formats</option>
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {hasAnyFilter && (
          <button
            type="button"
            className="filter-bar__clear"
            data-testid="conversations-clear"
            onClick={() => onFilterChange({})}
          >
            Clear
          </button>
        )}
      </div>

      {error != null && error !== "" && (
        <div
          className="conversations-browser__error"
          data-testid="conversations-browser-error"
          role="alert"
          style={{
            padding: "var(--space-3, 12px) var(--space-4, 16px)",
            border: "1px solid var(--danger, #ee5a5a)",
            borderRadius: "var(--radius-md, 8px)",
            color: "var(--danger, #ee5a5a)",
            fontSize: "var(--text-sm, 13px)",
          }}
        >
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        initialSort={{ key: "updated", dir: "desc" }}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
        emptyMessage={emptyMessage}
        caption="Saved conversations across all accounts and guest sessions"
      />
    </section>
  );
}
