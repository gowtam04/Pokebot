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
