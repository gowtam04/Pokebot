"use client";

import { useEffect, useState } from "react";

import type { ProposedTeamCardProps } from "@/components/types";
import {
  createTeam,
  listTeams,
  updateTeam,
  type TeamSummary,
} from "@/lib/teams-client";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";

/** Human-friendly format label for the header badge. */
function formatLabel(format: string): string {
  if (format === "champions") return "Champions";
  if (format === "scarlet-violet") return "Scarlet/Violet";
  return format;
}

/** Title-case a slug-ish id (`great-tusk` → `Great Tusk`) for display. */
function titleize(value: string | null): string {
  if (!value) return "—";
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type ApplyState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

/**
 * ProposedTeamCard — renders a `proposed_team` (TEAM-AD-6) and the two Apply
 * paths. The agent NEVER writes a team (BR-T8); applying is a normal
 * authenticated Teams API write performed here on the user's click:
 *
 *   • Save as new   → `createTeam({ name, format, members })`
 *   • Apply onto …  → `updateTeam(id, { members })` for a chosen SAME-FORMAT team
 *
 * Both go through the never-throwing teams-client, so a guest / failure folds
 * into an inline message rather than throwing. The apply-existing picker is only
 * shown when the account has at least one same-format team to overwrite.
 */
export default function ProposedTeamCard({ proposedTeam }: ProposedTeamCardProps) {
  const { name, format, members } = proposedTeam;
  const [existing, setExisting] = useState<TeamSummary[]>([]);
  const [targetId, setTargetId] = useState<string>("");
  const [state, setState] = useState<ApplyState>({ kind: "idle" });
  const { openTeam } = useArtifactViewer();

  // Offer apply-existing only for same-format teams the account already owns.
  useEffect(() => {
    let active = true;
    void listTeams({ format }).then((list) => {
      if (active) setExisting(list);
    });
    return () => {
      active = false;
    };
  }, [format]);

  async function handleSaveNew() {
    setState({ kind: "saving" });
    const saved = await createTeam({ name, format, members });
    if (saved) {
      setState({ kind: "saved", message: `Saved as a new team: ${saved.name}.` });
    } else {
      setState({
        kind: "error",
        message: "Couldn't save. Sign in to save teams.",
      });
    }
  }

  async function handleApplyExisting() {
    if (targetId === "") return;
    setState({ kind: "saving" });
    const saved = await updateTeam(targetId, { members });
    if (saved) {
      setState({
        kind: "saved",
        message: `Applied onto “${saved.name}”.`,
      });
    } else {
      setState({
        kind: "error",
        message: "Couldn't apply. The team may no longer exist.",
      });
    }
  }

  const busy = state.kind === "saving";

  return (
    <section className="proposed-team" data-testid="proposed-team">
      <header className="proposed-team__header">
        <span className="proposed-team__name" data-testid="proposed-team-name">
          {name}
        </span>
        <span className="proposed-team__format" data-testid="proposed-team-format">
          {formatLabel(format)}
        </span>
      </header>

      <ol className="proposed-team__members" data-testid="proposed-team-members">
        {members.map((m, i) => (
          <li key={i} className="proposed-team__member">
            <span className="proposed-team__species">{titleize(m.species)}</span>
            {m.item && (
              <span className="proposed-team__item"> @ {titleize(m.item)}</span>
            )}
            {m.ability && (
              <span className="proposed-team__ability"> · {titleize(m.ability)}</span>
            )}
            {m.tera_type && (
              <span className="proposed-team__tera">
                {" "}
                · Tera {titleize(m.tera_type)}
              </span>
            )}
            {m.moves.length > 0 && (
              <span className="proposed-team__moves">
                {" "}
                — {m.moves.map(titleize).join(", ")}
              </span>
            )}
          </li>
        ))}
      </ol>

      <div className="proposed-team__actions">
        <button
          type="button"
          className="proposed-team__open-viewer"
          data-testid="proposed-team-open-viewer"
          onClick={() => openTeam({ team: { name, format, members } })}
        >
          Open in viewer
        </button>

        <button
          type="button"
          className="proposed-team__save-new"
          data-testid="proposed-team-save-new"
          disabled={busy}
          onClick={() => void handleSaveNew()}
        >
          Save as new team
        </button>

        {existing.length > 0 && (
          <div className="proposed-team__apply-existing">
            <select
              className="proposed-team__target"
              data-testid="proposed-team-target"
              aria-label="Apply onto existing team"
              value={targetId}
              disabled={busy}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">Apply onto an existing team…</option>
              {existing.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="proposed-team__apply"
              data-testid="proposed-team-apply-existing"
              disabled={busy || targetId === ""}
              onClick={() => void handleApplyExisting()}
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {(state.kind === "saved" || state.kind === "error") && (
        <p
          className={
            "proposed-team__status" +
            (state.kind === "error" ? " proposed-team__status--error" : "")
          }
          data-testid="proposed-team-status"
          role="status"
        >
          {state.message}
        </p>
      )}
    </section>
  );
}
