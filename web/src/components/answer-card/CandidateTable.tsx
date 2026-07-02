"use client";

import type { CandidateTableProps, CandidateRow } from "@/components/types";
import TypeBadge from "@/components/TypeBadge";
import SpriteImg from "@/components/SpriteImg";
import EntityLink from "@/components/artifact/EntityLink";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";
import { pokeApiSprite } from "@/lib/sprites";

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
 * Human-readable labels for the query_pokedex sort fields. The raw `sort` value
 * is a technical `"<field> <asc|desc>"` string (e.g. `"base_stat_total desc"`);
 * the chip should read "Base Stat Total", not "BASE_STAT_TOTAL DESC".
 */
const SORT_FIELD_LABELS: Record<string, string> = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  special_attack: "Special Attack",
  special_defense: "Special Defense",
  speed: "Speed",
  base_stat_total: "Base Stat Total",
  national_dex_number: "National Dex No.",
};

/**
 * Turn the raw `sort` string ("base_stat_total desc") into a friendly field
 * label plus a direction arrow (↓ high→low for desc, ↑ low→high for asc).
 * Unknown fields fall back to a Title-Cased version of the slug.
 */
function formatSort(sort: string): { field: string; arrow: string } {
  const [field, direction] = sort.trim().split(/\s+/);
  const label =
    SORT_FIELD_LABELS[field] ??
    field
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  const arrow = direction === "asc" ? "↑" : direction === "desc" ? "↓" : "";
  return { field: label, arrow };
}

/**
 * CandidateTable — renders the `candidates` result set for filter/superlative
 * answers (US-1/2/3).
 *
 * Always shows an honest "N of M" header when `candidates.truncated` is true
 * (the displayed `shown.length` vs. `total_count`).  Every row is clickable and
 * opens that Pokémon's artifact in the viewer (AV-US-1).
 *
 * Visual styling (grid vs table, column widths, hover states) deferred to
 * `frontend-design`.
 */
export default function CandidateTable({
  candidates,
  onShowAll,
  disabled = false,
}: CandidateTableProps) {
  const { total_count, truncated, shown, sort } = candidates;

  const countLabel = truncated
    ? `Showing ${shown.length} of ${total_count}`
    : `${total_count} result${total_count !== 1 ? "s" : ""}`;

  const sortDisplay = sort ? formatSort(sort) : null;

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
        {sortDisplay && (
          <span
            className="candidate-table__sort"
            data-testid="candidate-table-sort"
          >
            sorted by{" "}
            <span className="candidate-table__sort-field">
              {sortDisplay.field}
              {sortDisplay.arrow && (
                <span className="candidate-table__sort-dir">
                  {" "}
                  {sortDisplay.arrow}
                </span>
              )}
            </span>
          </span>
        )}
        {truncated && onShowAll && (
          <button
            type="button"
            className="candidate-table__show-all"
            data-testid="candidate-table-show-all"
            onClick={onShowAll}
            disabled={disabled}
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
}

function CandidateRow({
  row,
  index,
  hasStats,
  hasAbilityColumn,
}: CandidateRowProps) {
  const { openEntity } = useArtifactViewer();

  // The whole row opens that Pokémon's artifact (AV-US-1). The name/type
  // EntityLinks below are still real <button>s — they preserve keyboard access
  // and (via their own stopPropagation) keep a type-chip click scoped to the
  // type artifact rather than re-opening the row's Pokémon.
  return (
    <tr
      className="candidate-table__row candidate-table__row--clickable"
      onClick={() => openEntity({ kind: "pokemon", q: row.name })}
      data-testid={`candidate-row-${index}`}
    >
      <td className="candidate-table__name-cell">
        <div className="candidate-table__name-inner">
          {row.sprite_url && (
            <SpriteImg
              src={row.sprite_url}
              fallbackSrc={
                row.dex_number != null ? pokeApiSprite(row.dex_number) : undefined
              }
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
