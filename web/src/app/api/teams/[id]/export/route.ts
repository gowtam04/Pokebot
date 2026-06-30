/**
 * `GET /api/teams/[id]/export` — render a team as Showdown paste text
 * (docs/features/team-builder § API Design; TEAM-US-11, AC-11.1, AC-11.2, BR-T2).
 *
 *   GET → 200 { paste: string }
 *
 * Round-trips every represented field (cosmetics included). Account-scoped: a
 * missing / not-owned team → **404** (never 403). Guests → **401**. `exportPaste`
 * maps slugs back to display names via the index and never throws on an
 * off-index entry (it falls back to a humanized slug).
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

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();
  const { id } = await ctx.params;

  const { getTeam } = await import("@/data/repos/team-repo");
  const team = await getTeam(account.id, id);
  if (team === null) return NOT_FOUND();

  const { db } = await import("@/data/db");
  const { exportPaste } = await import("@/server/teams/import-export");
  const paste = await exportPaste(team.members, team.format as Format, db);

  return json(200, { paste });
}
