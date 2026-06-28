/**
 * Deterministic fixture DB seed for the INDEPENDENT ORACLE TESTS of the Tool
 * layer (Phase 4: src/agent/tools/**, src/agent/formulas/**, src/data/repos/**).
 *
 * This file is NOT a test itself (it has no `.test.ts` suffix, so vitest does
 * not collect it). It is the shared seed + context helper consumed by the
 * `*.oracle.test.ts` files in this folder.
 *
 * Design intent (derived from the docs, NOT from the implementation):
 *   - Curated species mandated by design.md § Testing Strategy / the task:
 *       Garchomp, Farigiraf, a Fire/Flash-Fire mon (Ninetales), a non-Gen-9
 *       fallback species (Dracovish), and the Tauros forms (D8).
 *   - Stats/types/abilities are the real PokeAPI values (cross-checked against
 *     src/ingest/__fixtures__/*.json) so the oracle's expected numbers come from
 *     ground truth, not from whatever the impl happens to produce.
 *   - Learnsets are a SMALL CONTROLLED set chosen so the multi-move intersection
 *     (BR-7) and the combined type+ability+move filter (G5) have a single,
 *     unambiguous expected answer.
 *   - One reference_cache row per type chart entry needed for get_type_matchups
 *     so that tool resolves from the cache (a HIT) and never reaches PokeAPI in
 *     a test (the read-through cache contract, tools.md T6 / BR-8).
 *   - ingest_meta is populated so the index reads as "available" (NOT
 *     index_unavailable) for the seeded-DB oracle.
 *
 * The seeder writes via Drizzle inserts over the node-postgres handle, so it
 * depends only on the committed schema (src/data/schema.ts) and not on any
 * Phase-4 code.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/data/schema";
import {
  ingest_meta,
  learnset,
  pokemon,
  reference_cache,
  searchable_names,
} from "@/data/schema";
import type { AgentContext } from "@/agent/types";

/** A Drizzle handle typed over the full Oak schema (node-postgres). */
export type ToolsFixtureDb = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export type PokemonSeed = {
  id: string;
  species_name: string;
  form_name: string | null;
  display_name: string;
  national_dex_number: number;
  type1: string;
  type2: string | null;
  ability_slot1: string;
  ability_slot2: string | null;
  ability_hidden: string | null;
  stat_hp: number;
  stat_attack: number;
  stat_defense: number;
  stat_special_attack: number;
  stat_special_defense: number;
  stat_speed: number;
  base_stat_total: number;
  sprite_url: string;
  artwork_url: string;
  generation: string;
  is_gen9_native: number; // 0 | 1
  source_generation: string | null;
};

function bst(s: {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}): number {
  return s.hp + s.atk + s.def + s.spa + s.spd + s.spe;
}

