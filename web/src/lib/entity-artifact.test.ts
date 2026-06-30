/**
 * Phase 1 — shared contract. Pure Zod: the envelope + per-kind data shapes parse
 * and round-trip; not_found/unavailable variants parse; malformed shapes reject.
 * No DB, no network — this guards the one contract the route and viewer share.
 */

import { describe, it, expect } from "vitest";

import {
  entityArtifactResponseSchema,
  type EntityArtifactResponse,
} from "./entity-artifact";

const OK_POKEMON: EntityArtifactResponse = {
  status: "ok",
  kind: "pokemon",
  format: "scarlet-violet",
  resolved: { slug: "garchomp", display_name: "Garchomp" },
  generation: "Gen 9 (Scarlet/Violet)",
  is_fallback: false,
  citations: [
    { source: "pokemon/garchomp", detail: "Base stats and typing." },
  ],
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
    sprite_url: "https://example/garchomp.png",
    artwork_url: "https://example/garchomp-art.png",
    forms: ["garchomp"],
    is_gen9_native: true,
    matchups: {
      weak_to: ["ice", "dragon", "fairy"],
      resists: ["rock", "fire", "poison", "electric"],
      immune_to: ["electric"],
      // Quad subsets are strict subsets of weak_to / resists.
      quad_weak_to: ["ice"],
      quad_resists: [],
    },
    movepool: [
      {
        method: "level-up",
        moves: [
          { slug: "dragon-claw", display_name: "Dragon Claw", type: "dragon" },
        ],
      },
      {
        method: "machine",
        moves: [
          { slug: "earthquake", display_name: "Earthquake", type: "ground" },
        ],
      },
    ],
  },
};

const OK_MOVE: EntityArtifactResponse = {
  status: "ok",
  kind: "move",
  format: "champions",
  resolved: { slug: "earthquake", display_name: "Earthquake" },
  generation: "Champions — Regulation M-B",
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
    effect_full: "Inflicts regular damage and hits all adjacent Pokémon.",
  },
};

const OK_ABILITY: EntityArtifactResponse = {
  status: "ok",
  kind: "ability",
  format: "scarlet-violet",
  resolved: { slug: "rough-skin", display_name: "Rough Skin" },
  generation: "Gen 9 (Scarlet/Violet)",
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

const OK_ITEM: EntityArtifactResponse = {
  status: "ok",
  kind: "item",
  format: "scarlet-violet",
  resolved: { slug: "leftovers", display_name: "Leftovers" },
  generation: "Gen 9 (Scarlet/Violet)",
  is_fallback: true,
  fallback_note: "No Gen 9 entry; showing latest available data.",
  citations: [{ source: "item/leftovers", detail: "Held item effect." }],
  data: {
    display_name: "Leftovers",
    effect_short: "Restores HP each turn.",
    effect_full: "The holder restores 1/16 of its max HP at the end of each turn.",
  },
};

const OK_TYPE: EntityArtifactResponse = {
  status: "ok",
  kind: "type",
  format: "scarlet-violet",
  resolved: { slug: "ground", display_name: "Ground" },
  generation: "Gen 9 (Scarlet/Violet)",
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
      // A single type never reaches 4× / 0.25×.
      quad_weak_to: [],
      quad_resists: [],
    },
  },
};

describe("entityArtifactResponseSchema — ok envelopes", () => {
  it.each([
    ["pokemon", OK_POKEMON],
    ["move", OK_MOVE],
    ["ability", OK_ABILITY],
    ["item", OK_ITEM],
    ["type", OK_TYPE],
  ])("parses and round-trips an ok %s artifact", (_kind, payload) => {
    const parsed = entityArtifactResponseSchema.parse(payload);
    expect(parsed).toEqual(payload);
  });

  it("discriminates the ok union by kind (data shape follows kind)", () => {
    const parsed = entityArtifactResponseSchema.parse(OK_POKEMON);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok" && parsed.kind === "pokemon") {
      // The pokemon-only fields are present and typed.
      expect(parsed.data.movepool).toHaveLength(2);
      expect(parsed.data.matchups.immune_to).toContain("electric");
      // Quad subsets round-trip and stay strict subsets of weak_to / resists.
      expect(parsed.data.matchups.quad_weak_to).toEqual(["ice"]);
      expect(parsed.data.matchups.quad_resists).toEqual([]);
      for (const t of parsed.data.matchups.quad_weak_to ?? []) {
        expect(parsed.data.matchups.weak_to).toContain(t);
      }
    } else {
      throw new Error("expected an ok pokemon artifact");
    }
  });

  it("accepts an ok pokemon whose matchups omit the optional quad subsets", () => {
    // The quad fields are additive/optional: existing payloads that predate them
    // (no quad_weak_to / quad_resists) must still parse — weak_to / resists /
    // immune_to semantics are unchanged.
    const legacyMatchups = {
      weak_to: ["ice", "dragon", "fairy"],
      resists: ["rock", "fire", "poison", "electric"],
      immune_to: ["electric"],
    };
    const payload = {
      ...OK_POKEMON,
      data: { ...OK_POKEMON.data, matchups: legacyMatchups },
    };
    const parsed = entityArtifactResponseSchema.parse(payload);
    if (parsed.status === "ok" && parsed.kind === "pokemon") {
      expect(parsed.data.matchups.weak_to).toEqual(legacyMatchups.weak_to);
      expect(parsed.data.matchups.quad_weak_to).toBeUndefined();
    } else {
      throw new Error("expected an ok pokemon artifact");
    }
  });
});

describe("entityArtifactResponseSchema — miss variants", () => {
  it("parses a not_found envelope with suggestions", () => {
    const payload: EntityArtifactResponse = {
      status: "not_found",
      kind: "pokemon",
      format: "scarlet-violet",
      query: "garchom",
      suggestions: ["Garchomp"],
    };
    expect(entityArtifactResponseSchema.parse(payload)).toEqual(payload);
  });

  it("parses an unavailable envelope", () => {
    const payload: EntityArtifactResponse = {
      status: "unavailable",
      kind: "move",
      format: "champions",
    };
    expect(entityArtifactResponseSchema.parse(payload)).toEqual(payload);
  });
});

describe("entityArtifactResponseSchema — rejects malformed", () => {
  it("rejects an ok pokemon missing the movepool field", () => {
    const bad = {
      ...OK_POKEMON,
      data: { ...OK_POKEMON.data, movepool: undefined },
    };
    expect(entityArtifactResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const bad = { ...OK_TYPE, kind: "berry" };
    expect(entityArtifactResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const bad = { ...OK_MOVE, status: "weird" };
    expect(entityArtifactResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid format", () => {
    const bad = { ...OK_ITEM, format: "gen1" };
    expect(entityArtifactResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects move data carrying an unexpected damage_class", () => {
    const bad = {
      ...OK_MOVE,
      data: { ...OK_MOVE.data, damage_class: "elemental" },
    };
    expect(entityArtifactResponseSchema.safeParse(bad).success).toBe(false);
  });
});
