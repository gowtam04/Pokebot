/**
 * TypeMatchupsArtifact — a type's offensive and defensive matchup grids (TD-3:
 * the "type-grid" artifact IS the type entity). Offensive is present for a
 * single-type profile; a combined two-type profile is defensive-only.
 */

"use client";

import type { TypeArtifactData } from "@/lib/entity-artifact";

import MatchupRow from "./MatchupRow";

export interface TypeMatchupsArtifactProps {
  data: TypeArtifactData;
}

export default function TypeMatchupsArtifact({
  data,
}: TypeMatchupsArtifactProps): React.JSX.Element {
  return (
    <div className="type-artifact" data-testid="type-artifact">
      {data.offensive && (
        <section className="type-artifact__section">
          <h3 className="artifact-section__title">Offensive</h3>
          <div className="matchup-grid" data-testid="type-offensive">
            <MatchupRow
              label="Super effective vs"
              types={data.offensive.super_effective_against}
              testid="offensive-super"
            />
            <MatchupRow
              label="Not very effective vs"
              types={data.offensive.not_very_effective_against}
              testid="offensive-nve"
            />
            <MatchupRow
              label="No effect vs"
              types={data.offensive.no_effect_against}
              testid="offensive-immune"
            />
          </div>
        </section>
      )}

      <section className="type-artifact__section">
        <h3 className="artifact-section__title">Defensive</h3>
        <div className="matchup-grid" data-testid="type-defensive">
          <MatchupRow
            label="Weak to"
            types={data.defensive.weak_to}
            testid="defensive-weak"
          />
          <MatchupRow
            label="Resists"
            types={data.defensive.resists}
            testid="defensive-resists"
          />
          <MatchupRow
            label="Immune to"
            types={data.defensive.immune_to}
            testid="defensive-immune"
          />
        </div>
      </section>
    </div>
  );
}
