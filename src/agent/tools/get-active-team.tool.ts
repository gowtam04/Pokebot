/**
 * T12 — `get_active_team` (inlined team-builder internal; reconciled into
 * docs/agent-design in Phase 11, TEAM-AD-3).
 *
 * Returns the turn's CONTEXT-BOUND active team (`ctx.activeTeam`) enriched with
 * display names + computed validity warnings, or `{ active: false }` when none
 * is bound. It takes NO team-selecting argument: the active team is
 * server-controlled (resolved + authorized by the route, then bound onto
 * `AgentContext` — the exact analogue of `mode`), so the model has no parameter
 * to widen scope (TEAM-AD-1, BR-T9). The model calls it only when the user's
 * question is about their team (prompt-guided); it is never forced.
 *
 * Never throws in-domain: an absent active team OR any read fault while
 * enriching degrades to `{ active: false }`.
 */

import type { ToolDef } from "@/agent/types";
import type { PokebotDb } from "@/data/db";
import {
  getActiveTeamInputSchema,
  toJsonSchema,
  type GetActiveTeamOutput,
} from "@/agent/schemas";
import { enrichActiveTeam } from "@/server/teams/active-team";

const description =
  "Get the user's currently-selected (active) team for this conversation — its " +
  "members (species, ability, item, moves, nature, EVs/IVs, Tera type, level), " +
  "their display names, and any validity/legality warnings. Takes no arguments: " +
  "the active team is whatever the user has selected (you cannot pick or change " +
  "it). Returns { active: false } when no team is selected. Call this when the " +
  "user asks about \"my team\", a specific member, or wants advice grounded in " +
  "the team they're building.";

export const getActiveTeamTool: ToolDef = {
  name: "get_active_team",
  description,
  inputSchema: toJsonSchema(getActiveTeamInputSchema),
  async run(_args, ctx): Promise<GetActiveTeamOutput> {
    if (!ctx.activeTeam) return { active: false };
    try {
      const team = await enrichActiveTeam(
        ctx.activeTeam,
        ctx.db as unknown as PokebotDb,
      );
      return { active: true, team };
    } catch {
      // Any in-domain read fault → behave as if no team is bound.
      return { active: false };
    }
  },
};
