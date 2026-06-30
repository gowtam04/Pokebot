/**
 * encounter-repo.ts — T14 `get_encounters` reader (pure Postgres read).
 *
 * Catch-location / obtain-method data is pre-built per the STANDARD format at
 * ingest (src/ingest/build-encounters.ts) from a committed PokeAPI snapshot and
 * stored in reference_cache under resource_kind "encounters", keyed by
 * `encounters/<species_name>`. This reader resolves the queried name to its
 * species (so any form resolves to its base-species locations) and returns the
 * pre-built grouped payload:
 *
 *   1. Index not built (no ingest_meta row) → { error: "index_unavailable" }.
 *   2. Name doesn't resolve to a Pokémon → { found:false, suggestions }.
 *   3. HIT → the stored EncounterDetail (found:true, grouped by version-group;
 *      coverage_note set when the species has no recorded encounters).
 *   4. Species exists but no encounter row (a pre-feature index) → found:true,
 *      empty, with a "re-run ingest" note.
 *
 * Never throws for in-domain failures (tool contract). The Champions gate lives
 * in the TOOL (get-encounters.ts), not here — Champions builds no encounter rows.
 *
 * node-postgres is asynchronous — the DB reads here are awaited. The Drizzle
 * handle is supplied by the caller (the bound per-request DbCtx); this module
 * imports only the TYPE of the handle, so it runs against a fixture DB too.
 */

import { and, asc, eq, ilike, or } from "drizzle-orm";

import type { OakDb } from "@/data/db";
import type { Format } from "@/data/formats";
import { ingest_meta, pokemon, reference_cache } from "@/data/schema";
import type { EncounterDetail, GetEncountersOutput } from "@/agent/schemas";

/** Shown when the species exists but its index predates the encounter feature. */
const STALE_INDEX_NOTE =
  "This index was built before catch-location data was added — re-run ingest " +
  "to populate encounters for this Pokémon.";

/** Lowercase + trim a user-supplied name toward a slug (mirrors pokedex-repo). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Presence of the format's ingest_meta row is the canonical "index built" signal. */
async function indexAvailable(db: OakDb, format: Format): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(ingest_meta)
      .where(eq(ingest_meta.format, format))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Resolve a name to its species_name + display_name (any form → its species). */
async function resolveSpecies(
  db: OakDb,
  name: string,
  format: Format,
): Promise<{ speciesName: string; displayName: string } | null> {
  try {
    const rows = await db
      .select({
        species_name: pokemon.species_name,
        display_name: pokemon.display_name,
      })
      .from(pokemon)
      .where(and(eq(pokemon.id, normalizeName(name)), eq(pokemon.format, format)))
      .limit(1);
    const row = rows[0];
    return row
      ? { speciesName: row.species_name, displayName: row.display_name }
      : null;
  } catch {
    return null;
  }
}

/** Up to five close Pokémon slugs for a miss (resolve_entity is the real matcher). */
async function suggestionsFor(
  db: OakDb,
  query: string,
  format: Format,
): Promise<string[]> {
  const q = normalizeName(query);
  if (q.length === 0) return [];
  const pattern = `%${q}%`;
  try {
    const rows = await db
      .select({ id: pokemon.id })
      .from(pokemon)
      .where(
        and(
          eq(pokemon.format, format),
          or(ilike(pokemon.id, pattern), ilike(pokemon.species_name, pattern)),
        ),
      )
      .orderBy(asc(pokemon.national_dex_number), asc(pokemon.id))
      .limit(5);
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * Read where/how a Pokémon can be obtained, grouped by game (version-group).
 *
 * @param name   a Pokémon name or slug (resolve_entity first if unsure).
 * @param format the active data scope (only "scarlet-violet" ever has rows).
 * @param db     the Drizzle handle (from the request's DbCtx / fixture).
 */
export async function getEncounters(
  name: string,
  format: Format,
  db: OakDb,
): Promise<GetEncountersOutput> {
  if (!(await indexAvailable(db, format))) {
    return { error: "index_unavailable" };
  }

  const species = await resolveSpecies(db, name, format);
  if (!species) {
    return { found: false, suggestions: await suggestionsFor(db, name, format) };
  }

  const key = `encounters/${species.speciesName}`;
  let payload: string | undefined;
  try {
    const rows = await db
      .select({ payload: reference_cache.payload })
      .from(reference_cache)
      .where(
        and(
          eq(reference_cache.format, format),
          eq(reference_cache.resource_key, key),
        ),
      )
      .limit(1);
    payload = rows[0]?.payload;
  } catch {
    payload = undefined;
  }

  if (payload) {
    try {
      return JSON.parse(payload) as EncounterDetail;
    } catch {
      // Corrupt payload — fall through to the empty-but-known shape.
    }
  }

  return {
    found: true,
    name: species.displayName,
    encounters: [],
    coverage_note: STALE_INDEX_NOTE,
  };
}
