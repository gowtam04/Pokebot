/**
 * T12 — `get_team` (load ONE saved team by id).
 *
 * Loads the saved team identified by `team_id` — which the model obtained from a
 * prior `list_teams` call, never invented — account-scoped and format-gated
 * (`resolveActiveTeam`), then returns it enriched with display names + computed
 * validity warnings (`enrichActiveTeam`). An unknown, not-owned, or wrong-format
 * id yields `{ found: false }`, so the model has no way to read a team outside
 * the signed-in account or the turn's format.
 *
 * Never throws in-domain: a guest, a missing id, or any read fault while
 * resolving/enriching degrades to `{ found: false }`.
 */

import type { ToolDef } from "@/agent/types";
import type { OakDb } from "@/data/db";
import {
  getTeamInputSchema,
  toJsonSchema,
  type GetTeamOutput,
} from "@/agent/schemas";
import {
  enrichActiveTeam,
  resolveActiveTeam,
} from "@/server/teams/active-team";

const description =
  "Load one of the user's saved teams by id — its members (species, ability, " +
  "item, moves, nature, EVs/IVs, Tera type, level), their display names, and any " +
  "validity/legality warnings. Pass a `team_id` you got from `list_teams` (you " +
  "cannot guess one). Returns { found: false } if the id isn't one of this " +
  "user's teams in the current format. Use this after list_teams to read the " +
  "team the user is asking about (\"my rain team\", \"this set\") and ground your " +
  "advice in it.";

export const getTeamTool: ToolDef = {
  name: "get_team",
  description,
  inputSchema: toJsonSchema(getTeamInputSchema),
  async run(rawArgs, ctx): Promise<GetTeamOutput> {
    const parsed = getTeamInputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { found: false };
    // Guests have no saved teams to read (the route never binds accountId).
    if (!ctx.accountId) return { found: false };
    try {
      // resolveActiveTeam is account-scoped + format-gated: a missing / foreign /
      // wrong-format id all yield null (BR-T2, BR-T3, AC-8.3).
      const team = await resolveActiveTeam(
        ctx.accountId,
        parsed.data.team_id,
        ctx.mode,
        ctx.db as unknown as OakDb,
      );
      if (!team) return { found: false };
      const enriched = await enrichActiveTeam(team, ctx.db as unknown as OakDb);
      return { found: true, team: enriched };
    } catch {
      // Any in-domain read fault → behave as if the team isn't found.
      return { found: false };
    }
  },
};
