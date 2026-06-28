/**
 * MatchupRow — a labeled row of clickable type badges, shared by the Pokémon
 * profile's combined defensive grid and the Type artifact's offensive/defensive
 * grids. Each badge drills into that type's artifact (AV-US-5). An empty list
 * renders a muted "—" so the row reads honestly rather than vanishing.
 */

"use client";

import TypeBadge from "@/components/TypeBadge";
import type { TypeName } from "@/agent/schemas";

import EntityLink from "./EntityLink";

export interface MatchupRowProps {
  label: string;
  types: string[];
  testid?: string;
  /**
   * Optional per-type damage-magnitude label (e.g. "x4", "x2", "x0"). When
   * provided, a small badge is rendered after each type badge so the row shows
   * HOW strong the matchup is (#12). Omitted by callers (the Type artifact's
   * grids) that only need the badge list.
   */
  multiplierFor?: (type: string) => string | undefined;
}

export default function MatchupRow({
  label,
  types,
  testid,
  multiplierFor,
}: MatchupRowProps): React.JSX.Element {
  return (
    <div className="matchup-row" data-testid={testid}>
      <span className="matchup-row__label">{label}</span>
      <span className="matchup-row__badges">
        {types.length === 0 ? (
          <span className="matchup-row__empty">—</span>
        ) : (
          types.map((t) => {
            const multiplier = multiplierFor?.(t);
            return (
              <span key={t} className="matchup-row__entry">
                <EntityLink kind="type" q={t} className="entity-link--type">
                  <TypeBadge type={t as TypeName} />
                </EntityLink>
                {multiplier && (
                  <span className="matchup-row__mult">{multiplier}</span>
                )}
              </span>
            );
          })
        )}
      </span>
    </div>
  );
}
