/**
 * PokedexRepo — typed, read-only Postgres access backing the two index tools
 * (design.md § Data-access repositories):
 *
 *   queryPokedex  → T2 `query_pokedex` (the workhorse): dynamic filter / sort /
 *                   threshold SQL over DS-2 (`pokemon`) + DS-3 (`learnset`).
 *   getPokemon    → T3 `get_pokemon`: single-form profile read over DS-2.
 *
 * Contract (tools.md T2/T3 + schemas.ts). The exact STRUCTURED shapes the model
 * reasons about take precedence over a generic Result and are returned verbatim:
 *
 *   queryPokedex → QueryPokedexResult
 *                | { error: "index_unavailable" }   (index not built / unreadable)
 *                | { unresolved: string[] }         (a filter slug isn't in the index)
 *   getPokemon   → PokemonProfile (found:true)
 *                | { found:false, suggestions: string[] }
 *
 * Query-builder rules (RISK DIRECTIVES):
 *   - Built with Drizzle `.$dynamic()` + `and(...)` — never string-concatenated SQL.
 *   - `types`     → AND  (each listed type must appear in type1 OR type2).
 *   - `abilities` → OR   (ANY listed ability across slot1 / slot2 / hidden).
 *   - `stat_filters` → AND (each numeric base-stat constraint).
 *   - `moveIds`   → learnset INTERSECTION (per format): the canonical
 *       `WHERE move_slug IN(...) AND format = ? GROUP BY pokemon_id
 *        HAVING count(distinct move_slug)=N`
 *     computed over DS-3 (BR-2/BR-7). The same membership query is exposed by
 *     learnset-repo.pokemonLearningAll; it is inlined here so query_pokedex owns
 *     a single dynamic statement and so this repo + its tests stay self-contained.
 *
 * node-postgres is ASYNCHRONOUS — every read path here is `async` and awaits its
 * Drizzle query. The Drizzle handle is supplied by the caller (the bound
 * per-request DbCtx); this module imports only the TYPE of the handle from
 * db.ts, never the runtime connection, so it can be exercised against a fixture
 * DB without opening a connection of its own.
 */

