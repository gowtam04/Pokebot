/**
 * eval/fixtures/seed-fixture-db.ts
 *
 * Builds a small, deterministic SQLite fixture database used by eval and
 * integration tests (design.md § Testing Strategy):
 *
 *   "eval/fixtures/seed-fixture-db.ts — builds a small deterministic SQLite
 *    fixture for evals/tests"
 *
 * Curated species set (design.md § Testing Strategy + evaluation.md G-cases):
 *   - Garchomp        — Dragon/Ground, BST 600, Gen-9 native (G9, G15)
 *   - Farigiraf       — Normal/Psychic, 3 abilities incl. Armor Tail (G4)
 *   - Ninetales       — Fire, Flash Fire + Drought, learns Will-O-Wisp + Trick
 *                       Room in SV — satisfies G1 (intersection) and G5
 *                       (Fire/Flash-Fire/Will-O-Wisp filter)
 *   - Talonflame      — Fire/Flying, speed 126 > 100, learns Will-O-Wisp (G8)
 *   - Dracovish       — Water/Dragon, is_gen9_native=0, gen-8 fallback (G17)
 *   - Tauros (×4)     — Kanto + Paldean Combat/Blaze/Aqua forms (G18)
 *
 * reference_cache entries (pre-normalized to exact tool-output shapes):
 *   - type/ground         — G11: Flying is immune (0×) to Ground
 *   - move/fake-out       — G4: priority = 3
 *   - ability/armor-tail  — G4: blocks positive-priority moves
 *   - move/will-o-wisp    — G1/G2/G5: move details
 *   - ability/flash-fire  — G5: ability details
 *   - move/trick-room     — G1: move details
 *
 * searchable_names rows (for resolve_entity / G3 fuzzy resolution):
 *   - All Pokémon in the fixture
 *   - All moves used in learnsets + reference cache
 *   - All abilities carried by the fixture Pokémon
 *   - All 18 type slugs
 *
 * Exports:
 *   - seedFixtureDb(db)   — seed an already-migrated Drizzle handle (async)
 *
 * To get a ready-to-use seeded database, call
 * `createPgSchema({ seed: "eval" })` from test/support/pg.ts (it migrates an
 * isolated Postgres schema and calls `seedFixtureDb` for you).
 *
 * Module-boundary rules:
 *   - Does NOT import "server-only" (not a Next.js module).
 *   - Does NOT import @/data/db (which has server-only + Next.js wiring).
 *   - node-postgres is asynchronous — seeding is awaited.
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
import { TYPE_NAMES } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Drizzle handle typed over the full Oak schema (node-postgres). */
export type FixtureDb = NodePgDatabase<typeof schema>;

// ===========================================================================
// Fixture data
// ===========================================================================

/** Every fixture row is the standard (Scarlet-Violet) data scope. */
const SV = "scarlet-violet";

// ---------------------------------------------------------------------------
// 1. Pokémon rows — pokemon table (DS-2)
// ---------------------------------------------------------------------------
// The `format` discriminator is identical for every fixture row, so it is
// injected at insert time (seedFixtureDb) rather than repeated on each literal.

type PokemonRow = typeof pokemon.$inferInsert;

