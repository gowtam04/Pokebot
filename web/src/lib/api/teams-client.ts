/**
 * teams-client — typed `fetch` helpers over the `/api/teams/*` routes
 * (docs/features/team-builder § teams-client, Phase 8).
 *
 * The ONLY thing the Teams UI / page talk to for team data. Mirrors
 * history-client.ts / auth-client.ts: helpers NEVER throw — an HTTP error
 * (guest 401, other-account 404, validation/transport fault) folds into a safe
 * value (`[]` / `null` / `false`) so the UI always has something to render.
 * The httpOnly session cookie is sent automatically on these same-origin
 * requests (`credentials: "same-origin"`).
 *
 * The routes return the full {@link import("@/data/repos/team-repo").Team} as
 * `body.team` plus a sibling `body.validation` (and, for import, `body.notes`);
 * this client folds `{ team, validation }` into the flat {@link TeamDetail} the
 * editor renders. Only `TeamMember` is imported as a value-shaped type from the
 * pure shared schema; `TeamWarning` / `ImportNote` are pulled type-only (fully
 * erased — no server-only / db / `@pkmn` runtime code is dragged in).
 */

import type { TeamMember } from "@/data/teams/team-schema";
import type { TeamWarning } from "@/server/teams/validate-team";
import type { ImportNote } from "@/server/teams/import-export";

export type { TeamWarning, ImportNote };

/** List-view summary (no members; counts only — BR-T2). */
export interface TeamSummary {
  id: string;
  name: string;
  format: string;
  memberCount: number;
  incomplete: boolean;
  updatedAt: number;
}

/** Full team for the editor: the stored shape + on-demand validity warnings. */
export interface TeamDetail {
  id: string;
  name: string;
  format: string;
  members: TeamMember[];
  validation: TeamWarning[];
}

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** Best-effort parse of a JSON body; a non-JSON/empty body yields `{}`. */
async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json();
    if (data !== null && typeof data === "object") {
      return data as Record<string, unknown>;
    }
  } catch {
    /* non-JSON or empty body */
  }
  return {};
}

/**
 * Fold a `{ team, validation }` route body into a flat {@link TeamDetail}, or
 * `null` if the body is not a well-formed team payload.
 */
function toDetail(body: Record<string, unknown>): TeamDetail | null {
  const team = body.team;
  if (team === null || typeof team !== "object") return null;
  const t = team as Record<string, unknown>;
  if (typeof t.id !== "string") return null;
  return {
    id: t.id,
    name: typeof t.name === "string" ? t.name : "",
    format: typeof t.format === "string" ? t.format : "",
    members: Array.isArray(t.members) ? (t.members as TeamMember[]) : [],
    validation: Array.isArray(body.validation)
      ? (body.validation as TeamWarning[])
      : [],
  };
}

/**
 * `GET /api/teams?format=…` — the signed-in account's team summaries. A guest
 * (401), or any failure, yields `[]`.
 */
export async function listTeams(opts?: {
  format?: string;
}): Promise<TeamSummary[]> {
  try {
    const params = new URLSearchParams();
    if (opts?.format) params.set("format", opts.format);
    const qs = params.toString();
    const res = await fetch(`/api/teams${qs ? `?${qs}` : ""}`, {
      method: "GET",
      credentials: "same-origin",
    });
    const body = await readJsonBody(res);
    return Array.isArray(body.teams) ? (body.teams as TeamSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * `GET /api/teams/[id]` — the full team + validation, or `null` if missing /
 * not owned (404) / a transport fault.
 */
export async function getTeam(id: string): Promise<TeamDetail | null> {
  try {
    const res = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return toDetail(await readJsonBody(res));
  } catch {
    return null;
  }
}

/**
 * `POST /api/teams` — create (also "apply as new"). Returns the saved team +
 * validation, or `null` on guest/failure.
 */
export async function createTeam(input: {
  name?: string;
  format: string;
  members?: TeamMember[];
}): Promise<TeamDetail | null> {
  try {
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return toDetail(await readJsonBody(res));
  } catch {
    return null;
  }
}

/**
 * `PUT /api/teams/[id]` — update name and/or members (also "apply onto
 * existing"). Returns the saved team + validation, or `null` if not owned /
 * failure.
 */
export async function updateTeam(
  id: string,
  input: { name?: string; members?: TeamMember[] },
): Promise<TeamDetail | null> {
  try {
    const res = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return toDetail(await readJsonBody(res));
  } catch {
    return null;
  }
}

/**
 * `DELETE /api/teams/[id]` — permanent (BR-T10). A 404 (already gone / not
 * owned) counts as success for an idempotent delete UX.
 */
export async function deleteTeam(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * `POST /api/teams/[id]/duplicate` — clone an owned team (AC-4.2). Returns the
 * new team + validation, or `null` if not owned / failure.
 */
export async function duplicateTeam(id: string): Promise<TeamDetail | null> {
  try {
    const res = await fetch(
      `/api/teams/${encodeURIComponent(id)}/duplicate`,
      {
        method: "POST",
        credentials: "same-origin",
      },
    );
    if (!res.ok) return null;
    return toDetail(await readJsonBody(res));
  } catch {
    return null;
  }
}

/**
 * `POST /api/teams/import` — Showdown paste → a saved team (TEAM-US-10). Returns
 * the team + validation and the resolve-or-clarify {@link ImportNote}s, or
 * `null` on guest/failure.
 */
export async function importPaste(
  format: string,
  paste: string,
): Promise<{ team: TeamDetail; notes: ImportNote[] } | null> {
  try {
    const res = await fetch("/api/teams/import", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ format, paste }),
    });
    if (!res.ok) return null;
    const body = await readJsonBody(res);
    const team = toDetail(body);
    if (!team) return null;
    return {
      team,
      notes: Array.isArray(body.notes) ? (body.notes as ImportNote[]) : [],
    };
  } catch {
    return null;
  }
}

/**
 * `GET /api/teams/[id]/export` — the team as a Showdown paste (TEAM-US-11), or
 * `null` if not owned / failure.
 */
export async function exportPaste(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/teams/${encodeURIComponent(id)}/export`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const body = await readJsonBody(res);
    return typeof body.paste === "string" ? body.paste : null;
  } catch {
    return null;
  }
}
