/**
 * T13 — `save_team` (conversational save; TEAM-AD-7).
 *
 * Persists a team to the user's saved Teams on EXPLICIT user approval, and makes
 * it the conversation's active team. Unlike the other tools, this one WRITES —
 * the single deliberate relaxation of "the agent never writes a team" (BR-T8),
 * gated on a user gesture the prompt describes ("looks good", "save it", "build
 * this team"). It is the analogue of the manual `ProposedTeamCard` save, driven
 * from chat instead of a button.
 *
 * What it saves: the SERVER-BOUND proposed team for the turn (`ctx.proposedTeam`,
 * extracted by the route from the most recent stored `proposed_team`), so the
 * saved EVs/IVs/moves are byte-for-byte what the user saw — the model never
 * re-types the set. `args.team` is only a fallback for build-AND-save in one
 * message (no prior proposal in context).
 *
 * Never throws in-domain (tool-layer contract): a guest, an empty/absent team,
 * or a write fault all fold into a structured `{ saved: false, reason }`.
 */

import type { ToolDef } from "@/agent/types";
import {
  saveTeamInputSchema,
  toJsonSchema,
  type SaveTeamOutput,
} from "@/agent/schemas";
import type { OakDb } from "@/data/db";
import { formatForMode } from "@/data/formats";
import { createTeam } from "@/data/repos/team-repo";
import { setActiveTeam } from "@/data/repos/conversation-repo";
import { validateTeam } from "@/server/teams/validate-team";

const description =
  "Save a team to the user's saved Teams. Call this ONLY when the user EXPLICITLY " +
  "approves a team you proposed earlier in this conversation (e.g. \"looks good\", " +
  "\"save it\", \"build this team\", \"I like this\"), or asks you to build AND " +
  "save one. It saves the exact team you proposed — you do not pass the members. " +
  "Optional args: `name` to rename the saved team; `team` ONLY when building and " +
  "saving in the same message with no prior proposal. Returns { saved: true, " +
  "team_id, name, format } on success, or { saved: false, reason } — reason " +
  "\"not_signed_in\" (ask them to sign in), \"no_team\" (propose a team first), " +
  "\"illegal_team\" (a member is not in this format's roster — tell the user and " +
  "offer to rebuild it legally; `warnings` says which), or \"index_unavailable\". " +
  "On success, tell the user it's saved to their Teams " +
  "page; the app then shows it and opens it in the viewer.";

export const saveTeamTool: ToolDef = {
  name: "save_team",
  description,
  inputSchema: toJsonSchema(saveTeamInputSchema),
  async run(rawArgs, ctx): Promise<SaveTeamOutput> {
    const parsed = saveTeamInputSchema.safeParse(rawArgs ?? {});
    const input = parsed.success ? parsed.data : {};

    // Guests have no account to write to (the route never binds accountId).
    if (!ctx.accountId) return { saved: false, reason: "not_signed_in" };

    // Prefer the server-bound proposal (fidelity); fall back to an explicit team.
    const team = ctx.proposedTeam ?? input.team;
    if (!team || team.members.length === 0) {
      return { saved: false, reason: "no_team" };
    }

    const name = (input.name ?? team.name ?? "").trim() || "Untitled team";

    // Don't persist an unusable team. Roster-validate against the turn's format
    // (server-controlled, like the runtime proposal gate) and refuse an
    // out-of-format species — the same illegality the model is told to rebuild
    // away from. Softer warnings (EV/IV caps, learnset edge cases) are advisory
    // and still allowed through, matching the warn-but-allow Teams API.
    try {
      const warnings = await validateTeam(
        team.members,
        formatForMode(ctx.mode),
        ctx.db as unknown as OakDb,
      );
      const illegal = warnings.filter((w) => w.code === "species_illegal");
      if (illegal.length > 0) {
        return { saved: false, reason: "illegal_team", warnings: illegal };
      }
    } catch {
      // A validation read fault must not block a legitimate save; fall through
      // and let createTeam proceed (validateTeam is advisory, never a hard gate).
    }

    try {
      const saved = await createTeam({
        accountId: ctx.accountId,
        format: team.format,
        name,
        members: team.members,
        now: Date.now(),
      });

      // Make the freshly-saved team the conversation's active team. Best-effort:
      // a brand-new conversation row doesn't exist until appendTurnPair runs
      // (after this turn), so this is a no-op on a first turn — the route also
      // persists the active team via appendTurnPair when ctx.savedTeam is set.
      if (ctx.sessionId) {
        try {
          await setActiveTeam(ctx.accountId, ctx.sessionId, saved.id);
        } catch {
          /* no-op — route persists active team on appendTurnPair */
        }
      }

      // Surface the saved team to the route (mutable result slot), which stamps
      // answer.saved_team authoritatively (no UUID round-trip through the model).
      // `team.format` is the typed enum (the stored Team.format widens to string).
      ctx.savedTeam = { id: saved.id, name: saved.name, format: team.format };

      return {
        saved: true,
        team_id: saved.id,
        name: saved.name,
        format: team.format,
      };
    } catch {
      return { saved: false, reason: "index_unavailable" };
    }
  },
};