const POKEMON_ROWS: Omit<PokemonRow, "format">[] = [
  // ── Garchomp (National Dex #445) ─────────────────────────────────────────
  // Dragon/Ground, BST 600. Key for G9 (full profile) and G15 (speed stat).
  // "Garchomp stats [108,130,95,80,85,102], BST 600" (Phase 3 test spec).
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
    base_stat_total: 600, // 108+130+95+80+85+102
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/445.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/445.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Farigiraf (National Dex #981) ────────────────────────────────────────
  // Normal/Psychic, BST 520, three abilities incl. Armor Tail (slot2).
  // Key for G4 (Fake Out conditional answer): "does Fake Out work on Farigiraf?"
  // Ability slot order matches PokeAPI: cud-chew (1), armor-tail (2), sap-sipper (hidden).
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
    base_stat_total: 520, // 120+90+70+110+70+60
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/981.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/981.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Ninetales (National Dex #38) ─────────────────────────────────────────
  // Fire (mono-type), Flash Fire ability, BST 505.
  // Key for:
  //   G1 — learns both Trick Room + Will-O-Wisp (the intersection result)
  //   G5 — Fire type with Flash Fire that learns Will-O-Wisp
  //   G19 — follow-up "now only the Fire types" from G1 results
  // Available in SV via The Indigo Disk DLC → is_gen9_native = 1.
  {
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
    base_stat_total: 505, // 73+76+75+81+100+100
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/38.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/38.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Talonflame (National Dex #663) ───────────────────────────────────────
  // Fire/Flying, speed 126 (>100), learns Will-O-Wisp in SV.
  // Key for G8 — "Fire types with base Speed over 100 that can learn Will-O-Wisp".
  // Also satisfies the combined type+stat+move filter efficiency test.
  {
    id: "talonflame",
    species_name: "talonflame",
    form_name: null,
    display_name: "Talonflame",
    national_dex_number: 663,
    type1: "fire",
    type2: "flying",
    ability_slot1: "flame-body",
    ability_slot2: null,
    ability_hidden: "gale-wings",
    stat_hp: 78,
    stat_attack: 81,
    stat_defense: 71,
    stat_special_attack: 74,
    stat_special_defense: 69,
    stat_speed: 126,
    base_stat_total: 499, // 78+81+71+74+69+126
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/663.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/663.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Dracovish (National Dex #882) ────────────────────────────────────────
  // Water/Dragon, Gen-8 only (cut from SV). Non-Gen-9 fallback (BR-1).
  // Key for G17 — "A Pokémon not native to Gen 9": must show
  //   is_gen9_native=false + source_generation set.
  {
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
    base_stat_total: 505, // 90+90+100+70+80+75
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/882.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/882.png",
    generation: "gen-8",
    is_gen9_native: 0,
    source_generation: "gen-8",
  },

  // ── Tauros — Kanto form (National Dex #128) ───────────────────────────────
  // Normal (mono), available via The Indigo Disk DLC → is_gen9_native = 1.
  // Key for G18 — "Tauros" (ambiguous): four forms share species_name="tauros".
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
    base_stat_total: 490, // 75+100+95+40+70+110
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/128.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/128.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Tauros (Paldean Combat) — Fighting (National Dex #128) ───────────────
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
    base_stat_total: 490, // 75+110+105+30+70+100
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10250.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/10250.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Tauros (Paldean Blaze) — Fighting/Fire (National Dex #128) ───────────
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
    base_stat_total: 490,
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10251.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/10251.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },

  // ── Tauros (Paldean Aqua) — Fighting/Water (National Dex #128) ───────────
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
    base_stat_total: 490,
    sprite_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10252.png",
    artwork_url:
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/10252.png",
    generation: "gen-9",
    is_gen9_native: 1,
    source_generation: null,
  },
];

// ---------------------------------------------------------------------------
// 2. Learnset rows — learnset table (DS-3, Gen-9, format=scarlet-violet)
// ---------------------------------------------------------------------------
// Dracovish has no entries — it's not Gen-9 native (no SV learnset).
// All other Gen-9 native Pokémon carry their key moves.

type LearnsetRow = typeof learnset.$inferInsert;

const LEARNSET_ROWS: LearnsetRow[] = [
  // Garchomp — core Dragon/Ground moves
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
    method: "machine",
  },

  // Farigiraf — Psychic/Normal moves; learns Trick Room (TM81) but NOT Will-O-Wisp
  {
    pokemon_id: "farigiraf",
    move_slug: "trick-room",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "farigiraf",
    move_slug: "hyper-voice",
    format: SV,
    method: "machine",
  },

  // Ninetales — learns BOTH trick-room (TM81) AND will-o-wisp (TM) in SV.
  // This is the key G1 intersection result (learns both moves) and G5 candidate
  // (Fire type with Flash Fire ability that learns Will-O-Wisp).
  {
    pokemon_id: "ninetales",
    move_slug: "will-o-wisp",
    format: SV,
    method: "machine",
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

  // Talonflame — Fire/Flying with speed 126; learns Will-O-Wisp (G8 candidate)
  {
    pokemon_id: "talonflame",
    move_slug: "will-o-wisp",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "talonflame",
    move_slug: "brave-bird",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "talonflame",
    move_slug: "flare-blitz",
    format: SV,
    method: "level-up",
  },

  // Tauros (Kanto) — Normal-type physical moves
  {
    pokemon_id: "tauros",
    move_slug: "tackle",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros",
    move_slug: "horn-attack",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros",
    move_slug: "work-up",
    format: SV,
    method: "machine",
  },

  // Tauros Paldean Combat — Fighting moves
  {
    pokemon_id: "tauros-paldea-combat",
    move_slug: "close-combat",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-combat",
    move_slug: "bulk-up",
    format: SV,
    method: "machine",
  },
  {
    pokemon_id: "tauros-paldea-combat",
    move_slug: "protect",
    format: SV,
    method: "machine",
  },

  // Tauros Paldean Blaze — Fighting/Fire moves
  {
    pokemon_id: "tauros-paldea-blaze",
    move_slug: "flare-blitz",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-blaze",
    move_slug: "close-combat",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-blaze",
    move_slug: "protect",
    format: SV,
    method: "machine",
  },

  // Tauros Paldean Aqua — Fighting/Water moves
  {
    pokemon_id: "tauros-paldea-aqua",
    move_slug: "liquidation",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-aqua",
    move_slug: "close-combat",
    format: SV,
    method: "level-up",
  },
  {
    pokemon_id: "tauros-paldea-aqua",
    move_slug: "protect",
    format: SV,
    method: "machine",
  },
];

// ---------------------------------------------------------------------------
// 3. Reference cache entries — reference_cache table (DS-4)
// ---------------------------------------------------------------------------
// Pre-normalized to the exact tool-output shapes (tools.md T4–T8 + schemas.ts).
// These are the same shapes that build-reference.ts writes at ingest and that
// reference-cache.ts (getReference) reads back.

type RefCacheRow = typeof reference_cache.$inferInsert;

// Far-future timestamp (year 2040). `fetched_at` is informational now (no TTL
// since reference detail is pre-built locally), but a stable far-future value
// keeps the fixture deterministic.
const FAR_FUTURE_MS = 2_208_992_400_000;

const REFERENCE_CACHE_ROWS: Omit<RefCacheRow, "format">[] = [
  // type/ground — G11: "is Ground super effective against Flying?"
  // → answer is "No — Flying is immune (0×)"; flying must be in no_effect_against.
  {
    resource_key: "type/ground",
    resource_kind: "type",
    payload: JSON.stringify({
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
    }),
    endpoint_url: "https://pokeapi.co/api/v2/type/ground",
    fetched_at: FAR_FUTURE_MS,
  },

  // move/fake-out — G4: "does Fake Out work on Farigiraf?"
  // priority = 3 (positive-priority move, blocked by Armor Tail).
  {
    resource_key: "move/fake-out",
    resource_kind: "move",
    payload: JSON.stringify({
      found: true,
      display_name: "Fake Out",
      type: "normal",
      damage_class: "physical",
      power: 40,
      accuracy: 100,
      pp: 10,
      priority: 3,
      target: "selected-pokemon",
      effect_short:
        "Hits first (priority +3) and makes the target flinch; only works on the user's first turn out.",
      effect_full:
        "Inflicts regular damage. Has +3 priority. The target flinches. Only succeeds on the first turn after the user switches in.",
    }),
    endpoint_url: "https://pokeapi.co/api/v2/move/fake-out",
    fetched_at: FAR_FUTURE_MS,
  },

  // ability/armor-tail — G4: Armor Tail negates positive-priority moves (Fake Out).
  {
    resource_key: "ability/armor-tail",
    resource_kind: "ability",
    payload: JSON.stringify({
      found: true,
      display_name: "Armor Tail",
      effect_short:
        "Prevents the holder from being hit by moves with increased priority.",
      effect_full:
        "The Pokémon and its allies cannot be targeted by opposing moves that have positive priority (e.g. Fake Out, Quick Attack, Extreme Speed).",
    }),
    endpoint_url: "https://pokeapi.co/api/v2/ability/armor-tail",
    fetched_at: FAR_FUTURE_MS,
  },

  // move/will-o-wisp — G1/G2/G5: move details for Will-O-Wisp.
  {
    resource_key: "move/will-o-wisp",
    resource_kind: "move",
    payload: JSON.stringify({
      found: true,
      display_name: "Will-O-Wisp",
      type: "fire",
      damage_class: "status",
      power: null,
      accuracy: 85,
      pp: 15,
      priority: 0,
      target: "selected-pokemon",
      effect_short: "Burns the target.",
      effect_full:
        "Burns the target. The burn status condition deals 1/16 max HP damage each turn and halves the target's Attack.",
    }),
    endpoint_url: "https://pokeapi.co/api/v2/move/will-o-wisp",
    fetched_at: FAR_FUTURE_MS,
  },

  // ability/flash-fire — G5: Flash Fire grants Fire immunity.
  {
    resource_key: "ability/flash-fire",
    resource_kind: "ability",
    payload: JSON.stringify({
      found: true,
      display_name: "Flash Fire",
      effect_short:
        "Grants immunity to Fire-type moves and boosts this Pokémon's Fire moves after being hit by one.",
      effect_full:
        "This Pokémon is immune to Fire-type moves. The first time it's hit by a Fire-type move, its own Fire-type moves will do 1.5× as much damage until it leaves the field.",
    }),
    endpoint_url: "https://pokeapi.co/api/v2/ability/flash-fire",
    fetched_at: FAR_FUTURE_MS,
  },

  // move/trick-room — G1 details (priority -7, slower moves first).
  {
    resource_key: "move/trick-room",
    resource_kind: "move",
    payload: JSON.stringify({
      found: true,
      display_name: "Trick Room",
      type: "psychic",
      damage_class: "status",
      power: null,
      accuracy: null,
      pp: 5,
      priority: -7,
      target: "entire-field",
      effect_short:
        "For 5 turns, slower Pokémon move first. Fails if Trick Room is already up.",
      effect_full:
        "For five turns, the order in which Pokémon attack changes. Pokémon that normally act last will now act first. This move has -7 priority.",
    }),
    endpoint_url: "https://pokeapi.co/api/v2/move/trick-room",
    fetched_at: FAR_FUTURE_MS,
  },

  // encounters/garchomp — T14 get_encounters: a grouped HIT (catch-location data).
  {
    resource_key: "encounters/garchomp",
    resource_kind: "encounters",
    payload: JSON.stringify({
      found: true,
      name: "Garchomp",
      encounters: [
        {
          version_group: "sword-shield",
          generation: 8,
          versions: ["shield", "sword"],
          locations: [
            {
              location_display: "Lake of Outrage",
              region: "Galar",
              method: "walk",
              min_level: 55,
              max_level: 60,
              chance: 5,
              conditions: [],
            },
          ],
        },
      ],
      coverage_note: null,
    }),
    endpoint_url: "https://pokeapi.co",
    fetched_at: FAR_FUTURE_MS,
  },

  // encounters/dracovish — T14: known-but-empty (no recorded catch data).
  {
    resource_key: "encounters/dracovish",
    resource_kind: "encounters",
    payload: JSON.stringify({
      found: true,
      name: "Dracovish",
      encounters: [],
      coverage_note:
        "PokeAPI records no catch/encounter data for this Pokémon. Obtain it by evolution, breeding, in-game trade, or events.",
    }),
    endpoint_url: "https://pokeapi.co",
    fetched_at: FAR_FUTURE_MS,
  },
];

// ---------------------------------------------------------------------------
// 4. Searchable names — searchable_names table (backs resolve_entity / T1)
// ---------------------------------------------------------------------------
// G3: "Will-o-Whisp" (misspelled) must resolve to slug "will-o-wisp".
// This requires the move entry to be present in searchable_names.

type SearchableRow = typeof searchable_names.$inferInsert;

// Pokémon
const POKEMON_NAMES: Omit<SearchableRow, "format">[] = POKEMON_ROWS.map((p) => ({
  kind: "pokemon" as const,
  slug: p.id,
  display_name: p.display_name,
}));

// Moves — all moves referenced in learnsets + reference cache
const MOVE_SLUGS: Array<[string, string]> = [
  ["will-o-wisp", "Will-O-Wisp"],
  ["trick-room", "Trick Room"],
  ["fake-out", "Fake Out"],
  ["earthquake", "Earthquake"],
  ["dragon-claw", "Dragon Claw"],
  ["fire-fang", "Fire Fang"],
  ["hyper-voice", "Hyper Voice"],
  ["flamethrower", "Flamethrower"],
  ["brave-bird", "Brave Bird"],
  ["flare-blitz", "Flare Blitz"],
  ["tackle", "Tackle"],
  ["horn-attack", "Horn Attack"],
  ["work-up", "Work Up"],
  ["close-combat", "Close Combat"],
  ["bulk-up", "Bulk Up"],
  ["protect", "Protect"],
  ["liquidation", "Liquidation"],
];
const MOVE_NAMES: Omit<SearchableRow, "format">[] = MOVE_SLUGS.map(
  ([slug, display_name]) => ({
    kind: "move" as const,
    slug,
    display_name,
  }),
);

// Abilities — all abilities carried by fixture Pokémon + reference cache entries
const ABILITY_SLUGS: Array<[string, string]> = [
  ["sand-veil", "Sand Veil"],
  ["rough-skin", "Rough Skin"],
  ["cud-chew", "Cud Chew"],
  ["armor-tail", "Armor Tail"],
  ["sap-sipper", "Sap Sipper"],
  ["flash-fire", "Flash Fire"],
  ["drought", "Drought"],
  ["flame-body", "Flame Body"],
  ["gale-wings", "Gale Wings"],
  ["water-absorb", "Water Absorb"],
  ["strong-jaw", "Strong Jaw"],
  ["sand-rush", "Sand Rush"],
  ["intimidate", "Intimidate"],
  ["anger-point", "Anger Point"],
  ["sheer-force", "Sheer Force"],
];
const ABILITY_NAMES: Omit<SearchableRow, "format">[] = ABILITY_SLUGS.map(
  ([slug, display_name]) => ({
    kind: "ability" as const,
    slug,
    display_name,
  }),
);

// Types — all 18 canonical slugs; also needed for type-filter validation in queryPokedex
const TYPE_NAMES_DISPLAY: Record<string, string> = {
  normal: "Normal",
  fire: "Fire",
  water: "Water",
  electric: "Electric",
  grass: "Grass",
  ice: "Ice",
  fighting: "Fighting",
  poison: "Poison",
  ground: "Ground",
  flying: "Flying",
  psychic: "Psychic",
  bug: "Bug",
  rock: "Rock",
  ghost: "Ghost",
  dragon: "Dragon",
  dark: "Dark",
  steel: "Steel",
  fairy: "Fairy",
};
const TYPE_NAME_ROWS: Omit<SearchableRow, "format">[] = TYPE_NAMES.map(
  (slug) => ({
    kind: "type" as const,
    slug,
    display_name: TYPE_NAMES_DISPLAY[slug] ?? slug,
  }),
);

const SEARCHABLE_NAME_ROWS: Omit<SearchableRow, "format">[] = [
  ...POKEMON_NAMES,
  ...MOVE_NAMES,
  ...ABILITY_NAMES,
  ...TYPE_NAME_ROWS,
];

// ---------------------------------------------------------------------------
// 5. Ingest meta — ingest_meta table (index availability sentinel)
// ---------------------------------------------------------------------------

const INGEST_META_ROW: typeof ingest_meta.$inferInsert = {
  format: SV,
  last_success_at: Date.now(),
  pokemon_count: POKEMON_ROWS.length,
  learnset_count: LEARNSET_ROWS.length,
  names_count: SEARCHABLE_NAME_ROWS.length,
  schema_version: "2",
};

// ===========================================================================
// Seed function
// ===========================================================================

/**
 * Seed an already-migrated Drizzle handle with all fixture rows.
 *
 * Expects a fresh / empty schema (callers use `createPgSchema({ seed: "eval" })`
 * which migrates an isolated schema first). node-postgres is asynchronous, so
 * this is async and wraps the inserts in one transaction.
 */
export async function seedFixtureDb(db: FixtureDb): Promise<void> {
  // Every fixture row is the standard scope; stamp `format` on insert.
  await db.transaction(async (tx) => {
    await tx
      .insert(pokemon)
      .values(POKEMON_ROWS.map((r) => ({ ...r, format: SV })));
    await tx.insert(learnset).values(LEARNSET_ROWS);
    await tx
      .insert(reference_cache)
      .values(REFERENCE_CACHE_ROWS.map((r) => ({ ...r, format: SV })));
    await tx
      .insert(searchable_names)
      .values(SEARCHABLE_NAME_ROWS.map((r) => ({ ...r, format: SV })));
    await tx.insert(ingest_meta).values(INGEST_META_ROW);
  });
}
