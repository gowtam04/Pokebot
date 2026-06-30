/**
 * Unit tests for eval/fixtures/seed-fixture-db.ts
 *
 * Exercises the seeded dataset (createPgSchema({ seed: "eval" })) by querying the
 * seeded tables directly. Uses a REAL migrated Postgres schema (Testcontainers)
 * — no mocks, no live network, no LLM.
 *
 * Test coverage aligns with the eval G-cases and Phase 3/4 verifications:
 *   - Garchomp stats [108,130,95,80,85,102], BST 600 (G9, G15)
 *   - Farigiraf has 3 abilities incl. armor-tail as slot2 (G4)
 *   - Ninetales is Fire/Flash-Fire and learns both trick-room AND will-o-wisp (G1, G5)
 *   - Talonflame has speed > 100 (=126) and learns will-o-wisp (G8)
 *   - Dracovish is is_gen9_native=0 with source_generation="gen-8" (G17/BR-1)
 *   - Four Tauros forms share species_name="tauros" (G18)
 *   - reference_cache/type/ground: flying is in offensive.no_effect_against (G11)
 *   - reference_cache/move/fake-out: priority=3 (G4)
 *   - reference_cache/ability/armor-tail: blocks priority moves (G4)
 *   - searchable_names contains "will-o-wisp" (G3 fuzzy resolve precondition)
 *   - ingest_meta sentinel row is present (queryPokedex availability check)
 *   - G1 multi-move intersection: only ninetales learns both trick-room + will-o-wisp
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ingest_meta,
  learnset,
  pokemon,
  reference_cache,
  searchable_names,
} from "@/data/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

import { createPgSchema, type PgFixture, type PgDb } from "../../test/support/pg";

// One shared, migrated + seeded schema for all read-only tests (no mutation).
let fix: PgFixture;
let db: PgDb;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "eval" });
  db = fix.db;
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

// ===========================================================================
// Ingest-meta sentinel
// ===========================================================================

describe("ingest_meta — availability sentinel", () => {
  it("has exactly one row, for the scarlet-violet format", async () => {
    const rows = await db.select().from(ingest_meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].format).toBe("scarlet-violet");
  });

  it("records schema_version 2", async () => {
    const rows = await db.select().from(ingest_meta);
    expect(rows[0].schema_version).toBe("2");
  });

  it("pokemon_count matches actual rows", async () => {
    const rows = await db.select().from(ingest_meta);
    const actual = (await db.select().from(pokemon)).length;
    expect(rows[0].pokemon_count).toBe(actual);
  });
});

// ===========================================================================
// Pokémon table — key fixture species
// ===========================================================================

describe("pokemon — Garchomp (G9, G15)", () => {
  const getGarchomp = async () =>
    (
      await db.select().from(pokemon).where(eq(pokemon.id, "garchomp")).limit(1)
    )[0];

  it("has the canonical stats [108,130,95,80,85,102] and BST 600", async () => {
    const row = await getGarchomp();
    expect(row).toBeDefined();
    expect([
      row.stat_hp,
      row.stat_attack,
      row.stat_defense,
      row.stat_special_attack,
      row.stat_special_defense,
      row.stat_speed,
    ]).toEqual([108, 130, 95, 80, 85, 102]);
    expect(row.base_stat_total).toBe(600);
  });

  it("is Dragon/Ground", async () => {
    const row = await getGarchomp();
    expect(row.type1).toBe("dragon");
    expect(row.type2).toBe("ground");
  });

  it("abilities: sand-veil (slot1), rough-skin (hidden), no slot2", async () => {
    const row = await getGarchomp();
    expect(row.ability_slot1).toBe("sand-veil");
    expect(row.ability_slot2).toBeNull();
    expect(row.ability_hidden).toBe("rough-skin");
  });

  it("is Gen-9 native", async () => {
    const row = await getGarchomp();
    expect(row.is_gen9_native).toBe(1);
    expect(row.generation).toBe("gen-9");
    expect(row.source_generation).toBeNull();
  });

  it("speed = 102 (feeds into G15 compute_stat → 169 with max EVs + Jolly)", async () => {
    const row = await getGarchomp();
    expect(row.stat_speed).toBe(102);
  });
});

describe("pokemon — Farigiraf (G4)", () => {
  const getFarigiraf = async () =>
    (
      await db.select().from(pokemon).where(eq(pokemon.id, "farigiraf")).limit(1)
    )[0];

  it("has exactly three abilities including armor-tail", async () => {
    const row = await getFarigiraf();
    const abilities = [
      row.ability_slot1,
      row.ability_slot2,
      row.ability_hidden,
    ].filter((a): a is string => a !== null);
    expect(abilities).toHaveLength(3);
    expect(abilities).toContain("armor-tail");
  });

  it("ability slots match PokeAPI order: cud-chew (1), armor-tail (2), sap-sipper (hidden)", async () => {
    const row = await getFarigiraf();
    expect(row.ability_slot1).toBe("cud-chew");
    expect(row.ability_slot2).toBe("armor-tail");
    expect(row.ability_hidden).toBe("sap-sipper");
  });

  it("is Normal/Psychic, BST 520, national dex #981", async () => {
    const row = await getFarigiraf();
    expect(row.type1).toBe("normal");
    expect(row.type2).toBe("psychic");
    expect(row.base_stat_total).toBe(520);
    expect(row.national_dex_number).toBe(981);
  });

  it("is Gen-9 native", async () => {
    const row = await getFarigiraf();
    expect(row.is_gen9_native).toBe(1);
    expect(row.source_generation).toBeNull();
  });
});

describe("pokemon — Ninetales (Fire/Flash-Fire; G1, G5)", () => {
  const getNinetales = async () =>
    (
      await db.select().from(pokemon).where(eq(pokemon.id, "ninetales")).limit(1)
    )[0];

  it("is a Fire-type Pokémon", async () => {
    const row = await getNinetales();
    expect(row.type1).toBe("fire");
    expect(row.type2).toBeNull();
  });

  it("has flash-fire in ability_slot1", async () => {
    const row = await getNinetales();
    expect(row.ability_slot1).toBe("flash-fire");
  });

  it("is Gen-9 native (Indigo Disk DLC)", async () => {
    const row = await getNinetales();
    expect(row.is_gen9_native).toBe(1);
  });
});

describe("pokemon — Talonflame (G8: Fire + speed > 100 + Will-O-Wisp)", () => {
  const getTalonflame = async () =>
    (
      await db
        .select()
        .from(pokemon)
        .where(eq(pokemon.id, "talonflame"))
        .limit(1)
    )[0];

  it("is Fire/Flying", async () => {
    const row = await getTalonflame();
    expect(row.type1).toBe("fire");
    expect(row.type2).toBe("flying");
  });

  it("has base speed > 100 (=126)", async () => {
    const row = await getTalonflame();
    expect(row.stat_speed).toBe(126);
    expect(row.stat_speed).toBeGreaterThan(100);
  });
});

describe("pokemon — Dracovish (G17/BR-1: non-Gen-9 fallback)", () => {
  const getDracovish = async () =>
    (
      await db.select().from(pokemon).where(eq(pokemon.id, "dracovish")).limit(1)
    )[0];

  it("is flagged is_gen9_native=0", async () => {
    const row = await getDracovish();
    expect(row.is_gen9_native).toBe(0);
  });

  it("has source_generation='gen-8'", async () => {
    const row = await getDracovish();
    expect(row.source_generation).toBe("gen-8");
  });

  it("has generation='gen-8' and is Water/Dragon, BST 505", async () => {
    const row = await getDracovish();
    expect(row.generation).toBe("gen-8");
    expect(row.type1).toBe("water");
    expect(row.type2).toBe("dragon");
    expect(row.base_stat_total).toBe(505);
  });
});

describe("pokemon — Tauros forms (G18: ambiguous name disambiguation)", () => {
  const getTaurosRows = async () =>
    db.select().from(pokemon).where(eq(pokemon.species_name, "tauros"));

  it("has exactly four forms with species_name='tauros'", async () => {
    const rows = await getTaurosRows();
    expect(rows).toHaveLength(4);
  });

  it("includes the base Kanto Tauros (id='tauros', Normal type)", async () => {
    const rows = await getTaurosRows();
    const base = rows.find((r) => r.id === "tauros");
    expect(base).toBeDefined();
    expect(base?.type1).toBe("normal");
    expect(base?.type2).toBeNull();
    expect(base?.form_name).toBeNull();
  });

  it("includes tauros-paldea-combat (Fighting mono-type)", async () => {
    const rows = await getTaurosRows();
    const form = rows.find((r) => r.id === "tauros-paldea-combat");
    expect(form).toBeDefined();
    expect(form?.type1).toBe("fighting");
    expect(form?.type2).toBeNull();
    expect(form?.form_name).toBe("paldea-combat");
  });

  it("includes tauros-paldea-blaze (Fighting/Fire)", async () => {
    const rows = await getTaurosRows();
    const form = rows.find((r) => r.id === "tauros-paldea-blaze");
    expect(form).toBeDefined();
    expect(form?.type1).toBe("fighting");
    expect(form?.type2).toBe("fire");
  });

  it("includes tauros-paldea-aqua (Fighting/Water)", async () => {
    const rows = await getTaurosRows();
    const form = rows.find((r) => r.id === "tauros-paldea-aqua");
    expect(form).toBeDefined();
    expect(form?.type1).toBe("fighting");
    expect(form?.type2).toBe("water");
  });

  it("all Tauros forms share national_dex_number=128", async () => {
    const rows = await getTaurosRows();
    expect(rows.every((r) => r.national_dex_number === 128)).toBe(true);
  });

  it("all Tauros forms are Gen-9 native", async () => {
    const rows = await getTaurosRows();
    expect(rows.every((r) => r.is_gen9_native === 1)).toBe(true);
  });
});

// ===========================================================================
// Learnset table — Gen-9 intersection (G1 key scenario)
// ===========================================================================

describe("learnset — Gen-9 multi-move intersection (G1)", () => {
  it("Ninetales learns both will-o-wisp AND trick-room in scarlet-violet", async () => {
    const rows = await db
      .select()
      .from(learnset)
      .where(
        and(
          eq(learnset.pokemon_id, "ninetales"),
          inArray(learnset.move_slug, ["will-o-wisp", "trick-room"]),
          eq(learnset.format, "scarlet-violet"),
        ),
      );
    const slugs = rows.map((r) => r.move_slug).sort();
    expect(slugs).toEqual(["trick-room", "will-o-wisp"]);
  });

  it("intersection of [trick-room, will-o-wisp] returns only ninetales", async () => {
    // Manually reproduce the learnset intersection query
    const rows = await db
      .select({ pokemonId: learnset.pokemon_id })
      .from(learnset)
      .where(
        and(
          inArray(learnset.move_slug, ["trick-room", "will-o-wisp"]),
          eq(learnset.format, "scarlet-violet"),
        ),
      )
      .groupBy(learnset.pokemon_id)
      .having(sql`count(distinct ${learnset.move_slug}) = 2`);
    const ids = rows.map((r) => r.pokemonId);
    expect(ids).toContain("ninetales");
    // Farigiraf only learns trick-room, NOT will-o-wisp, so it's excluded.
    expect(ids).not.toContain("farigiraf");
    // Talonflame only learns will-o-wisp, NOT trick-room, so it's excluded.
    expect(ids).not.toContain("talonflame");
  });

  it("Talonflame learns will-o-wisp but NOT trick-room (correct G8 candidate, not G1)", async () => {
    const wowRow = (
      await db
        .select()
        .from(learnset)
        .where(
          and(
            eq(learnset.pokemon_id, "talonflame"),
            eq(learnset.move_slug, "will-o-wisp"),
            eq(learnset.format, "scarlet-violet"),
          ),
        )
        .limit(1)
    )[0];
    expect(wowRow).toBeDefined();

    const trRow = (
      await db
        .select()
        .from(learnset)
        .where(
          and(
            eq(learnset.pokemon_id, "talonflame"),
            eq(learnset.move_slug, "trick-room"),
            eq(learnset.format, "scarlet-violet"),
          ),
        )
        .limit(1)
    )[0];
    expect(trRow).toBeUndefined();
  });

  it("Dracovish (non-Gen-9) has no learnset entries", async () => {
    const rows = await db
      .select()
      .from(learnset)
      .where(eq(learnset.pokemon_id, "dracovish"));
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Reference cache — pre-normalized detail shapes (DS-4)
// ===========================================================================

async function getRef(key: string) {
  return (
    await db
      .select()
      .from(reference_cache)
      .where(eq(reference_cache.resource_key, key))
      .limit(1)
  )[0];
}

describe("reference_cache — type/ground (G11: immunity)", () => {
  it("has an entry keyed 'type/ground'", async () => {
    const row = await getRef("type/ground");
    expect(row).toBeDefined();
    expect(row.resource_kind).toBe("type");
  });

  it("payload.offensive.no_effect_against contains 'flying' (0× — immune, not resisted)", async () => {
    const row = await getRef("type/ground");
    const payload = JSON.parse(row.payload) as {
      offensive?: { no_effect_against?: string[] };
    };
    expect(payload.offensive?.no_effect_against).toContain("flying");
  });

  it("payload.found = true and types includes 'ground'", async () => {
    const row = await getRef("type/ground");
    const payload = JSON.parse(row.payload) as {
      found: boolean;
      types: string[];
    };
    expect(payload.found).toBe(true);
    expect(payload.types).toContain("ground");
  });

  it("fetched_at is set to a far-future timestamp (never expires in tests)", async () => {
    const row = await getRef("type/ground");
    // Far future: > year 2030 in epoch ms
    expect(row.fetched_at).toBeGreaterThan(1_900_000_000_000);
  });
});

describe("reference_cache — move/fake-out (G4: priority move)", () => {
  it("has an entry keyed 'move/fake-out'", async () => {
    const row = await getRef("move/fake-out");
    expect(row).toBeDefined();
    expect(row.resource_kind).toBe("move");
  });

  it("payload.priority = 3 (positive-priority move blocked by Armor Tail)", async () => {
    const row = await getRef("move/fake-out");
    const payload = JSON.parse(row.payload) as {
      found: boolean;
      priority: number;
      display_name: string;
    };
    expect(payload.found).toBe(true);
    expect(payload.priority).toBe(3);
    expect(payload.display_name).toBe("Fake Out");
  });
});

describe("reference_cache — ability/armor-tail (G4: blocks priority)", () => {
  it("has an entry keyed 'ability/armor-tail'", async () => {
    const row = await getRef("ability/armor-tail");
    expect(row).toBeDefined();
    expect(row.resource_kind).toBe("ability");
  });

  it("payload includes the key effect about blocking positive-priority moves", async () => {
    const row = await getRef("ability/armor-tail");
    const payload = JSON.parse(row.payload) as {
      found: boolean;
      display_name: string;
      effect_short: string;
    };
    expect(payload.found).toBe(true);
    expect(payload.display_name).toBe("Armor Tail");
    // The effect text must mention priority (so the model can reason about G4).
    expect(payload.effect_short.toLowerCase()).toMatch(/priority/);
  });
});

describe("reference_cache — move/will-o-wisp", () => {
  it("has priority = 0 and damage_class = 'status'", async () => {
    const row = await getRef("move/will-o-wisp");
    const payload = JSON.parse(row.payload) as {
      priority: number;
      damage_class: string;
    };
    expect(payload.priority).toBe(0);
    expect(payload.damage_class).toBe("status");
  });
});

describe("reference_cache — ability/flash-fire (G5)", () => {
  it("effect text mentions Fire immunity", async () => {
    const row = await getRef("ability/flash-fire");
    const payload = JSON.parse(row.payload) as { effect_full: string };
    expect(payload.effect_full.toLowerCase()).toMatch(/immune/);
  });
});

// ===========================================================================
// Searchable names — resolve_entity preconditions (G3)
// ===========================================================================

describe("searchable_names — resolve_entity data (G3 precondition)", () => {
  it("contains 'will-o-wisp' as a move slug (G3: fuzzy match must find it)", async () => {
    const row = (
      await db
        .select()
        .from(searchable_names)
        .where(
          and(
            eq(searchable_names.kind, "move"),
            eq(searchable_names.slug, "will-o-wisp"),
          ),
        )
        .limit(1)
    )[0];
    expect(row).toBeDefined();
    expect(row.display_name).toBe("Will-O-Wisp");
  });

  it("contains all 18 type slugs", async () => {
    const rows = await db
      .select()
      .from(searchable_names)
      .where(eq(searchable_names.kind, "type"));
    expect(rows).toHaveLength(18);
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toContain("ground");
    expect(slugs).toContain("flying");
    expect(slugs).toContain("fire");
    expect(slugs).toContain("dragon");
  });

  it("contains all fixture Pokémon as pokemon-kind entries", async () => {
    const rows = await db
      .select()
      .from(searchable_names)
      .where(eq(searchable_names.kind, "pokemon"));
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain("garchomp");
    expect(slugs).toContain("farigiraf");
    expect(slugs).toContain("ninetales");
    expect(slugs).toContain("talonflame");
    expect(slugs).toContain("dracovish");
    expect(slugs).toContain("tauros");
    expect(slugs).toContain("tauros-paldea-combat");
    expect(slugs).toContain("tauros-paldea-blaze");
    expect(slugs).toContain("tauros-paldea-aqua");
  });

  it("contains 'armor-tail' as an ability slug (needed for G4 reference lookups)", async () => {
    const row = (
      await db
        .select()
        .from(searchable_names)
        .where(
          and(
            eq(searchable_names.kind, "ability"),
            eq(searchable_names.slug, "armor-tail"),
          ),
        )
        .limit(1)
    )[0];
    expect(row).toBeDefined();
    expect(row.display_name).toBe("Armor Tail");
  });
});

// ===========================================================================
// G-case coverage cross-checks
// ===========================================================================

describe("G5 precondition — Fire type with flash-fire that learns will-o-wisp", () => {
  it("ninetales is the Fire/Flash-Fire candidate that also learns will-o-wisp in SV", async () => {
    // Verify Fire type
    const mon = (
      await db.select().from(pokemon).where(eq(pokemon.id, "ninetales")).limit(1)
    )[0];
    expect(mon.type1).toBe("fire");
    expect(mon.ability_slot1).toBe("flash-fire");

    // Verify will-o-wisp in learnset
    const learn = (
      await db
        .select()
        .from(learnset)
        .where(
          and(
            eq(learnset.pokemon_id, "ninetales"),
            eq(learnset.move_slug, "will-o-wisp"),
            eq(learnset.format, "scarlet-violet"),
          ),
        )
        .limit(1)
    )[0];
    expect(learn).toBeDefined();
  });
});

describe("G8 precondition — Fire type with speed > 100 that learns will-o-wisp", () => {
  it("talonflame is the Fire-type candidate with speed > 100 that learns will-o-wisp", async () => {
    const mon = (
      await db
        .select()
        .from(pokemon)
        .where(eq(pokemon.id, "talonflame"))
        .limit(1)
    )[0];
    expect(mon.type1).toBe("fire");
    expect(mon.stat_speed).toBeGreaterThan(100);

    const learn = (
      await db
        .select()
        .from(learnset)
        .where(
          and(
            eq(learnset.pokemon_id, "talonflame"),
            eq(learnset.move_slug, "will-o-wisp"),
            eq(learnset.format, "scarlet-violet"),
          ),
        )
        .limit(1)
    )[0];
    expect(learn).toBeDefined();
  });
});

describe("G6 precondition — sort by speed desc", () => {
  it("talonflame has the highest speed in the fixture (126)", async () => {
    const rows = (
      await db
        .select({ id: pokemon.id, speed: pokemon.stat_speed })
        .from(pokemon)
    ).sort((a, b) => b.speed - a.speed);
    expect(rows[0].id).toBe("talonflame");
    expect(rows[0].speed).toBe(126);
  });
});

describe("fixture totals", () => {
  it("has 9 Pokémon rows", async () => {
    expect(await db.select().from(pokemon)).toHaveLength(9);
  });

  it("has 8 reference_cache entries", async () => {
    expect(await db.select().from(reference_cache)).toHaveLength(8);
  });

  it("all base_stat_total values are the arithmetic sum of the six stat columns", async () => {
    const rows = await db.select().from(pokemon);
    for (const row of rows) {
      const expected =
        row.stat_hp +
        row.stat_attack +
        row.stat_defense +
        row.stat_special_attack +
        row.stat_special_defense +
        row.stat_speed;
      expect(row.base_stat_total).toBe(expected);
    }
  });
});
