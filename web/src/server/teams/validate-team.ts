/**
 * validate-team — advisory team validity/legality checks (BR-T5, BR-T6).
 *
 * `validateTeam(members, format, db)` evaluates a team's members and returns a
 * flat `TeamWarning[]` describing every rule that fired. It is **advisory only**:
 * it NEVER throws and NEVER blocks (BR-T6) — a clean team returns `[]`, and a
 * genuine DB/index fault degrades to "skip that check" rather than propagating
 * (the route/HTTP seam owns transport errors; this service does not).
 *
 * It is a SERVICE (under `src/server/teams/`), not a repo: it composes the
 * existing index reads — `pokedex-repo.getPokemon` (species legality + the
 * species' legal ability slots), `learnset-repo.movesForPokemon` (move legality
 * for the active format), and the `searchable_names` master list (held-item
 * legality) — plus pure EV/IV/clause math. `@/data/schema` is import-safe (only
 * `@/data/db` is `server-only`); `OakDb` is imported type-only.
 *
 * Checks (BR-T5), in stable per-slot then team-level order:
 *   - incomplete            — species unset OR < 4 moves (informational, BR-T4).
 *   - ev_total_exceeded     — sum(EVs) > 508.
 *   - ev_stat_exceeded      — any single EV > 252 (one warning per stat).
 *   - iv_out_of_range       — any IV outside 0..31 (one warning per stat).
 *   - species_illegal       — species not in the format roster.
 *   - ability_not_for_species — ability not one of the species' legal abilities.
 *   - move_not_in_learnset  — a move not learnable by the species in the format.
 *   - item_illegal          — held item not legal in the format.
 *   - duplicate_species     — species clause (team-level).
 *   - duplicate_item        — item clause (team-level).
 */

import { and, eq } from "drizzle-orm";

import type { OakDb } from "@/data/db";
import type { Format } from "@/data/formats";
import type { StatSpread, TeamMember } from "@/data/teams/team-schema";
import { searchable_names } from "@/data/schema";
import { getPokemon } from "@/data/repos/pokedex-repo";
import { movesForPokemon } from "@/data/repos/learnset-repo";

// The warning shape is defined in the client-safe team-schema (single source of
// truth) so it can be shared with the agent answer schema + frontend without
// pulling this server-only service into a client bundle. Re-exported here for
// back-compat with existing `@/server/teams/validate-team` importers.
export type { WarningCode, TeamWarning } from "@/data/teams/team-schema";
import type { TeamWarning } from "@/data/teams/team-schema";

/**
 * Legal EV / stat-point ceilings per format. Scarlet/Violet uses classic EVs
 * (508 total, 252 per stat); Champions uses the much tighter Stat-Point budget
 * (66 total, 32 per stat) — mirrors `evBudgetFor` in the team-builder UI.
 */
function evCaps(format: Format): { total: number; perStat: number } {
  return format === "champions"
    ? { total: 66, perStat: 32 }
    : { total: 508, perStat: 252 };
}
/** Legal IV range. */
const IV_MIN = 0;
const IV_MAX = 31;

/** The six stat keys, in canonical order (matches StatSpread). */
const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

function statSum(spread: StatSpread): number {
  return STAT_KEYS.reduce((total, key) => total + spread[key], 0);
}

/**
 * Validate a team's members against the active `format`. Never throws; returns
 * `[]` when clean. Per-slot warnings come first (slot order), then team-level
 * clauses.
 */