/** Curated Pokédex rows (real PokeAPI stats/types/abilities). */
export const POKEMON_SEED: PokemonSeed[] = [
  {
    id: "garchomp",
    species_name: "garchomp",
    form_name: null,
    display_name: "Garchomp",
    national_dex_number: 445,
    type1: "dragon",
    type2: "ground",
    ability_slot1: "sand-veil",
    ability_slot2: null,
    ability_hidden: "rough-skin",
    stat_hp: 108,
    stat_attack: 130,
    stat_defense: 95,
    stat_special_attack: 80,
    stat_special_defense: 85,
    stat_speed: 102,
    base_stat_total: bst({
      hp: 108,
      atk: 130,
      def: 95,
      spa: 80,
      spd: 85,
      spe: 102,
    }),
    sprite_url: "https://img.example/sprite/445.png",
    artwork_url: "https://img.example/art/445.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
  {
    id: "farigiraf",
    species_name: "farigiraf",
    form_name: null,
    display_name: "Farigiraf",
    national_dex_number: 981,
    type1: "normal",
    type2: "psychic",
    ability_slot1: "cud-chew",
    ability_slot2: "armor-tail",
    ability_hidden: "sap-sipper",
    stat_hp: 120,
    stat_attack: 90,
    stat_defense: 70,
    stat_special_attack: 110,
    stat_special_defense: 70,
    stat_speed: 60,
    base_stat_total: bst({
      hp: 120,
      atk: 90,
      def: 70,
      spa: 110,
      spd: 70,
      spe: 60,
    }),
    sprite_url: "https://img.example/sprite/981.png",
    artwork_url: "https://img.example/art/981.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
  {
    // Fire / Flash-Fire mon (G5).
    id: "ninetales",
    species_name: "ninetales",
    form_name: null,
    display_name: "Ninetales",
    national_dex_number: 38,
    type1: "fire",
    type2: null,
    ability_slot1: "flash-fire",
    ability_slot2: null,
    ability_hidden: "drought",
    stat_hp: 73,
    stat_attack: 76,
    stat_defense: 75,
    stat_special_attack: 81,
    stat_special_defense: 100,
    stat_speed: 100,
    base_stat_total: bst({
      hp: 73,
      atk: 76,
      def: 75,
      spa: 81,
      spd: 100,
      spe: 100,
    }),
    sprite_url: "https://img.example/sprite/38.png",
    artwork_url: "https://img.example/art/38.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
  {
    // Non-Gen-9 fallback species (G17 / BR-1) — cut from Scarlet/Violet.
    id: "dracovish",
    species_name: "dracovish",
    form_name: null,
    display_name: "Dracovish",
    national_dex_number: 882,
    type1: "water",
    type2: "dragon",
    ability_slot1: "water-absorb",
    ability_slot2: "strong-jaw",
    ability_hidden: "sand-rush",
    stat_hp: 90,
    stat_attack: 90,
    stat_defense: 100,
    stat_special_attack: 70,
    stat_special_defense: 80,
    stat_speed: 75,
    base_stat_total: bst({
      hp: 90,
      atk: 90,
      def: 100,
      spa: 70,
      spd: 80,
      spe: 75,
    }),
    sprite_url: "https://img.example/sprite/882.png",
    artwork_url: "https://img.example/art/882.png",
    generation: "gen-8",
    is_gen9_native: 0,
    source_generation: "gen-8",
  },
  // --- Tauros forms (D8: one indexed row per battle-relevant form) ---------
  {
    id: "tauros",
    species_name: "tauros",
    form_name: null,
    display_name: "Tauros",
    national_dex_number: 128,
    type1: "normal",
    type2: null,
    ability_slot1: "intimidate",
    ability_slot2: "anger-point",
    ability_hidden: "sheer-force",
    stat_hp: 75,
    stat_attack: 100,
    stat_defense: 95,
    stat_special_attack: 40,
    stat_special_defense: 70,
    stat_speed: 110,
    base_stat_total: bst({
      hp: 75,
      atk: 100,
      def: 95,
      spa: 40,
      spd: 70,
      spe: 110,
    }),
    sprite_url: "https://img.example/sprite/128.png",
    artwork_url: "https://img.example/art/128.png",
    generation: "gen-1",
    is_gen9_native: 0,
    source_generation: "gen-1",
  },
  {
    id: "tauros-paldea-combat",
    species_name: "tauros",
    form_name: "paldea-combat",
    display_name: "Tauros (Paldean Combat)",
    national_dex_number: 128,
    type1: "fighting",
    type2: null,
    ability_slot1: "intimidate",
    ability_slot2: "anger-point",
    ability_hidden: "cud-chew",
    stat_hp: 75,
    stat_attack: 110,
    stat_defense: 105,
    stat_special_attack: 30,
    stat_special_defense: 70,
    stat_speed: 100,
    base_stat_total: bst({
      hp: 75,
      atk: 110,
      def: 105,
      spa: 30,
      spd: 70,
      spe: 100,
    }),
    sprite_url: "https://img.example/sprite/128-combat.png",
    artwork_url: "https://img.example/art/128-combat.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
  {
    id: "tauros-paldea-blaze",
    species_name: "tauros",
    form_name: "paldea-blaze",
    display_name: "Tauros (Paldean Blaze)",
    national_dex_number: 128,
    type1: "fighting",
    type2: "fire",
    ability_slot1: "intimidate",
    ability_slot2: "anger-point",
    ability_hidden: "cud-chew",
    stat_hp: 75,
    stat_attack: 110,
    stat_defense: 105,
    stat_special_attack: 30,
    stat_special_defense: 70,
    stat_speed: 100,
    base_stat_total: bst({
      hp: 75,
      atk: 110,
      def: 105,
      spa: 30,
      spd: 70,
      spe: 100,
    }),
    sprite_url: "https://img.example/sprite/128-blaze.png",
    artwork_url: "https://img.example/art/128-blaze.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
  {
    id: "tauros-paldea-aqua",
    species_name: "tauros",
    form_name: "paldea-aqua",
    display_name: "Tauros (Paldean Aqua)",
    national_dex_number: 128,
    type1: "fighting",
    type2: "water",
    ability_slot1: "intimidate",
    ability_slot2: "anger-point",
    ability_hidden: "cud-chew",
    stat_hp: 75,
    stat_attack: 110,
    stat_defense: 105,
    stat_special_attack: 30,
    stat_special_defense: 70,
    stat_speed: 100,
    base_stat_total: bst({
      hp: 75,
      atk: 110,
      def: 105,
      spa: 30,
      spd: 70,
      spe: 100,
    }),
    sprite_url: "https://img.example/sprite/128-aqua.png",
    artwork_url: "https://img.example/art/128-aqua.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
];

export type LearnsetSeed = {
  pokemon_id: string;
  move_slug: string;
  format: string;
  method: string | null;
};

const SV = "scarlet-violet";

/**
 * Controlled Gen-9 learnsets. Chosen so:
 *   - ONLY Ninetales learns BOTH will-o-wisp AND trick-room  (intersection, G1)
 *   - will-o-wisp learners = { ninetales, tauros-paldea-blaze }
 *   - the fire + flash-fire + will-o-wisp intersection (G5) = { ninetales }
 */
export const LEARNSET_SEED: LearnsetSeed[] = [
  {
    pokemon_id: "garchomp",
    move_slug: "earthquake",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "garchomp",
    move_slug: "dragon-claw",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "garchomp",
    move_slug: "fire-fang",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "ninetales",
    move_slug: "will-o-wisp",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "ninetales",
    move_slug: "trick-room",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "ninetales",
    move_slug: "flamethrower",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "farigiraf",
    move_slug: "trick-room",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "farigiraf",
    move_slug: "psychic",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "tauros-paldea-blaze",
    move_slug: "will-o-wisp",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "tauros-paldea-blaze",
    move_slug: "flame-charge",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-combat",
    move_slug: "close-combat",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-aqua",
    move_slug: "aqua-jet",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros",
    move_slug: "body-slam",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "dracovish",
    move_slug: "fishious-rend",
    format: SV,
    method: "level-up",
  },
];

export type SearchableNameSeed = {
  kind: string;
  slug: string;
  display_name: string;
};

/** Names index backing resolve_entity (T1). */
export const SEARCHABLE_NAMES_SEED: SearchableNameSeed[] = [
  { kind: "pokemon", slug: "garchomp", display_name: "Garchomp" },
  { kind: "pokemon", slug: "farigiraf", display_name: "Farigiraf" },
  { kind: "pokemon", slug: "ninetales", display_name: "Ninetales" },
  { kind: "pokemon", slug: "dracovish", display_name: "Dracovish" },
  { kind: "pokemon", slug: "tauros", display_name: "Tauros" },
  {
    kind: "pokemon",
    slug: "tauros-paldea-combat",
    display_name: "Tauros (Paldean Combat)",
  },
  {
    kind: "pokemon",
    slug: "tauros-paldea-blaze",
    display_name: "Tauros (Paldean Blaze)",
  },
  {
    kind: "pokemon",
    slug: "tauros-paldea-aqua",
    display_name: "Tauros (Paldean Aqua)",
  },
  { kind: "move", slug: "will-o-wisp", display_name: "Will-O-Wisp" },
  { kind: "move", slug: "trick-room", display_name: "Trick Room" },
  { kind: "move", slug: "fake-out", display_name: "Fake Out" },
  { kind: "move", slug: "flamethrower", display_name: "Flamethrower" },
  { kind: "move", slug: "earthquake", display_name: "Earthquake" },
  { kind: "move", slug: "wish", display_name: "Wish" },
  { kind: "ability", slug: "flash-fire", display_name: "Flash Fire" },
  { kind: "ability", slug: "armor-tail", display_name: "Armor Tail" },
  { kind: "ability", slug: "sand-veil", display_name: "Sand Veil" },
  { kind: "ability", slug: "rough-skin", display_name: "Rough Skin" },
  { kind: "ability", slug: "intimidate", display_name: "Intimidate" },
  { kind: "type", slug: "fire", display_name: "Fire" },
  { kind: "type", slug: "ground", display_name: "Ground" },
  { kind: "type", slug: "flying", display_name: "Flying" },
  { kind: "type", slug: "water", display_name: "Water" },
  { kind: "type", slug: "dragon", display_name: "Dragon" },
  { kind: "item", slug: "leftovers", display_name: "Leftovers" },
];

export type ReferenceCacheSeed = {
  resource_key: string;
  resource_kind: string;
  payload: unknown;
  endpoint_url: string;
};

/**
 * Pre-seeded normalized type-chart payloads so get_type_matchups resolves from
 * the cache (a HIT) and never touches PokeAPI in a test. The `ground` payload is
 * verbatim from tools.md T6 — Flying is `no_effect_against` (immune 0x), the
 * G11 oracle.
 */
export const REFERENCE_CACHE_SEED: ReferenceCacheSeed[] = [
  {
    resource_key: "type/ground",
    resource_kind: "type",
    endpoint_url: "https://pokeapi.co/api/v2/type/ground",
    payload: {
      found: true,
      types: ["ground"],
      offensive: {
        super_effective_against: [
          "fire",
          "electric",
          "poison",
          "rock",
          "steel",
        ],
        not_very_effective_against: ["bug", "grass"],
        no_effect_against: ["flying"],
      },
      defensive: {
        weak_to: ["water", "grass", "ice"],
        resists: ["poison", "rock"],
        immune_to: ["electric"],
      },
    },
  },
  {
    resource_key: "type/flying",
    resource_kind: "type",
    endpoint_url: "https://pokeapi.co/api/v2/type/flying",
    payload: {
      found: true,
      types: ["flying"],
      offensive: {
        super_effective_against: ["grass", "fighting", "bug"],
        not_very_effective_against: ["electric", "rock", "steel"],
        no_effect_against: [],
      },
      defensive: {
        weak_to: ["electric", "ice", "rock"],
        resists: ["grass", "fighting", "bug"],
        immune_to: ["ground"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

/**
 * Insert the full fixture into a freshly-migrated Postgres schema via Drizzle.
 * Idempotent on a fresh schema; the caller must supply an empty, migrated handle
 * (typically `createPgSchema({ seed: "tools" })` does this).
 */
export async function seedToolsFixture(db: ToolsFixtureDb): Promise<void> {
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx
      .insert(pokemon)
      .values(POKEMON_SEED.map((p) => ({ ...p, format: SV })));
    await tx.insert(learnset).values(LEARNSET_SEED);
    await tx
      .insert(searchable_names)
      .values(SEARCHABLE_NAMES_SEED.map((n) => ({ ...n, format: SV })));
    await tx.insert(reference_cache).values(
      REFERENCE_CACHE_SEED.map((r) => ({
        format: SV,
        resource_key: r.resource_key,
        resource_kind: r.resource_kind,
        payload: JSON.stringify(r.payload),
        endpoint_url: r.endpoint_url,
        fetched_at: now,
      })),
    );
    await tx.insert(ingest_meta).values({
      format: SV,
      last_success_at: now,
      pokemon_count: POKEMON_SEED.length,
      learnset_count: LEARNSET_SEED.length,
      names_count: SEARCHABLE_NAMES_SEED.length,
      schema_version: "2",
    });
  });
}

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

type LoadedTools = {
  dispatch: (
    name: string,
    args: unknown,
    ctx: AgentContext,
  ) => Promise<unknown>;
  ctx: AgentContext;
};

/**
 * Build the public tool surface against the (already-seeded) singleton DB.
 *
 * `dispatch` comes from the Phase-4 barrel src/agent/tools/index.ts (its public
 * contract). The AgentContext is built via the real factory in
 * src/agent/context.ts when present; if that module/export is not available yet,
 * a minimal ctx (singleton db handle + silent logger) is used so the DB-backed
 * tools that read the shared connection still run.
 *
 * NOTE for the Phase-4 / assembly author: this helper probes a few likely
 * factory names (createAgentContext / buildAgentContext / makeAgentContext /
 * createContext / default). If your factory is named differently, add it to the
 * list — the oracle does not otherwise depend on the factory's internals.
 */
export async function loadToolSurface(): Promise<LoadedTools> {
  const toolsMod = (await import("@/agent/tools")) as {
    dispatch: LoadedTools["dispatch"];
  };

  const ctx = await buildOracleContext();
  return { dispatch: toolsMod.dispatch, ctx };
}

async function buildOracleContext(): Promise<AgentContext> {
  const factoryNames = [
    "createAgentContext",
    "buildAgentContext",
    "makeAgentContext",
    "createContext",
    "default",
  ];

  try {
    const mod = (await import("@/agent/context")) as Record<string, unknown>;
    const factory = factoryNames
      .map((n) => mod[n])
      .find((f): f is (...a: unknown[]) => unknown => typeof f === "function");

    if (factory) {
      for (const args of [[{ requestId: "oracle" }], ["oracle"], []]) {
        try {
          const candidate = await Promise.resolve(
            factory(...(args as unknown[])),
          );
          if (
            candidate &&
            typeof candidate === "object" &&
            "db" in (candidate as Record<string, unknown>)
          ) {
            return candidate as AgentContext;
          }
        } catch {
          // try the next call signature
        }
      }
    }
  } catch {
    // context.ts not present yet — fall through to the minimal ctx
  }

  return buildMinimalContext();
}

async function buildMinimalContext(): Promise<AgentContext> {
  const dbMod = (await import("@/data/db")) as { db: unknown };
  const { default: pino } = await import("pino");
  const logger = pino({ level: "silent" });
  return {
    db: { db: dbMod.db },
    logger,
    requestId: "oracle",
    mode: "standard",
  } as unknown as AgentContext;
}
