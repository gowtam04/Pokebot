/**
 * `POST /api/teams/[id]/duplicate` — clone a team into a new, independent copy
 * (docs/features/team-builder § API Design; TEAM-US-4, AC-4.2, BR-T2).
 *
 *   POST → 200 { team, validation }
 *
 * Clones the source members into a fresh team named `"<name> copy"`; the copy is
 * fully independent thereafter. Account-scoped: a missing / not-owned source →
 * **404** (never 403). Guests → **401**.
 */

import { json, jsonError } from "@/app/api/auth/_lib/http";
import type { Format } from "@/data/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const UNAUTHORIZED = () =>
  jsonError(401, "unauthorized", "You must be signed in.");
const NOT_FOUND = () => jsonError(404, "not_found", "Team not found.");

async function currentAccount() {
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  return getCurrentAccount();
}

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();
  const { id } = await ctx.params;

  const { duplicateTeam } = await import("@/data/repos/team-repo");
  const team = await duplicateTeam(account.id, id, Date.now());
  if (team === null) return NOT_FOUND();

  const { db } = await import("@/data/db");
  const { validateTeam } = await import("@/server/teams/validate-team");
  const validation = await validateTeam(team.members, team.format as Format, db);

  return json(200, { team, validation });
}
