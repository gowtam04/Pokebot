/**
 * Unit tests for the DS-2 Pokédex-row transform (build-pokedex), @pkmn-backed.
 *
 * After the migration `buildPokemonRow(specie, format)` consumes a real @pkmn
 * `Specie` (deterministic local data from `Dex.forGen(9)`), and
 * `buildPokedex({ format, roster })` applies the D8 forms rule. Expected values
 * are @pkmn ground truth (cross-checked: Garchomp BST 600, Farigiraf's three
 * abilities incl. Armor Tail, Dracovish's non-SV fallback).
 *
 * Fully offline — @pkmn ships its dex data as a local npm package.
 */

import { Dex } from "@pkmn/dex";
import { describe, expect, it } from "vitest";

import type { Format } from "@/data/formats";
import type { PkmnSpecies } from "@/data/pkmn/gen-provider";
import { buildPokemonRow, buildPokedex, type PokemonRow } from "./build-pokedex";

const g = Dex.forGen(9);
const SV: Format = "scarlet-violet";

function row(name: string, format: Format = SV): PokemonRow {
  return buildPokemonRow(g.species.get(name), format);
}

describe("buildPokemonRow — Garchomp (stats + types + BST)", () => {
  const r = row("garchomp");

  it("carries the canonical id, species and national dex number", () => {
    expect(r.id).toBe("garchomp");
    expect(r.species_name).toBe("garchomp");
    expect(r.form_name).toBeNull();
    expect(r.national_dex_number).toBe(445);
    expect(r.display_name.toLowerCase()).toContain("garchomp");
  });

  it("maps the six base stats in canonical order [108,130,95,80,85,102]", () => {
    expect([
      r.stat_hp,
      r.stat_attack,
      r.stat_defense,
      r.stat_special_attack,
      r.stat_special_defense,
      r.stat_speed,
    ]).toEqual([108, 130, 95, 80, 85, 102]);
  });

  it("precomputes BST = 600 (sum of the six stats)", () => {
    expect(r.base_stat_total).toBe(600);
    expect(r.base_stat_total).toBe(
      r.stat_hp +
        r.stat_attack +
        r.stat_defense +
        r.stat_special_attack +
        r.stat_special_defense +
        r.stat_speed,
    );
  });

  it("orders types by slot (Dragon/Ground), lower-cased", () => {
    expect(r.type1).toBe("dragon");
    expect(r.type2).toBe("ground");
  });

  it("maps abilities by slot, hidden into ability_hidden, absent slot → null", () => {
    expect(r.ability_slot1).toBe("sand-veil");
    expect(r.ability_slot2).toBeNull();
    expect(r.ability_hidden).toBe("rough-skin");
  });

  it("derives the front sprite and official-artwork URLs from the dex number", () => {
    expect(r.sprite_url).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/445.png",
    );
    expect(r.artwork_url).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/445.png",
    );
  });

  it("is Gen-9 native (not a fallback), no source_generation", () => {
    expect(r.is_gen9_native).toBe(1);
    expect(r.generation).toBe("gen-9");
    expect(r.source_generation).toBeNull();
  });
});

describe("buildPokemonRow — Farigiraf (3 abilities incl. armor-tail)", () => {
  const r = row("farigiraf");

  it("has exactly three abilities including armor-tail", () => {
    const abilities = [
      r.ability_slot1,
      r.ability_slot2,
      r.ability_hidden,
    ].filter((a): a is string => a !== null);
    expect(abilities).toHaveLength(3);
    expect(abilities).toContain("armor-tail");
  });

  it("places the abilities in the correct slots", () => {
    // @pkmn slot order: Cud Chew (0), Armor Tail (1), Sap Sipper (H)
    expect(r.ability_slot1).toBe("cud-chew");
    expect(r.ability_slot2).toBe("armor-tail");
    expect(r.ability_hidden).toBe("sap-sipper");
  });

  it("is a Normal/Psychic Gen-9 native with national dex 981, BST 520", () => {
    expect(r.type1).toBe("normal");
    expect(r.type2).toBe("psychic");
    expect(r.national_dex_number).toBe(981);
    expect(r.base_stat_total).toBe(520);
    expect(r.is_gen9_native).toBe(1);
    expect(r.source_generation).toBeNull();
  });
});

