"use client";

import { useMemo } from "react";

import type { AdminChampionsItem } from "@/lib/admin/admin-types";

/**
 * ChampionsItemsView — the render half of the admin Champions-items screen
 * (`/admin/champions-items`).
 *
 * WHY: Pokémon Champions is still rolling out its held-item pool, and the
 * `@pkmn` data set has no per-item Champions legality, so every Gen-9 item would
 * otherwise show as legal. This grid lets the operator curate an ALLOWLIST:
 * every item is pre-checked (available); the operator unchecks the ones not in
 * the game yet, and re-checks them as they're added. Unchecking records an
 * exclusion that immediately removes the item from the team-builder picker, the
 * agent's resolution, and legality checks (read-time filter, no re-ingest).
 *
 * FIRST WRITE in the admin UI: unlike the read-only analytics views, toggling a
 * checkbox mutates (`POST /api/admin/champions-items`). The owning thin page
 * owns that fetch + optimistic state; this view stays PURE + CONTROLLED (imports
 * no db/repos/runtime, holds no network state) so it renders identically from
 * fixtures under the jsdom component project.
 */

/** Case-insensitive substring match over an item's display name and slug. */
function matchesQuery(item: AdminChampionsItem, needle: string): boolean {
  if (needle === "") return true;
  const q = needle.toLowerCase();
  return (
    item.displayName.toLowerCase().includes(q) ||
    item.slug.toLowerCase().includes(q)
  );
}

export interface ChampionsItemsViewProps {
  /** The full Champions item universe with current availability. */
  items: AdminChampionsItem[];
  /** Current client-side filter text (controlled by the page). */
  query: string;
  /** Emits the next filter text. */
  onQueryChange: (q: string) => void;
  /** Emits (slug, nextAvailable) when a checkbox is toggled. */
  onToggle: (slug: string, nextAvailable: boolean) => void;
  /** Mark EVERY item available (clear all exclusions). */
  onSelectAll?: () => void;
  /** Mark EVERY item unavailable — start from an empty allowlist. */
  onDeselectAll?: () => void;
  /** True while the initial list is loading. */
  loading?: boolean;
  /** A transport/HTTP error message, or null when healthy. */
  error?: string | null;
  /** Slugs with an in-flight toggle (checkbox disabled until it settles). */
  pending?: ReadonlySet<string>;
  /** True while a bulk Select/Deselect all is in flight. */
  bulkPending?: boolean;
}

export default function ChampionsItemsView({
  items,
  query,
  onQueryChange,
  onToggle,
  onSelectAll,
  onDeselectAll,
  loading = false,
  error = null,
  pending,
  bulkPending = false,
}: ChampionsItemsViewProps) {
  const availableCount = useMemo(
    () => items.reduce((n, it) => n + (it.available ? 1 : 0), 0),
    [items],
  );
  const excludedCount = items.length - availableCount;

  const visible = useMemo(
    () => items.filter((it) => matchesQuery(it, query.trim())),
    [items, query],
  );

  const emptyMessage = loading
    ? "Loading items…"
    : error
      ? "Could not load items."
      : items.length === 0
        ? "No Champions items in the index yet — run the ingest."
        : "No items match that search.";

  return (
    <section
      className="admin-page champions-items-view"
      data-testid="champions-items-view"
    >
      <h1 className="admin-page__title">Champions items</h1>

      <p className="champions-items-view__intro" data-testid="champions-items-intro">
        Every held item is <strong>available</strong> by default. Uncheck the
        items that aren&apos;t in Pokémon Champions yet — they immediately stop
        appearing in the team builder, in the assistant&apos;s suggestions, and
        count as illegal. Re-check them as they&apos;re added to the game. Or use{" "}
        <strong>Deselect all</strong> to start from an empty list and check only
        the valid items.
      </p>

      <div className="champions-items-view__toolbar">
        <label className="champions-items-view__field">
          <span className="champions-items-view__label">Search</span>
          <input
            type="search"
            className="champions-items-view__search"
            data-testid="champions-items-search"
            aria-label="Search Champions items"
            placeholder="Search by name…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </label>
        <div className="champions-items-view__meta">
          <p
            className="champions-items-view__summary"
            data-testid="champions-items-summary"
          >
            {availableCount} available · {excludedCount} unavailable ·{" "}
            {items.length} total
          </p>
          <div className="champions-items-view__bulk">
            <button
              type="button"
              className="champions-items-view__bulk-btn"
              data-testid="champions-items-select-all"
              disabled={bulkPending || items.length === 0}
              onClick={() => onSelectAll?.()}
            >
              Select all
            </button>
            <button
              type="button"
              className="champions-items-view__bulk-btn"
              data-testid="champions-items-deselect-all"
              disabled={bulkPending || items.length === 0}
              onClick={() => onDeselectAll?.()}
            >
              Deselect all
            </button>
          </div>
        </div>
      </div>

      {error != null && error !== "" && (
        <div className="champions-items-view__error" data-testid="champions-items-error" role="alert">
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="champions-items-view__empty" data-testid="champions-items-empty">
          {emptyMessage}
        </p>
      ) : (
        <ul className="champions-items-view__grid" data-testid="champions-items-grid">
          {visible.map((item) => {
            const busy = pending?.has(item.slug) ?? false;
            return (
              <li
                key={item.slug}
                className={`champions-items-view__item${
                  item.available ? "" : " champions-items-view__item--excluded"
                }`}
              >
                <label className="champions-items-view__toggle">
                  <input
                    type="checkbox"
                    data-testid={`champions-item-${item.slug}`}
                    checked={item.available}
                    disabled={busy}
                    aria-label={`${item.displayName} available in Champions`}
                    onChange={(e) => onToggle(item.slug, e.target.checked)}
                  />
                  <span className="champions-items-view__name">{item.displayName}</span>
                  <span className="champions-items-view__slug">{item.slug}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