export async function validateTeam(
  members: TeamMember[],
  format: Format,
  db: OakDb,
): Promise<TeamWarning[]> {
  const warnings: TeamWarning[] = [];
  const { total: EV_TOTAL_MAX, perStat: EV_STAT_MAX } = evCaps(format);

  // ---- Master lists / per-species index reads (gathered once) ----

  // Held-item legality: the format's item master list. A read fault leaves the
  // set null → item legality is simply skipped (never a false warning).
  let legalItems: Set<string> | null = null;
  try {
    const rows = await db
      .select({ slug: searchable_names.slug })
      .from(searchable_names)
      .where(
        and(
          eq(searchable_names.format, format),
          eq(searchable_names.kind, "item"),
        ),
      );
    legalItems = new Set(rows.map((r) => r.slug));
  } catch {
    legalItems = null;
  }

  // Resolve each distinct species' profile once (legality + legal abilities),
  // and — for legal species — its learnset for move legality. A null learnset
  // entry means "couldn't read" → skip move checks for that species.
  const species = new Set(
    members
      .map((m) => m.species)
      .filter((s): s is string => s !== null && s.length > 0),
  );
  const profiles = new Map<
    string,
    Awaited<ReturnType<typeof getPokemon>>
  >();
  const learnsets = new Map<string, Set<string> | null>();
  for (const slug of species) {
    const profile = await getPokemon(slug, format, db);
    profiles.set(slug, profile);
    if (profile.found) {
      try {
        const moves = await movesForPokemon(slug, format, db);
        learnsets.set(slug, new Set(moves.map((m) => m.moveSlug)));
      } catch {
        learnsets.set(slug, null);
      }
    }
  }

  // ---- Per-slot checks ----

  members.forEach((member, slot) => {
    // incomplete (informational) — empty species or fewer than 4 moves.
    if (!member.species || member.moves.length < 4) {
      warnings.push({
        code: "incomplete",
        slot,
        message: !member.species
          ? "Slot has no species selected."
          : `Slot has only ${member.moves.length} of 4 moves.`,
      });
    }

    // EV total.
    const evTotal = statSum(member.evs);
    if (evTotal > EV_TOTAL_MAX) {
      warnings.push({
        code: "ev_total_exceeded",
        slot,
        field: "evs",
        message: `EV total is ${evTotal}, exceeding the maximum of ${EV_TOTAL_MAX}.`,
      });
    }

    // EV per-stat ceiling.
    for (const key of STAT_KEYS) {
      const ev = member.evs[key];
      if (ev > EV_STAT_MAX) {
        warnings.push({
          code: "ev_stat_exceeded",
          slot,
          field: `evs.${key}`,
          message: `EV in ${key} is ${ev}, exceeding the per-stat maximum of ${EV_STAT_MAX}.`,
        });
      }
    }

    // IV range.
    for (const key of STAT_KEYS) {
      const iv = member.ivs[key];
      if (iv < IV_MIN || iv > IV_MAX) {
        warnings.push({
          code: "iv_out_of_range",
          slot,
          field: `ivs.${key}`,
          message: `IV in ${key} is ${iv}, outside the legal range ${IV_MIN}–${IV_MAX}.`,
        });
      }
    }

    // Species / ability / move legality (index-backed).
    if (member.species) {
      const profile = profiles.get(member.species);
      if (!profile || !profile.found) {
        warnings.push({
          code: "species_illegal",
          slot,
          field: "species",
          message: `Species "${member.species}" is not legal in this format.`,
        });
      } else {
        // Ability must be one of the species' legal ability slots.
        if (member.ability) {
          const legalAbilities = [
            profile.abilities.slot1,
            profile.abilities.slot2,
            profile.abilities.hidden,
          ].filter((a): a is string => Boolean(a));
          if (!legalAbilities.includes(member.ability)) {
            warnings.push({
              code: "ability_not_for_species",
              slot,
              field: "ability",
              message: `Ability "${member.ability}" is not a legal ability for ${member.species}.`,
            });
          }
        }

        // Each move must be in the species' learnset for the format.
        const learnset = learnsets.get(member.species);
        if (learnset) {
          member.moves.forEach((move, moveIndex) => {
            if (!move) return;
            if (!learnset.has(move)) {
              warnings.push({
                code: "move_not_in_learnset",
                slot,
                field: `moves[${moveIndex}]`,
                message: `Move "${move}" is not in ${member.species}'s learnset for this format.`,
              });
            }
          });
        }
      }
    }

    // Held-item legality (independent of species).
    if (member.item && legalItems && !legalItems.has(member.item)) {
      warnings.push({
        code: "item_illegal",
        slot,
        field: "item",
        message: `Item "${member.item}" is not legal in this format.`,
      });
    }
  });

  // ---- Team-level clauses ----

  for (const dup of duplicates(members.map((m) => m.species))) {
    warnings.push({
      code: "duplicate_species",
      message: `Species clause: "${dup.value}" appears in slots ${dup.slots
        .map((s) => s + 1)
        .join(", ")}.`,
    });
  }

  for (const dup of duplicates(members.map((m) => m.item))) {
    warnings.push({
      code: "duplicate_item",
      message: `Item clause: "${dup.value}" is held in slots ${dup.slots
        .map((s) => s + 1)
        .join(", ")}.`,
    });
  }

  return warnings;
}

/** A repeated non-null value and the (0-based) slots it occupies. */
interface Duplicate {
  value: string;
  slots: number[];
}

/**
 * Group non-null/non-empty values and return those that occur more than once,
 * in first-seen order (deterministic). Empty/null entries are ignored (a partial
 * team's blank slots never trip a clause).
 */
function duplicates(values: Array<string | null>): Duplicate[] {
  const slotsByValue = new Map<string, number[]>();
  const order: string[] = [];
  values.forEach((value, slot) => {
    if (!value) return;
    const existing = slotsByValue.get(value);
    if (existing) {
      existing.push(slot);
    } else {
      slotsByValue.set(value, [slot]);
      order.push(value);
    }
  });
  return order
    .filter((value) => slotsByValue.get(value)!.length > 1)
    .map((value) => ({ value, slots: slotsByValue.get(value)! }));
}
