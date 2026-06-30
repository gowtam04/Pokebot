/**
 * `/api/teams/[id]` — read / replace / delete one saved team
 * (docs/features/team-builder § API Design; TEAM-US-2, TEAM-US-4, TEAM-US-5,
 * BR-T2, BR-T10, AC-4.3, AC-5.4, AC-6.3, AC-7.1).
 *
 *   GET    → 200 { team, validation }     full members + computed warnings
 *   PUT    → 200 { team, validation }      body { name?, members? } (replace)
 *   DELETE → 200 { ok: true }              permanent, transactional (BR-T10)
 *
 * Isolation (BR-T2): a team owned by another account is indistinguishable from a
 * missing one — all three return **404**, never 403. Guests get **401**. PUT is
 * also the "apply proposed team onto an existing team" path (AC-6.3, AC-7.1);
 * validation is warn-but-allow. DELETE is idempotent (an absent id → 404, which
 * the client treats as success).
 */

import { json, jsonError, readJsonObject } from "@/app/api/auth/_lib/http";
import { teamMembersSchema, type TeamMember } from "@/data/teams/team-schema";
import type { Format } from "@/data/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME_LEN = 120;

type Ctx = { params: Promise<{ id: string }> };

const UNAUTHORIZED = () =>
  jsonError(401, "unauthorized", "You must be signed in.");
const NOT_FOUND = () => jsonError(404, "not_found", "Team not found.");

async function currentAccount() {
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  return getCurrentAccount();
}

// ---------------------------------------------------------------------------
// GET — full team + computed warnings (the editor view, AC-5.4)
// ---------------------------------------------------------------------------

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();
  const { id } = await ctx.params;

  const { getTeam } = await import("@/data/repos/team-repo");
  const team = await getTeam(account.id, id);
  if (team === null) return NOT_FOUND();

  const { db } = await import("@/data/db");
  const { validateTeam } = await import("@/server/teams/validate-team");
  const validation = await validateTeam(team.members, team.format as Format, db);

  return json(200, { team, validation });
}

// ---------------------------------------------------------------------------
// PUT — replace name and/or members (warn-but-allow)
// ---------------------------------------------------------------------------

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();
  const { id } = await ctx.params;

  const body = await readJsonObject(req);
  if (body === null) {
    return jsonError(400, "invalid_request", "Request body must be a JSON object.");
  }

  const hasName = body.name !== undefined;
  const hasMembers = body.members !== undefined;
  if (!hasName && !hasMembers) {
    return jsonError(400, "invalid_request", "Provide at least one of { name, members }.");
  }

  let name: string | undefined;
  if (hasName) {
    if (typeof body.name !== "string") {
      return jsonError(400, "invalid_request", "name must be a string.");
    }
    name = body.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LEN) {
      return jsonError(400, "invalid_name", `name must be 1–${MAX_NAME_LEN} characters.`);
    }
  }

  let members: TeamMember[] | undefined;
  if (hasMembers) {
    const parsed = teamMembersSchema.safeParse(body.members);
    if (!parsed.success) {
      return jsonError(400, "invalid_members", "members failed validation.");
    }
    members = parsed.data;
  }

  const { updateTeam } = await import("@/data/repos/team-repo");
  const team = await updateTeam({
    accountId: account.id,
    id,
    name,
    members,
    now: Date.now(),
  });
  if (team === null) return NOT_FOUND();

  const { db } = await import("@/data/db");
  const { validateTeam } = await import("@/server/teams/validate-team");
  const validation = await validateTeam(team.members, team.format as Format, db);

  return json(200, { team, validation });
}

// ---------------------------------------------------------------------------
// DELETE — permanent + null active_team_id references (BR-T10)
// ---------------------------------------------------------------------------

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();
  const { id } = await ctx.params;

  const { getTeam, deleteTeam } = await import("@/data/repos/team-repo");
  // Ownership check up front so another account's id (or an already-gone team)
  // returns 404 (isolation, AC-4.3) rather than a silent no-op posing as success.
  const team = await getTeam(account.id, id);
  if (team === null) return NOT_FOUND();

  await deleteTeam(account.id, id);
  return json(200, { ok: true });
}
