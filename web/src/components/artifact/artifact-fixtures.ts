/**
 * Plain-object artifact fixtures for the B-4 component tests (mirrors
 * src/components/test-fixtures.ts — no server imports). One `ok` envelope per
 * kind plus the not_found / unavailable variants, all satisfying the shared
 * contract in @/lib/entity-artifact.
 */

import type {
  EntityArtifactNotFound,
  EntityArtifactOkOf,
  EntityArtifactUnavailable,
} from "@/lib/entity-artifact";

export const POKEMON_ARTIFACT: EntityArtifactOkOf<"pokemon"> = {
  status: "ok",
  kind: "pokemon",
  format: "scarlet-violet",
  resolved: { slug: "garchomp", display_name: "Garchomp" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "pokemon/garchomp", detail: "Base stats and typing." }],
  data: {
    display_name: "Garchomp",
    national_dex_number: 445,
    types: ["dragon", "ground"],
    abilities: { slot1: "sand-veil", hidden: "rough-skin" },
    base_stats: {
      hp: 108,
      attack: 130,
      defense: 95,
      special_attack: 80,
      special_defense: 85,
      speed: 102,
    },
    base_stat_total: 600,
    sprite_url: "https://img.example/sprite/445.png",
    artwork_url: "https://img.example/art/445.png",
    forms: ["garchomp"],
    is_gen9_native: true,
    matchups: {
      weak_to: ["ice", "dragon", "fairy"],
      resists: ["fire", "poison", "rock"],
      immune_to: ["electric"],
    },
    movepool: [
      {
        method: "Level-up",
        moves: [
          { slug: "dragon-claw", display_name: "Dragon Claw", type: "dragon" },
          { slug: "fire-fang", display_name: "Fire Fang", type: "fire" },
        ],
      },
      {
        method: "TM/HM",
        moves: [
          { slug: "earthquake", display_name: "Earthquake", type: "ground" },
        ],
      },
    ],
  },
};

/** A fallback Pokémon (non-native) — drives the CaveatStrip fallback banner. */
export const POKEMON_ARTIFACT_FALLBACK: EntityArtifactOkOf<"pokemon"> = {
  ...POKEMON_ARTIFACT,
  resolved: { slug: "dracovish", display_name: "Dracovish" },
  is_fallback: true,
  fallback_note: "Not native to Scarlet/Violet; showing gen-8 data.",
  data: {
    ...POKEMON_ARTIFACT.data,
    display_name: "Dracovish",
    national_dex_number: 882,
    is_gen9_native: false,
    source_generation: "gen-8",
  },
};

export const MOVE_ARTIFACT: EntityArtifactOkOf<"move"> = {
  status: "ok",
  kind: "move",
  format: "scarlet-violet",
  resolved: { slug: "earthquake", display_name: "Earthquake" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "move/earthquake", detail: "Power, accuracy, PP." }],
  data: {
    display_name: "Earthquake",
    type: "ground",
    damage_class: "physical",
    power: 100,
    accuracy: 100,
    pp: 10,
    priority: 0,
    target: "all-other-pokemon",
    effect_short: "Hits all adjacent Pokémon.",
    effect_full: "Inflicts regular damage; hits all adjacent Pokémon.",
  },
};

export const ABILITY_ARTIFACT: EntityArtifactOkOf<"ability"> = {
  status: "ok",
  kind: "ability",
  format: "scarlet-violet",
  resolved: { slug: "rough-skin", display_name: "Rough Skin" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "ability/rough-skin", detail: "Effect text." }],
  data: {
    display_name: "Rough Skin",
    effect_short: "Damages attackers on contact.",
    effect_full: "Damages attacking Pokémon for 1/8 max HP on contact.",
    learned_by: [
      { slug: "garchomp", display_name: "Garchomp" },
      { slug: "gible", display_name: "Gible" },
    ],
  },
};

export const ITEM_ARTIFACT: EntityArtifactOkOf<"item"> = {
  status: "ok",
  kind: "item",
  format: "scarlet-violet",
  resolved: { slug: "leftovers", display_name: "Leftovers" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "item/leftovers", detail: "Held-item effect." }],
  data: {
    display_name: "Leftovers",
    effect_short: "Restores HP each turn.",
    effect_full: "The holder restores 1/16 max HP at the end of each turn.",
  },
};

export const TYPE_ARTIFACT: EntityArtifactOkOf<"type"> = {
  status: "ok",
  kind: "type",
  format: "scarlet-violet",
  resolved: { slug: "ground", display_name: "Ground" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "type/ground", detail: "Type chart." }],
  data: {
    types: ["ground"],
    offensive: {
      super_effective_against: ["fire", "electric", "poison", "rock", "steel"],
      not_very_effective_against: ["bug", "grass"],
      no_effect_against: ["flying"],
    },
    defensive: {
      weak_to: ["water", "grass", "ice"],
      resists: ["poison", "rock"],
      immune_to: ["electric"],
    },
  },
};

export const NOT_FOUND_ARTIFACT: EntityArtifactNotFound = {
  status: "not_found",
  kind: "pokemon",
  format: "scarlet-violet",
  query: "garchom",
  suggestions: ["Garchomp"],
};

export const UNAVAILABLE_ARTIFACT: EntityArtifactUnavailable = {
  status: "unavailable",
  kind: "pokemon",
  format: "champions",
};
