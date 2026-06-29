/**
 * TeamList — the left rail of `/teams`: the account's saved teams plus the
 * top-level create / import entry points (TEAM-US-1/2/3/4, AC-4.x).
 *
 * Pure presentational + local confirm state: every mutation is a parent callback
 * (the page wires them to the never-throwing `useTeams` hook). Each row shows the
 * team name, format, member count, and an "incomplete" hint (a partial team is
 * valid — BR-T4); selecting a row opens it in the editor. Duplicate clones the
 * team (AC-4.2). Delete is a two-step confirm in place (AC-4.3) so a stray click
 * can't destroy a team. An empty list renders an explicit empty state.
 *
 * Guests never reach this component (the page shows a sign-in prompt instead),
 * so there is no auth branch here.
 */

"use client";

import { useState } from "react";

import type { TeamSummary } from "@/lib/teams-client";

export interface TeamListProps {
  teams: TeamSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function TeamList({
  teams,
  selectedId,
  onSelect,
  onNew,
  onImport,
  onDuplicate,
  onDelete,
}: TeamListProps) {
  // Id pending delete confirmation (null = none armed).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <div className="team-list" data-testid="team-list">
      <div className="team-list__actions">
        <button type="button" data-testid="team-new" onClick={onNew}>
          New team
        </button>
        <button type="button" data-testid="team-import" onClick={onImport}>
          Import paste
        </button>
      </div>

      {teams.length === 0 ? (
        <p className="team-list__empty" data-testid="team-list-empty">
          No teams yet. Create one or import a Showdown paste to get started.
        </p>
      ) : (
        <ul className="team-list__items" data-testid="team-list-items">
          {teams.map((team) => {
            const selected = team.id === selectedId;
            const confirming = confirmingId === team.id;
            return (
              <li
                key={team.id}
                className="team-list__row"
                data-testid={`team-row-${team.id}`}
                data-selected={selected ? "true" : "false"}
              >
                <button
                  type="button"
                  className="team-list__open"
                  data-testid={`team-open-${team.id}`}
                  onClick={() => onSelect(team.id)}
                >
                  {team.name || "Untitled team"}
                </button>
                <span className="team-list__meta">
                  {team.format} · {team.memberCount}/6
                  {team.incomplete && (
                    <span data-testid={`team-incomplete-${team.id}`}>
                      {" "}
                      · incomplete
                    </span>
                  )}
                </span>

                <div className="team-list__row-actions">
                  <button
                    type="button"
                    data-testid={`team-duplicate-${team.id}`}
                    onClick={() => onDuplicate(team.id)}
                  >
                    Duplicate
                  </button>
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        data-testid={`team-delete-confirm-${team.id}`}
                        onClick={() => {
                          setConfirmingId(null);
                          onDelete(team.id);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        data-testid={`team-delete-cancel-${team.id}`}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`team-delete-${team.id}`}
                      onClick={() => setConfirmingId(team.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
