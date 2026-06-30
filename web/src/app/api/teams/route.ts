/**
 * `/api/teams` — list / create saved teams
 * (docs/features/team-builder § API Design; TEAM-US-1, TEAM-US-3, TEAM-US-4,
 * BR-T2, BR-T4).
 *
 *   GET  ?format=<scarlet-violet|champions>  → 200 { teams: TeamSummary[] }
 *   POST  body { name?, format, members? }   → 200 { team, validation }
 *
 * Identity (BR-T2, mirroring the chat-history routes): teams are signed-in only.
 * Guests (`getCurrentAccount() === null`) get **401 `unauthorized`** everywhere;
 * every read/write is scoped to the resolved `account.id`. POST is also the
 * "apply proposed team as new" path (AC-6.3) — partial/empty members allowed
 * (BR-T4), warn-but-allow validation returned alongside the created team.
 *
 * Thin adapter: repos/services and `getCurrentAccount` are reached via DYNAMIC
 * import so `next build` never evaluates `@/env` at page-data collection (the
 * AUTH_SECRET prod guard) — mirrors the auth/chat/conversations routes.
 */

import { json, jsonError, readJsonObject } from "@/app/api/auth/_lib/http";
import { isFormat } from "@/data/formats";
import { teamMembersSchema, type TeamMember } from "@/data/teams/team-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Default name for a brand-new team (AC-1.2). */
const DEFAULT_TEAM_NAME = "Untitled team";
/** Upper bound for a user-supplied team name (auto-defaults are short). */
const MAX_NAME_LEN = 120;

const UNAUTHORIZED = () =>
  jsonError(401, "unauthorized", "You must be signed in.");

async function currentAccount() {
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  return getCurrentAccount();
}

// ---------------------------------------------------------------------------
// GET — list this account's teams (updated_at DESC), optional format filter
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? undefined;
  if (format !== undefined && !isFormat(format)) {
    return jsonError(400, "invalid_request", "Unknown format.");
  }

  const { listTeams } = await import("@/data/repos/team-repo");
  const teams = await listTeams(account.id, format ? { format } : undefined);
  return json(200, { teams });
}

// ---------------------------------------------------------------------------
// POST — create a team (also the "apply proposed team as new" path, AC-6.3)
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();

  const body = await readJsonObject(req);
  if (body === null) {
    return jsonError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (typeof body.format !== "string" || !isFormat(body.format)) {
    return jsonError(400, "invalid_request", "A valid `format` is required.");
  }
  const format = body.format;

  let name = DEFAULT_TEAM_NAME;
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return jsonError(400, "invalid_request", "name must be a string.");
    }
    const trimmed = body.name.trim();
    if (trimmed.length > MAX_NAME_LEN) {
      return jsonError(400, "invalid_name", `name must be ≤${MAX_NAME_LEN} characters.`);
    }
    if (trimmed.length > 0) name = trimmed;
  }

  let members: TeamMember[] = [];
  if (body.members !== undefined) {
    const parsed = teamMembersSchema.safeParse(body.members);
    if (!parsed.success) {
      return jsonError(400, "invalid_members", "members failed validation.");
    }
    members = parsed.data;
  }

  const { db } = await import("@/data/db");
  const { createTeam } = await import("@/data/repos/team-repo");
  const { validateTeam } = await import("@/server/teams/validate-team");

  const team = await createTeam({
    accountId: account.id,
    format,
    name,
    members,
    now: Date.now(),
  });
  const validation = await validateTeam(team.members, format, db);

  return json(200, { team, validation });
}
