/**
 * DS-3 learnset builder — @pkmn-backed.
 *
 * @pkmn learnsets are `{ moveId: sourceString[] }`. Each source string encodes
 * gen + method at indexes 0/1, e.g. "9M" (Gen 9 machine/TM), "9L42" (Gen 9
 * level-up at 42), "9T" (tutor), "9E" (egg), "8M" (Gen 8 machine), "9S0" (event).
 *
 * Rules (D6, BR-2):
 *   - Keep only level-up / machine / tutor methods; drop egg (and event/virtual/
 *     other) sources.
 *   - Standard (scarlet-violet) keeps only Gen-9 ('9…') sources — the SV
 *     learnset. Champions uses the mod's already-scoped learnset as-is.
 *   - One row per (pokemon_id, move_slug, format); when several non-egg methods
 *     qualify, the highest-priority one wins (level-up > machine > tutor).
 */

import type { Format } from "@/data/formats";

export interface LearnsetRow {
  /** FK → pokemon.id (the slug, e.g. "garchomp"). */
  pokemon_id: string;
  /** Canonical move slug, e.g. "will-o-wisp". */
  move_slug: string;
  /** Data scope ("scarlet-violet" | "champions"). */
  format: Format;
  /** "level-up" | "machine" | "tutor". Never "egg". */
  method: string | null;
}

/** Source-string method letter → method name. Letters not here are dropped. */
const METHOD_BY_LETTER: Readonly<Record<string, string>> = {
  L: "level-up",
  M: "machine",
  T: "tutor",
};

const METHOD_PRIORITY: Readonly<Record<string, number>> = {
  "level-up": 0,
  machine: 1,
  tutor: 2,
};

function methodPriority(method: string): number {
  return METHOD_PRIORITY[method] ?? 99;
}

/**
 * Build learnset rows for one species from its @pkmn learnset record.
 *
 * @param pokemonId   The pokemon slug (pokemon.id / FK).
 * @param learnset    `{ moveId: sourceString[] }` from `FormatSource.getLearnset`.
 * @param moveSlugFor Resolve an @pkmn moveId → canonical move slug (null to skip).
 * @param opts.format       The data scope.
 * @param opts.gen9Only     When true (standard), only '9…' sources count.
 */
export function buildLearnsetRows(
  pokemonId: string,
  learnset: Record<string, string[]>,
  moveSlugFor: (moveId: string) => string | null,
  opts: { format: Format; gen9Only: boolean },
): LearnsetRow[] {
  const rows: LearnsetRow[] = [];

  for (const [moveId, sources] of Object.entries(learnset)) {
    if (!Array.isArray(sources)) continue;

    let bestMethod: string | undefined;
    for (const src of sources) {
      if (typeof src !== "string" || src.length < 2) continue;
      if (opts.gen9Only && src[0] !== "9") continue;
      const method = METHOD_BY_LETTER[src[1]!];
      if (!method) continue; // egg / event / virtual / other → drop
      if (
        bestMethod === undefined ||
        methodPriority(method) < methodPriority(bestMethod)
      ) {
        bestMethod = method;
      }
    }

    if (bestMethod === undefined) continue;
    const move_slug = moveSlugFor(moveId);
    if (!move_slug) continue;

    rows.push({
      pokemon_id: pokemonId,
      move_slug,
      format: opts.format,
      method: bestMethod,
    });
  }

  return rows;
}
