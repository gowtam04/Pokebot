/**
 * TeamArtifact — read-only team view for the artifact viewer (TEAM-AD-7).
 *
 * Renders a team's members (species, item, ability, Tera, moves, nature/level)
 * and any validity warnings. Editing is intentionally NOT here — a saved team
 * links out to the `/teams` editor ("Edit on Teams page"); a proposed team (not
 * yet saved) has no row to edit, so the link is omitted.
 */

"use client";

import type { TeamArtifactView } from "./types";

/** Title-case a slug-ish id (`great-tusk` → `Great Tusk`); `—` for empty. */
function titleize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
            <span className="team-artifact__species">{titleize(m.species)}</span>
            {m.item && (
              <span className="team-artifact__item"> @ {titleize(m.item)}</span>
            )}
            {m.ability && (
              <span className="team-artifact__ability">
                {" "}
                · {titleize(m.ability)}
              </span>
            )}
            {m.tera_type && (
              <span className="team-artifact__tera">
                {" "}
                · Tera {titleize(m.tera_type)}
              </span>
            )}
            {(m.nature || m.level) && (
              <span className="team-artifact__meta">
                {" "}
                · {m.nature ? titleize(m.nature) : "—"} · Lv {m.level}
              </span>
            )}
            {m.moves.length > 0 && (
              <span className="team-artifact__moves">
                {" "}
                — {m.moves.map((mv) => titleize(mv)).join(", ")}
              </span>
            )}
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
