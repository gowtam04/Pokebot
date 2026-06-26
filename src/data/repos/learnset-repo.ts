/**
 * LearnsetRepo — typed reads over the DS-3 Gen-9 `learnset` table
 * (design.md § Interface Definitions; Phase 4 "Tools").
 *
 * Two read paths, both pure SQL computed *in the database* (never by the model):
 *
 *   - `pokemonLearningAll` — the multi-move **intersection** (BR-7). Given a set
 *     of move slugs and the active `format`, returns the ids of every Pokémon
 *     whose learnset contains ALL of them. Implemented as a single
 *     `GROUP BY pokemon_id HAVING COUNT(DISTINCT move_slug) = N` over the rows
 *     filtered by `move_slug IN (...)` AND `format = ...` — exactly the SQL shape
 *     mandated by the RISK DIRECTIVES / design.md § learnset table.
 *
 *   - `gen9LearnerCount` — how many distinct Pokémon learn a given move in Gen 9
 *     (backs `get_move`'s optional `gen9_learner_count`, T4). The `learnset`
 *     table is built by ingest for Gen-9 version groups only (D6/BR-2), so a
 *     plain `COUNT(DISTINCT pokemon_id)` over the move already respects Gen-9.
 *
 * Module boundary (design.md § Code Conventions): repos are the sole Postgres
 * readers. The Drizzle handle is threaded in by the caller (the per-request
 * DbCtx assembled in src/agent/context.ts) rather than imported here, so this
 * module has no eager DB-connection side effect and stays trivially testable
 * against a fixture database. `PokebotDb` is imported type-only for that reason.
 *
 * node-postgres is asynchronous — these functions are `async` and `await` their
 * Drizzle queries (Promise<string[]> / Promise<number>).
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { PokebotDb } from "@/data/db";
import type { Format } from "@/data/formats";
import { learnset } from "@/data/schema";

/**
 * Ids of every Pokémon that can learn **all** of `moveIds` within `format`
 * (the learnset intersection, BR-7).
 *
 * Computed entirely in SQL:
 *
 * ```sql
 * SELECT pokemon_id
 *   FROM learnset
 *  WHERE move_slug IN (:moveIds)
 *    AND format = :format
 *  GROUP BY pokemon_id
 * HAVING COUNT(DISTINCT move_slug) = :N      -- N = distinct requested moves
 *  ORDER BY pokemon_id;                       -- stable, deterministic ordering
 * ```
 *
 * - Duplicate slugs in `moveIds` are de-duplicated first, so the `HAVING` count
 *   target `N` is the number of *distinct* requested moves (a duplicate must not
 *   inflate the threshold and make every match impossible).
 * - An empty `moveIds` set has an empty intersection by definition → returns
 *   `[]` (and avoids emitting an `IN ()` clause).
 *
 * @param moveIds  canonical move slugs to intersect.
 * @param format   the active data scope ("scarlet-violet" | "champions").
 * @param database the Drizzle handle (from the request's DbCtx / fixture).
 * @returns sorted list of matching `pokemon.id` slugs (possibly empty).
 */
export async function pokemonLearningAll(
  moveIds: string[],
  format: Format,
  database: PokebotDb,
): Promise<string[]> {
  const distinctMoveIds = [...new Set(moveIds)];
  if (distinctMoveIds.length === 0) {
    return [];
  }

  const rows = await database
    .select({ pokemonId: learnset.pokemon_id })
    .from(learnset)
    .where(
      and(
        inArray(learnset.move_slug, distinctMoveIds),
        eq(learnset.format, format),
      ),
    )
    .groupBy(learnset.pokemon_id)
    .having(
      sql`count(distinct ${learnset.move_slug}) = ${distinctMoveIds.length}`,
    )
    .orderBy(learnset.pokemon_id);

  return rows.map((row) => row.pokemonId);
}

/**
 * Number of **distinct** Pokémon that learn `moveId` within `format`.
 *
 * Backs get_move's optional learner count. An unknown / never-learned move
 * yields `0`.
 *
 * @param moveId   canonical move slug, e.g. "will-o-wisp".
 * @param format   the active data scope ("scarlet-violet" | "champions").
 * @param database the Drizzle handle (from the request's DbCtx / fixture).
 */
export async function gen9LearnerCount(
  moveId: string,
  format: Format,
  database: PokebotDb,
): Promise<number> {
  // count(distinct …) is a Postgres bigint, which node-postgres returns as a
  // string; `.mapWith(Number)` coerces it back to a JS number.
  const rows = await database
    .select({
      count: sql<number>`count(distinct ${learnset.pokemon_id})`.mapWith(
        Number,
      ),
    })
    .from(learnset)
    .where(and(eq(learnset.move_slug, moveId), eq(learnset.format, format)));

  return rows[0]?.count ?? 0;
}
