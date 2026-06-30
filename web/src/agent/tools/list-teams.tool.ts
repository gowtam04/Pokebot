/**
 * T16 — `list_teams` (the user's saved teams for the turn's format).
 *
 * Returns a cheap pick-list — each saved team's id, name, completeness, and the
 * display names of its Pokémon — so the model can match the user's words ("my
 * rain team", "the one with Garchomp") against names AND contents, then load the
 * chosen team with `get_team`. Scoped to the turn's format (server-controlled,
 * like `mode`, so a Champions team is never offered while standard is active and
 * vice-versa) and to the signed-in account; a guest gets `{ signed_in: false }`.
 *
 * Never throws in-domain: a read fault degrades to an empty team list rather than
 * propagating.
 */

import type { ToolDef } from "@/agent/types";
import type { OakDb } from "@/data/db";
import {
  listTeamsInputSchema,
  toJsonSchema,
  type ListTeamsOutput,
  type TeamListEntry,
} from "@/agent/schemas";
import { formatForMode } from "@/data/formats";
import { listTeams } from "@/data/repos/team-repo";
import { displayNamesFor } from "@/server/teams/active-team";

const description =
  "List the user's saved teams for the current format — each team's id, name, " +
  "how many Pokémon it has, whether it's incomplete, and the names of its " +
  "Pokémon. Takes no arguments. Returns { signed_in: false } for a guest, else " +
  "{ signed_in: true, teams: [...] } (an empty list means they have no saved " +
  "teams). Call this when the user refers to a saved team (\"my team\", \"my " +
  "rain team\", \"this set\"): match their words against the team names AND " +
  "Pokémon, then call get_team with the matching team_id. If nothing matches, " +
  "say so and offer to build one; if two or more plausibly match, ask which.";

export const listTeamsTool: ToolDef = {
  name: "list_teams",
  description,
  inputSchema: toJsonSchema(listTeamsInputSchema),
  async run(_args, ctx): Promise<ListTeamsOutput> {
    // Guests have no saved teams (the route never binds accountId).
    if (!ctx.accountId) return { signed_in: false };
    try {
      const format = formatForMode(ctx.mode);
      const summaries = await listTeams(ctx.accountId, { format });
      // One batched display-name read across every team's species (never throws;
      // falls back to the raw slug for an unknown species).
      const names = await displayNamesFor(
        summaries.flatMap((t) => t.species),
        format,
        ctx.db as unknown as OakDb,
      );
      const teams: TeamListEntry[] = summaries.map((t) => ({
        team_id: t.id,
        name: t.name,
        member_count: t.memberCount,
        incomplete: t.incomplete,
        species: t.species.map((s) => names.get(`pokemon:${s}`) ?? s),
      }));
      return { signed_in: true, teams };
    } catch {
      // A read fault — behave as if the account has no teams rather than 500.
      return { signed_in: true, teams: [] };
    }
  },
};