describe("buildPokemonRow — Dracovish (non-SV fallback, BR-1)", () => {
  const r = row("dracovish");

  it("is flagged is_gen9_native=0 with a source_generation (cut from SV)", () => {
    // Dracovish is isNonstandard "Past" in Gen 9 → a Gen-8 fallback.
    expect(r.is_gen9_native).toBe(0);
    expect(r.source_generation).toBe("gen-8");
  });

  it("still builds a complete, valid row (Water/Dragon, BST 505)", () => {
    expect(r.id).toBe("dracovish");
    expect(r.national_dex_number).toBe(882);
    expect(r.type1).toBe("water");
    expect(r.type2).toBe("dragon");
    expect(r.base_stat_total).toBe(505);
  });
});

describe("buildPokemonRow — Champions format (BR-1: every indexed species is legal)", () => {
  it("flags is_gen9_native=1 / source_generation=null even for a 'Past' species", () => {
    const r = row("dracovish", "champions");
    expect(r.format).toBe("champions");
    expect(r.generation).toBe("champions");
    expect(r.is_gen9_native).toBe(1);
    expect(r.source_generation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPokedex — D8 forms rule
// ---------------------------------------------------------------------------

/** Build a minimal @pkmn-shaped Specie for the D8 grouping logic. */
function fakeSpecies(p: {
  id: string;
  name: string;
  baseSpecies?: string;
  forme?: string;
  num: number;
  types: string[];
  abilities: Record<string, string>;
  stats: [number, number, number, number, number, number];
}): PkmnSpecies {
  const [hp, atk, def, spa, spd, spe] = p.stats;
  return {
    id: p.id,
    name: p.name,
    baseSpecies: p.baseSpecies ?? p.name,
    forme: p.forme ?? "",
    num: p.num,
    types: p.types,
    abilities: p.abilities,
    baseStats: { hp, atk, def, spa, spd, spe },
    isNonstandard: null,
    gen: 9,
  } as unknown as PkmnSpecies;
}

describe("buildPokedex — D8 forms collapse", () => {
  // A base form, a purely-cosmetic forme (identical type/stats/abilities), and a
  // battle-relevant forme (different typing). All share one national dex number.
  const base = fakeSpecies({
    id: "fakemon",
    name: "Fakemon",
    num: 9999,
    types: ["Water"],
    abilities: { 0: "Torrent" },
    stats: [70, 70, 70, 70, 70, 70],
  });
  const cosmetic = fakeSpecies({
    id: "fakemoncosplay",
    name: "Fakemon-Cosplay",
    baseSpecies: "Fakemon",
    forme: "Cosplay",
    num: 9999,
    types: ["Water"],
    abilities: { 0: "Torrent" },
    stats: [70, 70, 70, 70, 70, 70],
  });
  const battle = fakeSpecies({
    id: "fakemonblaze",
    name: "Fakemon-Blaze",
    baseSpecies: "Fakemon",
    forme: "Blaze",
    num: 9999,
    types: ["Fire"], // different typing → battle-relevant
    abilities: { 0: "Torrent" },
    stats: [70, 70, 70, 70, 70, 70],
  });

  it("keeps the base + battle-relevant forme and drops the cosmetic forme", () => {
    const rows = buildPokedex({ format: SV, roster: [base, cosmetic, battle] });
    const ids = rows.map((r) => r.id).sort();
    // id is slugFor(s.id, s.name) → slugify(name); "Fakemon-Blaze" → "fakemon-blaze".
    expect(ids).toEqual(["fakemon", "fakemon-blaze"]);
  });

  it("stamps the requested format on every row", () => {
    const rows = buildPokedex({ format: SV, roster: [base, battle] });
    expect(rows.every((r) => r.format === SV)).toBe(true);
  });

  it("dedupes by id within the roster", () => {
    const rows = buildPokedex({ format: SV, roster: [base, base] });
    expect(rows).toHaveLength(1);
  });
});
