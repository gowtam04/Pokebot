/**
 * TeamArtifact — detailed, read-only team view for the artifact viewer (TEAM-AD-7).
 *
 * Renders each member as a card: sprite + types, name/dex, level, held item,
 * ability, nature, Tera type, the computed final stats (with EV/Stat-Point
 * investment and nature +/- shading), and its moves. Plus any validity warnings.
 *
 * Sprites / types / base stats are resolved async (`view.spriteRefs`, keyed by
 * species slug); until they arrive — or for an unknown species — the card still
 * renders the slug-only data (name, item, ability, nature, Tera, moves) and just
 * omits the sprite, type badges, and computed stats.
 *
 * Editing is intentionally NOT here — a saved team links out to the `/teams`
 * editor ("Edit on Teams page"); a proposed team (not yet saved) has no row to
 * edit, so the link is omitted.
 */

"use client";

import type { TeamArtifactView } from "./types";
import type { TeamMember } from "@/data/teams/team-schema";
import type { SpriteRef } from "@/data/repos/pokedex-repo";
import type { TypeName } from "@/agent/schemas";
import TypeBadge from "@/components/TypeBadge";
import { computeMemberStats, STAT_LABELS } from "./team-stats";

/** Title-case a slug-ish id (`great-tusk` → `Great Tusk`); `—` for empty. */
function titleize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Denominator for the stat-bar width (Lv50 final stats rarely exceed this). */
const STAT_BAR_MAX = 220;

/** Inline `--x` custom properties (React's CSSProperties rejects them by type). */
type CssVars = React.CSSProperties & Record<`--${string}`, string>;

/** A single Pokémon's card. */
function MemberCard({
  member,
  refs,
  format,
}: {
  member: TeamMember;
  refs: SpriteRef | undefined;
  format: string;
}): React.JSX.Element {
  if (!member.species) {
    return (
      <div className="team-member team-member--empty">
        <span className="team-member__empty">Empty slot</span>
      </div>
    );
  }

  const types = (refs?.types ?? []) as TypeName[];
  const primaryType = types[0] ?? "normal";
  const isChampions = format === "champions";
  const evMax = isChampions ? 32 : 252;
  const stats = refs ? computeMemberStats(member, refs.base_stats, format) : null;
  // Prefer the canonical display name (e.g. "Swampert (Mega)") over a titleized
  // slug, so Mega / forme members are unambiguous.
  const displayName = refs?.display_name ?? titleize(member.species);

  const cardStyle: CssVars = { "--member-type": `var(--type-${primaryType})` };

  return (
    // eslint-disable-next-line react/forbid-dom-props -- dynamic --member-type CSS var bound per species
    <div className="team-member" style={cardStyle}>
      <div className="team-member__head">
        <span className="team-member__sprite-chip">
          {refs?.sprite_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="team-member__sprite"
              src={refs.sprite_url}
              alt={displayName}
              width={72}
              height={72}
            />
          ) : (
            <span className="team-member__sprite-fallback" aria-hidden>
              ?
            </span>
          )}
        </span>

        <div className="team-member__ident">
          <div className="team-member__name-row">
            <span className="team-member__name">{displayName}</span>
            {refs?.dex_number != null && (
              <span className="team-member__dex">#{refs.dex_number}</span>
            )}
            <span className="team-member__level">Lv {member.level}</span>
          </div>

          <div className="team-member__badges">
            {types.map((t) => (
              <TypeBadge key={t} type={t} />
            ))}
            {member.tera_type && (
              <span
                className="team-member__tera"
                // eslint-disable-next-line react/forbid-dom-props -- dynamic --tera-type CSS var
                style={
                  { "--tera-type": `var(--type-${member.tera_type})` } as CssVars
                }
                title={`Tera ${titleize(member.tera_type)}`}
              >
                <span className="team-member__tera-glyph" aria-hidden>
                  ◆
                </span>
                Tera {titleize(member.tera_type)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="team-member__meta">
        {member.item && (
          <span className="team-member__item">@ {titleize(member.item)}</span>
        )}
        {member.ability && (
          <span className="team-member__ability">{titleize(member.ability)}</span>
        )}
        {member.nature && (
          <span className="team-member__nature">
            {titleize(member.nature)} Nature
          </span>
        )}
      </div>

      {stats && (
        <ul className="team-member__stats" data-testid="team-member-stats">
          {stats.map((s) => {
            const value = s.value ?? 0;
            const width = Math.max(
              2,
              Math.min(100, Math.round((value / STAT_BAR_MAX) * 100)),
            );
            const inv = Math.min(evMax, s.ev);
            return (
              <li
                key={s.key}
                className={`team-stat team-stat--${s.nature}`}
              >
                <span className="team-stat__label">
                  {STAT_LABELS[s.key]}
                  {s.nature === "boosted" && (
                    <span className="team-stat__arrow" aria-hidden>
                      ▲
                    </span>
                  )}
                  {s.nature === "hindered" && (
                    <span className="team-stat__arrow" aria-hidden>
                      ▼
                    </span>
                  )}
                </span>
                <span className="team-stat__value">{s.value ?? "—"}</span>
                <span className="team-stat__bar">
                  <span
                    className="team-stat__bar-fill"
                    // eslint-disable-next-line react/forbid-dom-props -- runtime-computed bar width
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="team-stat__ev">
                  {inv > 0 ? `${inv}${isChampions ? " SP" : ""}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {member.moves.length > 0 ? (
        <ul className="team-member__moves">
          {member.moves.map((mv, i) => (
            <li key={i} className="team-member__move">
              {titleize(mv)}
            </li>
          ))}
        </ul>
      ) : (
        <span className="team-member__no-moves">No moves set</span>
      )}
    </div>
  );
}

export default function TeamArtifact({
  view,
}: {
  view: TeamArtifactView;
}): React.JSX.Element {
  const detail = view.detail;

  if (!detail || detail.members.length === 0) {
    return (
      <div className="team-artifact__empty" data-testid="team-artifact-empty">
        This team has no members yet.
      </div>
    );
  }

  const showEdit = view.source === "saved" && detail.id !== "";

  return (
    <section className="team-artifact" data-testid="team-artifact">
      <ol className="team-artifact__members" data-testid="team-artifact-members">
        {detail.members.map((m, i) => (
          <li key={i} className="team-artifact__member">
            <MemberCard
              member={m}
              refs={m.species ? view.spriteRefs?.[m.species] : undefined}
              format={detail.format}
            />
          </li>
        ))}
      </ol>

      {detail.validation.length > 0 && (
        <ul
          className="team-artifact__warnings"
          data-testid="team-artifact-warnings"
        >
          {detail.validation.map((w, i) => (
            <li key={i} className="team-artifact__warning">
              {w.message}
            </li>
          ))}
        </ul>
      )}

      {showEdit && (
        <a
          className="team-artifact__edit"
          data-testid="team-artifact-edit"
          href="/teams"
        >
          Edit on Teams page
        </a>
      )}
    </section>
  );
}
