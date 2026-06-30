"use client";

import { useEffect, useState } from "react";

import type { ActiveTeamSelectorProps } from "@/components/types";
import { listTeams, type TeamSummary } from "@/lib/api/teams-client";

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/**
 * ActiveTeamSelector — the chat-shell control that binds an active team to the
 * conversation (TEAM-US-8 / AC-8.1). It lists the signed-in account's teams for
 * the CURRENT format only (`listTeams({ format })`), defaults to "no active
 * team", and on select:
 *
 *   1. lifts the choice via `onChange` so the host holds it and sends it as
 *      `active_team_id` on the next chat turn (which persists it last-selected-
 *      wins, AC-8.2), and
 *   2. best-effort PATCHes the conversation row directly so a selection made
 *      WITHOUT chatting sticks (BR-T9 / AC-8.2). A 404 for a not-yet-created
 *      conversation is harmless — the next turn writes it via the chat body.
 *
 * Guests (`enabled === false`) get no list and no selector (BR-T2). The host
 * clears the selection on a format toggle / different-format conversation
 * (AC-8.3), so this component never needs to police format itself — it simply
 * re-lists whenever `format` changes.
 */
export default function ActiveTeamSelector({
  format,
  conversationId,
  value,
  onChange,
  enabled,
}: ActiveTeamSelectorProps) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);

  // Re-list whenever the account becomes enabled or the active format changes.
  // Scope is strictly the CURRENT format (AC-8.1) — a Champions-format team is
  // never offered while standard is active, and vice-versa.
  useEffect(() => {
    if (!enabled) {
      setTeams([]);
      return;
    }
    let active = true;
    void listTeams({ format }).then((list) => {
      if (active) setTeams(list);
    });
    return () => {
      active = false;
    };
  }, [enabled, format]);

  if (!enabled) return null;

  function handleSelect(next: string | null) {
    // Lift first so the host always holds the choice (the next chat turn carries
    // it even for a not-yet-created conversation).
    onChange(next);
    // Then persist onto the conversation row without chatting. Never throws — a
    // 404 (no row yet) or any fault is silently ignored.
    void fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ active_team_id: next }),
    }).catch(() => {
      /* best-effort — the next chat turn persists the selection */
    });
  }

  return (
    <label className="active-team-selector" data-testid="active-team-selector">
      <span className="active-team-selector__label">Active team</span>
      <select
        className="active-team-selector__select"
        data-testid="active-team-select"
        aria-label="Active team"
        value={value ?? ""}
        onChange={(e) => handleSelect(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">No active team</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.incomplete ? " (incomplete)" : ""}
          </option>
        ))}
      </select>
      {/* Caret — appearance:none strips the native arrow, so draw a shared
          pill-caret one (inherits the white pill text color). */}
      <span aria-hidden="true" className="pill-caret" />
    </label>
  );
}