import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { PokebotDb } from "@/data/db";
import type { Format } from "@/data/formats";
import { ingest_meta, learnset, pokemon } from "@/data/schema";
import {
  TYPE_NAMES,
  type GetPokemonOutput,
  type PokedexRow,
  type PokemonProfile,
  type QueryPokedexOutput,
  type StatKey,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Filter input (design.md § Interface Definitions — pokedex-repo)
// ---------------------------------------------------------------------------

export interface PokedexFilters {
  /** ALL listed types must be present (AND over type1/type2). */
  types?: string[];
  /** ANY listed ability (OR over slot1/slot2/hidden). */
  abilities?: string[];
  /** ALL listed moves, learnable in Gen 9 (learnset intersection, BR-7). */
  moveIds?: string[];
  /** Numeric base-stat constraints, ANDed together. */
  statFilters?: {
    stat: StatKey;
    op: ">" | ">=" | "<" | "<=" | "==";
    value: number;
  }[];
  /** Stat/field to rank by (superlatives). */
  sortBy?: StatKey | "national_dex_number";
  /** Sort direction. Default "desc". */
  order?: "asc" | "desc";
  /** Result cap. Default 20, clamped to [1, 100]. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column lookups
// ---------------------------------------------------------------------------

/** Map a StatKey (and the dex field) to its Drizzle column. */
const STAT_COLUMN = {
  hp: pokemon.stat_hp,
  attack: pokemon.stat_attack,
  defense: pokemon.stat_defense,
  special_attack: pokemon.stat_special_attack,
  special_defense: pokemon.stat_special_defense,
  speed: pokemon.stat_speed,
  base_stat_total: pokemon.base_stat_total,
} as const;

function sortColumn(field: StatKey | "national_dex_number") {
  return field === "national_dex_number"
    ? pokemon.national_dex_number
    : STAT_COLUMN[field];
}

function statCondition(sf: {
  stat: StatKey;
  op: ">" | ">=" | "<" | "<=" | "==";
  value: number;
}): SQL {
  const col = STAT_COLUMN[sf.stat];
  switch (sf.op) {
    case ">":
      return gt(col, sf.value);
    case ">=":
      return gte(col, sf.value);
    case "<":
      return lt(col, sf.value);
    case "<=":
      return lte(col, sf.value);
    case "==":
      return eq(col, sf.value);
  }
}

// ---------------------------------------------------------------------------
// Row → tool shape mappers
// ---------------------------------------------------------------------------

type PokemonRecord = typeof pokemon.$inferSelect;

function rowTypes(row: PokemonRecord): string[] {
  return row.type2 ? [row.type1, row.type2] : [row.type1];
}

function rowAbilities(row: PokemonRecord): PokedexRow["abilities"] {
  const abilities: PokedexRow["abilities"] = { slot1: row.ability_slot1 };
  if (row.ability_slot2) abilities.slot2 = row.ability_slot2;
  if (row.ability_hidden) abilities.hidden = row.ability_hidden;
  return abilities;
}

function rowBaseStats(row: PokemonRecord): PokedexRow["base_stats"] {
  return {
    hp: row.stat_hp,
    attack: row.stat_attack,
    defense: row.stat_defense,
    special_attack: row.stat_special_attack,
    special_defense: row.stat_special_defense,
    speed: row.stat_speed,
  };
}

function toPokedexRow(row: PokemonRecord): PokedexRow {
  return {
    display_name: row.display_name,
    national_dex_number: row.national_dex_number,
    types: rowTypes(row),
    abilities: rowAbilities(row),
    base_stats: rowBaseStats(row),
    base_stat_total: row.base_stat_total,
    sprite_url: row.sprite_url,
    is_gen9_native: row.is_gen9_native === 1,
    source_generation: row.source_generation,
  };
}

// ---------------------------------------------------------------------------
// Index availability + version groups
// ---------------------------------------------------------------------------

type IndexMeta = { available: true } | { available: false };

/**
 * Confirm the index for `format` has been built. The presence of that format's
 * `ingest_meta` row is the canonical signal (data-sources.md failure behavior);
 * a missing row or an unreadable table → `index_unavailable`.
 */
async function readIndexMeta(
  db: PokebotDb,
  format: Format,
): Promise<IndexMeta> {
  try {
    const rows = await db
      .select()
      .from(ingest_meta)
      .where(eq(ingest_meta.format, format))
      .limit(1);
    return rows.length === 0 ? { available: false } : { available: true };
  } catch {
    // Table doesn't exist yet (migrations not applied) — treat as unavailable.
    return { available: false };
  }
}

// ---------------------------------------------------------------------------
// Slug validation (→ { unresolved })
// ---------------------------------------------------------------------------

const CANONICAL_TYPES = new Set<string>(TYPE_NAMES);

async function abilityInIndex(
  db: PokebotDb,
  abilitySlug: string,
  format: Format,
): Promise<boolean> {
  const rows = await db
    .select({ id: pokemon.id })
    .from(pokemon)
    .where(
      and(
        eq(pokemon.format, format),
        or(
          eq(pokemon.ability_slot1, abilitySlug),
          eq(pokemon.ability_slot2, abilitySlug),
          eq(pokemon.ability_hidden, abilitySlug),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function moveInIndex(
  db: PokebotDb,
  moveSlug: string,
  format: Format,
): Promise<boolean> {
  const rows = await db
    .select({ id: learnset.pokemon_id })
    .from(learnset)
    .where(and(eq(learnset.move_slug, moveSlug), eq(learnset.format, format)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Collect every filter slug that isn't present in the index for `format`,
 * preserving input order (types, then abilities, then moves). Types are
 * validated against the 18 canonical type slugs; abilities/moves against the
 * actual format-scoped index rows.
 */
async function collectUnresolved(
  db: PokebotDb,
  f: PokedexFilters,
  format: Format,
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const t of f.types ?? []) {
    if (!CANONICAL_TYPES.has(t)) unresolved.push(t);
  }
  for (const a of f.abilities ?? []) {
    if (!(await abilityInIndex(db, a, format))) unresolved.push(a);
  }
  for (const m of f.moveIds ?? []) {
    if (!(await moveInIndex(db, m, format))) unresolved.push(m);
  }
  return unresolved;
}

// ---------------------------------------------------------------------------
// Multi-move Gen-9 learnset intersection (BR-7)
// ---------------------------------------------------------------------------

/**
 * Pokémon ids that can learn ALL `moveIds` within `format`. Canonical
 * intersection: filter the learnset to the requested moves + format, group by
 * Pokémon, and keep only those covering every distinct move (BR-7).
 * (Equivalent to learnset-repo.pokemonLearningAll.)
 */
async function pokemonLearningAll(
  db: PokebotDb,
  moveIds: string[],
  format: Format,
): Promise<string[]> {
  if (moveIds.length === 0) return [];
  const rows = await db
    .select({ pokemonId: learnset.pokemon_id })
    .from(learnset)
    .where(
      and(inArray(learnset.move_slug, moveIds), eq(learnset.format, format)),
    )
    .groupBy(learnset.pokemon_id)
    .having(eq(countDistinct(learnset.move_slug), moveIds.length));
  return rows.map((r) => r.pokemonId);
}

// ===========================================================================
// queryPokedex — T2
// ===========================================================================

export async function queryPokedex(
  f: PokedexFilters,
  format: Format,
  db: PokebotDb,
): Promise<QueryPokedexOutput> {
  const meta = await readIndexMeta(db, format);
  if (!meta.available) {
    return { error: "index_unavailable" };
  }

  // Reject any filter slug the index doesn't know — the agent should
  // resolve_entity and retry (tools.md T2).
  const unresolved = await collectUnresolved(db, f, format);
  if (unresolved.length > 0) {
    return { unresolved };
  }

  const order: "asc" | "desc" = f.order ?? "desc";
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  const sort = f.sortBy ? `${f.sortBy} ${order}` : null;

  // --- WHERE: dynamic AND of all filter groups -----------------------------
  // Every query is scoped to the active format.
  const conditions: SQL[] = [eq(pokemon.format, format)];

  // types — ALL listed (AND); each: type1 == t OR type2 == t.
  for (const t of f.types ?? []) {
    conditions.push(or(eq(pokemon.type1, t), eq(pokemon.type2, t)) as SQL);
  }

  // abilities — ANY listed (OR over every ability slot).
  if (f.abilities && f.abilities.length > 0) {
    const abilityOr = or(
      ...f.abilities.flatMap((a) => [
        eq(pokemon.ability_slot1, a),
        eq(pokemon.ability_slot2, a),
        eq(pokemon.ability_hidden, a),
      ]),
    );
    if (abilityOr) conditions.push(abilityOr);
  }

  // stat_filters — ANDed numeric constraints.
  for (const sf of f.statFilters ?? []) {
    conditions.push(statCondition(sf));
  }

  // moves — Gen-9 learnset intersection; an empty intersection short-circuits
  // to an honest empty result (NOT an error).
  if (f.moveIds && f.moveIds.length > 0) {
    const ids = await pokemonLearningAll(db, f.moveIds, format);
    if (ids.length === 0) {
      return { total_count: 0, truncated: false, sort, results: [] };
    }
    conditions.push(inArray(pokemon.id, ids));
  }

  const whereExpr = and(...conditions);

  // --- total_count (full match set, pre-limit) -----------------------------
  // count(*) is a Postgres bigint (node-postgres returns it as a string);
  // `.mapWith(Number)` coerces it back to a JS number.
  const countBase = db
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(pokemon)
    .$dynamic();
  const countRows = await (whereExpr
    ? countBase.where(whereExpr)
    : countBase);
  const total_count = countRows[0]?.value ?? 0;

  // --- page of rows --------------------------------------------------------
  const primaryOrder = f.sortBy
    ? order === "asc"
      ? asc(sortColumn(f.sortBy))
      : desc(sortColumn(f.sortBy))
    : asc(pokemon.national_dex_number);

  const selectBase = db.select().from(pokemon).$dynamic();
  const rows = await (whereExpr ? selectBase.where(whereExpr) : selectBase)
    // stable, deterministic tiebreaker on the slug PK
    .orderBy(primaryOrder, asc(pokemon.id))
    .limit(limit);

  return {
    total_count,
    truncated: total_count > rows.length,
    sort,
    results: rows.map(toPokedexRow),
  };
}

// ===========================================================================
// getPokemon — T3
// ===========================================================================

/** Lowercase + trim a user-supplied name into something close to a slug. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Up to five close ids for a miss, by substring match on the slug or species
 * name — a lightweight nudge; resolve_entity (T1) is the real fuzzy matcher.
 */
async function suggestionsFor(
  db: PokebotDb,
  query: string,
  format: Format,
): Promise<string[]> {
  const q = normalizeName(query);
  if (q.length === 0) return [];
  const pattern = `%${q}%`;
  // ilike: SQLite LIKE was case-insensitive by default; Postgres LIKE is not.
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
}

export async function getPokemon(
  slug: string,
  format: Format,
  db: PokebotDb,
): Promise<GetPokemonOutput> {
  const id = normalizeName(slug);

  let row: PokemonRecord | undefined;
  try {
    const rows = await db
      .select()
      .from(pokemon)
      .where(and(eq(pokemon.id, id), eq(pokemon.format, format)))
      .limit(1);
    row = rows[0];
  } catch {
    // Index unreadable (e.g. table missing) — surface as a miss with no
    // suggestions; get_pokemon has no index_unavailable branch (schemas.ts).
    return { found: false, suggestions: [] };
  }

  if (!row) {
    return {
      found: false,
      suggestions: await suggestionsFor(db, slug, format),
    };
  }

  // All forms of this species (e.g. Tauros' Paldean breeds), dex-then-slug order.
  const forms = (
    await db
      .select({ id: pokemon.id })
      .from(pokemon)
      .where(
        and(
          eq(pokemon.species_name, row.species_name),
          eq(pokemon.format, format),
        ),
      )
      .orderBy(asc(pokemon.national_dex_number), asc(pokemon.id))
  ).map((r) => r.id);

  const profile: PokemonProfile = {
    found: true,
    display_name: row.display_name,
    national_dex_number: row.national_dex_number,
    types: rowTypes(row),
    abilities: rowAbilities(row),
    base_stats: rowBaseStats(row),
    base_stat_total: row.base_stat_total,
    sprite_url: row.sprite_url,
    artwork_url: row.artwork_url,
    forms,
    is_gen9_native: row.is_gen9_native === 1,
    source_generation: row.source_generation,
  };
  return profile;
}
