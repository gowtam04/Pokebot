/**
 * Pure dual-type defensive-chart mechanics (TD-6).
 *
 * Extracted verbatim from the `get_type_matchups` tool so BOTH the tool (two-type
 * combined defensive request, tools.md T6) and the artifact viewer's Pokémon
 * profile (a species' combined defensive grid, B-4) compute matchups from ONE
 * implementation — no reimplementation, guarded by the tool's existing tests.
 *
 * A single type's matchups are exactly 0× / 0.5× / 1× / 2×, so reconstructing a
 * multiplier from its classified defensive lists is exact. Immunities are 0× and
 * MUST be reported under `immune_to`, never as a resist (BR-5): a combined
 * multiplier of exactly 0 → immune_to; > 1 → weak_to; 0 < m < 1 → resists; 1 →
 * neutral (omitted).
 */

import { TYPE_NAMES } from "@/agent/schemas";

/** A type's (or combination's) classified defensive profile. */
export type DefensiveProfile = {
  weak_to: string[];
  resists: string[];
  immune_to: string[];
};

/**
 * Defensive multiplier of one (single) type against an attacking type, derived
 * from its classified defensive lists.
 */
export function defMultiplier(def: DefensiveProfile, attacking: string): number {
  if (def.immune_to.includes(attacking)) return 0;
  if (def.weak_to.includes(attacking)) return 2;
  if (def.resists.includes(attacking)) return 0.5;
  return 1;
}

/**
 * Combine one or more single-type defensive profiles into one classified profile
 * by multiplying per-attacking-type multipliers. Pass a single profile to get it
 * re-classified unchanged; pass two for a dual-type grid. An empty list yields an
 * all-neutral profile (no weaknesses/resists/immunities).
 */
export function combineDefensive(
  profiles: DefensiveProfile[],
): DefensiveProfile {
  const weak_to: string[] = [];
  const resists: string[] = [];
  const immune_to: string[] = [];

  for (const attacking of TYPE_NAMES) {
    const m = profiles.reduce(
      (acc, def) => acc * defMultiplier(def, attacking),
      1,
    );
    if (m === 0) {
      immune_to.push(attacking);
    } else if (m > 1) {
      weak_to.push(attacking);
    } else if (m < 1) {
      resists.push(attacking);
    }
    // m === 1 → neutral, omitted
  }

  return { weak_to, resists, immune_to };
}
