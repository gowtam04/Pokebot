"use client";

import type { CandidateTableProps, CandidateRow } from "@/components/types";
import TypeBadge from "@/components/TypeBadge";
import EntityLink from "@/components/artifact/EntityLink";

/** Fixed display order for the six base stats (HP, Attack, Defense, SpA, SpD, Speed). */
const STAT_ORDER = [
  "hp",
  "attack",
  "defense",
  "special_attack",
  "special_defense",
  "speed",
] as const;

/** Short competitive labels for each base stat, in {@link STAT_ORDER}. */
const STAT_LABELS: Record<(typeof STAT_ORDER)[number], string> = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  special_attack: "SpA",
  special_defense: "SpD",
  speed: "Speed",
};

/**
 * CandidateTable — renders the `candidates` result set for filter/superlative
 * answers (US-1/2/3).
 *
 * Always shows an honest "N of M" header when `candidates.truncated` is true
 * (the displayed `shown.length` vs. `total_count`).  `onSelect` is optional;
 * when provided, rows are clickable and POST a follow-up for the selected name.
 *
 * Visual styling (grid vs table, column widths, hover states) deferred to
 * `frontend-design`.
 */
export default function CandidateTable({
  candidates,
  onSelect,
  onShowAll,
}: CandidateTableProps) {
  const { total_count, truncated, shown, sort } = candidates;

  const countLabel = truncated
    ? `Showing ${shown.length} of ${total_count}`
    : `${total_count} result${total_count !== 1 ? "s" : ""}`;

  const hasAbilityColumn = shown.some((row) => row.ability != null);
  const hasStats = shown.some(
    (row) =>
      row.base_stats != null ||
      (row.key_stats != null && Object.keys(row.key_stats).length > 0),
  );

  return (
    <div className="candidate-table" data-testid="candidate-table">
      <div className="candidate-table__header">
        <span
          className="candidate-table__count"
          data-testid="candidate-table-count"
        >
          {countLabel}
        </span>
        {sort && (
          <span
            className="candidate-table__sort"
            data-testid="candidate-table-sort"
          >
            sorted by {sort}
          </span>
        )}
        {truncated && onShowAll && (
          <button
            type="button"
            className="candidate-table__show-all"
            data-testid="candidate-table-show-all"
            onClick={onShowAll}
          >
            Show all {total_count}
          </button>
        )}
      </div>

      <div className="candidate-table__scroll">
        <table className="candidate-table__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Types</th>
              {hasStats && <th scope="col">Stats</th>}
              {hasAbilityColumn && <th scope="col">Ability</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <CandidateRow
                key={`${row.name}-${i}`}
                row={row}
                index={i}
                hasStats={hasStats}
                hasAbilityColumn={hasAbilityColumn}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal row component
// ---------------------------------------------------------------------------

interface CandidateRowProps {
  row: CandidateRow;
  index: number;
  hasStats: boolean;
  hasAbilityColumn: boolean;
  onSelect?: (name: string) => void;
}

function CandidateRow({
  row,
  index,
  hasStats,
  hasAbilityColumn,
  onSelect,
}: CandidateRowProps) {
  const clickable = onSelect != null;

  function handleClick() {
    onSelect?.(row.name);
  }

  return (
    <tr
      className={`candidate-table__row${clickable ? " candidate-table__row--clickable" : ""}`}
      onClick={clickable ? handleClick : undefined}
      data-testid={`candidate-row-${index}`}
    >
      <td className="candidate-table__name-cell">
        <div className="candidate-table__name-inner">
          {row.sprite_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.sprite_url}
              alt={row.name}
              width={40}
              height={40}
              className="candidate-table__sprite"
            />
          )}
          <EntityLink
            kind="pokemon"
            q={row.name}
            className="candidate-table__name-link"
            testid={`candidate-entity-${index}`}
          >
            {row.name}
            {row.dex_number != null && (
              <span className="candidate-table__dex"> #{row.dex_number}</span>
            )}
          </EntityLink>
        </div>
      </td>
      <td className="candidate-table__types-cell">
        <div className="candidate-table__types-inner">
          {row.types.map((type) => (
            <EntityLink
              key={type}
              kind="type"
              q={type}
              className="entity-link--type"
            >
              <TypeBadge type={type} />
            </EntityLink>
          ))}
        </div>
      </td>
      {hasStats && (
        <td className="candidate-table__stats-cell">
          <div className="candidate-table__stats-grid">
            {row.base_stats != null
              ? // Full six stats, always in the fixed competitive order.
                STAT_ORDER.map((k) => (
                  <span key={k} className="candidate-table__stat-item">
                    {STAT_LABELS[k]}: {row.base_stats![k]}
                  </span>
                ))
              : // Fallback for older/edge answers that only carry key_stats.
                row.key_stats != null &&
                Object.entries(row.key_stats).map(([k, v]) => (
                  <span key={k} className="candidate-table__stat-item">
                    {k}: {String(v)}
                  </span>
                ))}
          </div>
        </td>
      )}
      {hasAbilityColumn && (
        <td className="candidate-table__ability-cell">{row.ability ?? "—"}</td>
      )}
    </tr>
  );
}
