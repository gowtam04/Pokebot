/**
 * team-paste.ts — the SINGLE `@pkmn/sets` integration point.
 *
 * `@pkmn/sets` is the canonical Showdown / pokepaste parser+serializer that
 * ships with the `@pkmn` ecosystem we already vendor. Per the project's
 * "all `@pkmn` imports live under src/data/pkmn" convention, this is the ONLY
 * module allowed to import it (the sibling of gen-provider.ts for `@pkmn/dex`).
 *
 * It deals purely in `@pkmn`'s {@link PokemonSet} — i.e. **display names**
 * ("Great Tusk", "Close Combat", "Booster Energy"), the byte-exact Showdown
 * wire shape. It knows nothing about the index, slugs, the DB, or
 * {@link import("@/data/teams/team-schema").TeamMember}; mapping display↔slug is
 * the job of `src/server/teams/import-export.ts`, which composes this module.
 *
 * NOTE (wave-1 carry-over): `@pkmn/sets@5.2.0` is installed — NOT the 0.10.x API
 * the design doc assumed. The real 5.x surface (verified against
 * node_modules/@pkmn/sets/build/index.d.ts) exposes:
 *   - `PokemonSet` (re-exported from `@pkmn/types`),
 *   - `Sets.importSet` / `Sets.exportSet` (a single set), and
 *   - `Team` / `Teams` for a full multi-set paste.
 * We build on `Team.import` (full paste) with a per-block `Sets.importSet`
 * fallback so a single malformed block can't sink the whole paste.
 */

import { Sets, Team, type PokemonSet } from "@pkmn/sets";

/**
 * The Showdown set shape this module deals in (display names). Re-exported so
 * downstream services type against `team-paste` rather than importing `@pkmn`
 * directly — keeping the `@pkmn/sets` dependency isolated to this file.
 */
export type ShowdownSet = PokemonSet;

/** Cap on sets parsed from a single paste (a team is at most 6, BR-T4). */
const MAX_SETS = 6;

/** True when a parsed set carries a non-empty species (the one required field). */
function hasSpecies(set: Partial<PokemonSet> | undefined): set is PokemonSet {
  return Boolean(set && typeof set.species === "string" && set.species.trim());
}

/**
 * Parse Showdown / pokepaste text into a list of {@link ShowdownSet}.
 *
 * Tolerant by contract (BR-T11): it never throws and silently skips any block
 * it cannot turn into a set with a species. A well-formed multi-set paste goes
 * through `Team.import`; if that yields nothing (e.g. a non-standard separator),
 * each blank-line-delimited block is retried individually with `Sets.importSet`
 * so the parseable members still come through.
 *
 * The returned sets are `Partial<PokemonSet>` in practice (Showdown omits
 * defaulted fields — no `EVs:` line means no `evs` key, etc.); the importer
 * fills those defaults when mapping to `TeamMember`.
 */
export function parseShowdown(text: string): ShowdownSet[] {
  if (!text || !text.trim()) return [];

  let sets: Array<Partial<PokemonSet>> = [];

  try {
    const team = Team.import(text);
    if (team && Array.isArray(team.team) && team.team.length > 0) {
      sets = team.team;
    }
  } catch {
    // fall through to the per-block fallback
  }

  if (sets.length === 0) {
    for (const block of text.split(/\n\s*\n/)) {
      if (!block.trim()) continue;
      try {
        const set = Sets.importSet(block);
        if (set) sets.push(set);
      } catch {
        // skip an unparseable block (BR-T11)
      }
    }
  }

  return sets.filter(hasSpecies).slice(0, MAX_SETS);
}

/**
 * Serialize {@link ShowdownSet}s back to Showdown paste text (the inverse of
 * {@link parseShowdown}). Defaulted fields (0 EVs, 31 IVs, level 100) are
 * omitted by `@pkmn`'s exporter, matching Showdown's own output; `parseShowdown`
 * re-reads them as the same defaults, so the round-trip is lossless for every
 * represented field (AC-11.1/11.2).
 */
export function serializeShowdown(sets: ShowdownSet[]): string {
  if (!sets || sets.length === 0) return "";
  return new Team(sets).export();
}
