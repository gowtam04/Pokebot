/**
 * PokemonArtifact — the full species profile (B-4, AV-US-1, BR-AV-3): artwork,
 * dex number, clickable types, base stats, clickable abilities, the combined
 * defensive grid, and the movepool grouped by learn method with clickable,
 * type-badged moves.
 */

"use client";

import TypeBadge from "@/components/TypeBadge";
import type { TypeName } from "@/agent/schemas";
import type { PokemonArtifactData } from "@/lib/entity-artifact";

import EntityLink from "./EntityLink";
import MatchupRow from "./MatchupRow";

const STAT_ROWS: { key: keyof PokemonArtifactData["base_stats"]; label: string }[] =
  [
    { key: "hp", label: "HP" },
    { key: "attack", label: "Attack" },
    { key: "defense", label: "Defense" },
    { key: "special_attack", label: "Sp. Atk" },
    { key: "special_defense", label: "Sp. Def" },
    { key: "speed", label: "Speed" },
  ];

/**
 * Stat bars normalize against a legible single-stat ceiling (well under the
 * theoretical 255 max) so typical base stats span the track instead of all
 * hugging the left rail (#9).
 */
const STAT_BAR_CEILING = 200;

function statPct(value: number): string {
  return `${Math.min(100, Math.round((value / STAT_BAR_CEILING) * 100))}%`;
}

/** Coarse value tier used to color the bar fill (low / mid / high) (#9). */
function statTier(value: number): string {
  if (value >= 110) return "stat-list__bar-fill--high";
  if (value >= 75) return "stat-list__bar-fill--mid";
  return "stat-list__bar-fill--low";
}

/**
 * Title-case a slug-ish id (`cud-chew` → `Cud Chew`) for display. Mirrors the
 * helper in ProposedTeamCard; the raw slug is still handed to EntityLink `q=`
 * so links keep resolving (#3).
 */
function titleize(value: string): string {
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Order a group's moves by type (alphabetical), then alphabetically by name
 * within each type, so same-type moves cluster together in the chip grid and
 * their colored badges read as type groups. Untyped moves sort last.
 */
function sortMovesByType<T extends { type: string; display_name: string }>(
  moves: readonly T[],
): T[] {
  return [...moves].sort((a, b) => {
    const typeA = a.type || "￿";
    const typeB = b.type || "￿";
    return (
      typeA.localeCompare(typeB) || a.display_name.localeCompare(b.display_name)
    );
  });
}

export interface PokemonArtifactProps {
  data: PokemonArtifactData;
}

export default function PokemonArtifact({
  data,
}: PokemonArtifactProps): React.JSX.Element {
  const { abilities, matchups } = data;
  // Titleize the DISPLAY label but keep the raw slug for EntityLink q= (#3);
  // the hidden flag drives a separate badge rather than inline text (#4).
  const abilityEntries: { slug: string; label: string; hidden: boolean }[] = [
    { slug: abilities.slot1, label: titleize(abilities.slot1), hidden: false },
  ];
  if (abilities.slot2) {
    abilityEntries.push({
      slug: abilities.slot2,
      label: titleize(abilities.slot2),
      hidden: false,
    });
  }
  if (abilities.hidden) {
    abilityEntries.push({
      slug: abilities.hidden,
      label: titleize(abilities.hidden),
      hidden: true,
    });
  }

  // quad_weak_to / quad_resists are produced by another track (contract B);
  // treat them as optional, defaulting to [] so magnitude rendering (#12) is
  // safe whether or not that track has landed.
  const defensive = matchups as typeof matchups & {
    quad_weak_to?: string[];
    quad_resists?: string[];
  };
  const quadWeakTo = defensive.quad_weak_to ?? [];
  const quadResists = defensive.quad_resists ?? [];

  return (
    <div className="pokemon-artifact" data-testid="pokemon-artifact">
      <div className="pokemon-artifact__head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="pokemon-artifact__art"
          src={data.artwork_url || data.sprite_url}
          alt={data.display_name}
          width={160}
          height={160}
        />
        <div className="pokemon-artifact__id">
          <span className="pokemon-artifact__dex">
            #{data.national_dex_number}
          </span>
          <div className="pokemon-artifact__types">
            {data.types.map((t) => (
              <EntityLink
                key={t}
                kind="type"
                q={t}
                className="entity-link--type"
              >
                <TypeBadge type={t as TypeName} />
              </EntityLink>
            ))}
          </div>
        </div>
      </div>

      <section className="pokemon-artifact__section">
        <h3 className="artifact-section__title">Base stats</h3>
        <ul className="stat-list" data-testid="pokemon-stats">
          {STAT_ROWS.map(({ key, label }) => (
            <li key={key} className="stat-list__row">
              <span className="stat-list__label">{label}</span>
              <span className="stat-list__value">{data.base_stats[key]}</span>
              <span className="stat-list__bar">
                <span
                  className={`stat-list__bar-fill ${statTier(
                    data.base_stats[key],
                  )}`}
                  // eslint-disable-next-line react/forbid-dom-props -- runtime-computed bar width
                  style={{ width: statPct(data.base_stats[key]) }}
                />
              </span>
            </li>
          ))}
          <li className="stat-list__row stat-list__row--total">
            <span className="stat-list__label">Total</span>
            <span className="stat-list__value">{data.base_stat_total}</span>
          </li>
        </ul>
      </section>

      <section className="pokemon-artifact__section">
        <h3 className="artifact-section__title">Abilities</h3>
        <div className="ability-chips" data-testid="pokemon-abilities">
          {abilityEntries.map((a) => (
            <EntityLink
              key={a.slug}
              kind="ability"
              q={a.slug}
              className="entity-link--chip"
            >
              {a.label}
              {a.hidden && (
                <span className="ability-chip__hidden-badge">Hidden</span>
              )}
            </EntityLink>
          ))}
        </div>
      </section>

      <section className="pokemon-artifact__section">
        <h3 className="artifact-section__title">Type matchups</h3>
        <div className="matchup-grid" data-testid="pokemon-matchups">
          <MatchupRow
            label="Weak to"
            types={matchups.weak_to}
            testid="matchups-weak"
            multiplierFor={(t) => (quadWeakTo.includes(t) ? "x4" : "x2")}
          />
          <MatchupRow
            label="Resists"
            types={matchups.resists}
            testid="matchups-resists"
            multiplierFor={(t) => (quadResists.includes(t) ? "x1/4" : "x1/2")}
          />
          <MatchupRow
            label="Immune to"
            types={matchups.immune_to}
            testid="matchups-immune"
            multiplierFor={() => "x0"}
          />
        </div>
      </section>

      <section className="pokemon-artifact__section">
        <h3 className="artifact-section__title">Movepool</h3>
        {data.movepool.length === 0 ? (
          <p className="artifact-empty" data-testid="movepool-empty">
            No moves recorded for this format.
          </p>
        ) : (
          <div className="movepool" data-testid="pokemon-movepool">
            {data.movepool.map((group) => (
              <div
                key={group.method}
                className="movepool__group"
                data-testid={`movepool-group-${group.method}`}
              >
                <h4 className="movepool__method">{group.method}</h4>
                <ul className="movepool__moves">
                  {sortMovesByType(group.moves).map((move) => (
                    <li key={move.slug} className="movepool__move">
                      <EntityLink
                        kind="move"
                        q={move.slug}
                        className="entity-link--move"
                        testid={`movepool-move-${move.slug}`}
                      >
                        {move.display_name}
                        {move.type && (
                          <TypeBadge type={move.type as TypeName} />
                        )}
                      </EntityLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
