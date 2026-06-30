/**
 * SavedTeamCard — the persistent "Saved ✓" affordance (TEAM-AD-7).
 *
 * Rendered when an answer carries `saved_team` (stamped by the route after the
 * agent's `save_team` call). Because `saved_team` lives in the persisted
 * `answer_json`, this card re-renders when the conversation reloads, and its
 * "Open in viewer" button re-opens the saved team — fetched fresh by id — in the
 * artifact viewer even after navigating away.
 */

"use client";

import type { SavedTeamCardProps } from "@/components/types";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";

/** Human-friendly format label for the header badge. */
function formatLabel(format: string): string {
  if (format === "champions") return "Champions";
  if (format === "scarlet-violet") return "Scarlet/Violet";
  return format;
}

export default function SavedTeamCard({
  savedTeam,
}: SavedTeamCardProps): React.JSX.Element {
  const { id, name, format } = savedTeam;
  const { openTeam } = useArtifactViewer();

  return (
    <section className="saved-team" data-testid="saved-team">
      <div className="saved-team__row">
        <span className="saved-team__check" aria-hidden>
          ✓
        </span>
        <span className="saved-team__label" data-testid="saved-team-label">
          Saved to your Teams:{" "}
          <span className="saved-team__name">{name}</span>
        </span>
        <span className="saved-team__format" data-testid="saved-team-format">
          {formatLabel(format)}
        </span>
      </div>

      <div className="saved-team__actions">
        <button
          type="button"
          className="saved-team__open-viewer"
          data-testid="saved-team-open-viewer"
          onClick={() => openTeam({ teamId: id, name })}
        >
          Open in viewer
        </button>
        <a className="saved-team__teams-link" href="/teams">
          View all teams
        </a>
      </div>
    </section>
  );
}
