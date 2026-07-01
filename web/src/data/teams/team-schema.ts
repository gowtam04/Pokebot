/**
 * Shared team-member Zod schema — the single source of truth for the `members`
 * payload used EVERYWHERE: the `team.members` JSON column (storage), the Teams
 * API, Showdown import/export, validation, the `/teams` editor frontend, and the
 * agent's `proposed_team` output field (src/agent/schemas.ts).
 *
 * This module imports NOTHING server-only (no @/data/db, no @pkmn, no Drizzle)
 * so it is safe to import from repos, services, API routes, agent schemas, and
 * client components alike — mirroring src/data/formats.ts.
 *
 * Conventions (docs/features/team-builder § Data Model / § TeamMember):
 *   - Slugs (species/ability/item/moves/nature/tera_type) are stored, NOT display
 *     names; `null` means "empty / not set". `moves` may hold fewer than 4 (a
 *     partial team is valid, BR-T4).
 *   - EV/IV stats accept the raw 0..255 range Showdown lets users type; the
 *     warn-but-allow validator (server/teams/validate-team.ts) flags >252 / a
 *     total >508 / IVs outside 0..31 — the schema itself never blocks them.
 *   - `.strict()` rejects unknown keys (every team object is strict, matching the
 *     OakAnswer sub-object convention).
 *   - Cosmetic fields (nickname/gender/shiny) are `.optional()` — preserved on
 *     import/export but not competitively significant (BR-T1).
 */

import { z } from "zod";

/**
 * One EV or IV spread. Raw 0..255 per stat (Showdown permits the full byte
 * range on input); legality (≤252 per EV, ≤508 total, IV 0..31) is a warn-only
 * concern handled by validateTeam, not enforced here.
 */
export const statSpreadSchema = z
  .object({
    hp: z.number().int().min(0).max(255),
    atk: z.number().int().min(0).max(255),
    def: z.number().int().min(0).max(255),
    spa: z.number().int().min(0).max(255),
    spd: z.number().int().min(0).max(255),
    spe: z.number().int().min(0).max(255),
  })
  .strict();

export type StatSpread = z.infer<typeof statSpreadSchema>;

/** One team member (set). Slugs; `null` = empty/not set. */
export const teamMemberSchema = z
  .object({
    /** Pokémon slug; null = empty slot (BR-T4). */
    species: z.string().nullable(),
    /** Ability slug; null = not set. */
    ability: z.string().nullable(),
    /** Held-item slug; null = none. */
    item: z.string().nullable(),
    /** Move slugs; may hold fewer than 4 (partial team ok). */
    moves: z.array(z.string()).max(4),
    /** One of the 25 nature slugs; null = not set. */
    nature: z.string().nullable(),
    /** EV spread (0..255 raw per stat). */
    evs: statSpreadSchema,
    /** IV spread (0..31 expected; warn if not). */
    ivs: statSpreadSchema,
    /** One of the 18 type slugs; null = not set. */
    tera_type: z.string().nullable(),
    /** Level (default 50 in both formats). */
    level: z.number().int().min(1).max(100),
    // Cosmetic — round-tripped on import/export, not competitively significant.
    nickname: z.string().nullable().optional(),
    gender: z.enum(["M", "F", "N"]).nullable().optional(),
    shiny: z.boolean().optional(),
  })
  .strict();

export type TeamMember = z.infer<typeof teamMemberSchema>;

/** A whole team's members — 0..6 (an empty/partial team is valid). */
export const teamMembersSchema = z.array(teamMemberSchema).max(6);

export type TeamMembers = z.infer<typeof teamMembersSchema>;

// ---------------------------------------------------------------------------
// Team warnings — the advisory validity/legality results produced by
// validateTeam (src/server/teams/validate-team.ts). Defined HERE, in the
// client-safe schema home, so they can be shared by storage, the Teams API,
// the agent's `proposed_team_warnings` answer field, and the frontend without
// any of them pulling the server-only validate-team service into a client
// bundle. validate-team.ts derives its WarningCode/TeamWarning from these
// (single source of truth).
// ---------------------------------------------------------------------------

/** The validity/legality rules validateTeam can flag (BR-T5). */
export const warningCodeSchema = z.enum([
  "incomplete", // informational (BR-T4)
  "ev_total_exceeded", // sum(evs) > 508
  "ev_stat_exceeded", // an EV > 252
  "iv_out_of_range", // an IV outside 0..31
  "species_illegal", // species not in the format roster
  "ability_not_for_species", // ability not one of the species' legal abilities
  "item_illegal", // item not legal in the format
  "item_missing", // battle-ready member (4 moves) with no held item
  "move_not_in_learnset", // move not in the species' learnset for the format
  "duplicate_species", // species clause
  "duplicate_item", // item clause
]);

export type WarningCode = z.infer<typeof warningCodeSchema>;

/** One advisory team warning. `slot` absent ⇒ team-level (e.g. clauses). */
export const teamWarningSchema = z
  .object({
    code: warningCodeSchema,
    message: z.string(),
    /** 0..5; absent ⇒ team-level. */
    slot: z.number().int().optional(),
    /** e.g. "evs.atk", "moves[2]", "ability". */
    field: z.string().optional(),
  })
  .strict();

export type TeamWarning = z.infer<typeof teamWarningSchema>;

/**
 * Codes that make a team HARD-ILLEGAL in the format — a proposal carrying any
 * of these is rejected and sent back for the model to rebuild (runtime.ts), and
 * a save carrying any of them is refused (save-team.tool.ts). Single source of
 * truth for both gates.
 *
 * `item_missing` is deliberately NOT here: a member with no held item is still
 * a legal team (running item-less is allowed, just weak), so it must never
 * block a SAVE — e.g. a team imported from a screenshot with an obscured item.
 * It's a PROPOSAL-completeness rule instead, enforced only by the runtime gate
 * (and only for built teams, not image imports). Everything else (`incomplete`,
 * the EV/IV over-cap warnings) is soft/advisory: a badge that never blocks.
 */
export const HARD_VIOLATION_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>(
  [
    "species_illegal",
    "ability_not_for_species",
    "item_illegal",
    "move_not_in_learnset",
    "duplicate_species",
    "duplicate_item",
  ],
);

/** True when a warning is a hard format-illegality (see `HARD_VIOLATION_CODES`). */
export function isHardViolation(warning: TeamWarning): boolean {
  return HARD_VIOLATION_CODES.has(warning.code);
}
