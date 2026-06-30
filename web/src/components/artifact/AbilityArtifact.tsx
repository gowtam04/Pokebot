/**
 * AbilityArtifact — an ability's effect text plus the roster of species that
 * have it (B-4 `learned_by`), each clickable to drill into that Pokémon.
 */

"use client";

import type { AbilityArtifactData } from "@/lib/entity-artifact";

import EntityLink from "./EntityLink";

export interface AbilityArtifactProps {
  data: AbilityArtifactData;
}

export default function AbilityArtifact({
  data,
}: AbilityArtifactProps): React.JSX.Element {
  return (
    <div className="ability-artifact" data-testid="ability-artifact">
      <section className="ability-artifact__effect">
        <h3 className="artifact-section__title">Effect</h3>
        <p className="artifact-text" data-testid="ability-effect">
          {data.effect_full || data.effect_short}
        </p>
      </section>

      <section className="ability-artifact__holders">
        <h3 className="artifact-section__title">
          Pokémon with this ability ({data.learned_by.length})
        </h3>
        {data.learned_by.length === 0 ? (
          <p className="artifact-empty">None recorded for this format.</p>
        ) : (
          <div className="ability-chips" data-testid="ability-holders">
            {data.learned_by.map((holder) => (
              <EntityLink
                key={holder.slug}
                kind="pokemon"
                q={holder.slug}
                className="entity-link--chip"
                testid={`ability-holder-${holder.slug}`}
              >
                {holder.display_name}
              </EntityLink>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
