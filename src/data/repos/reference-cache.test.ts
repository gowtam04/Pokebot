/**
 * Unit tests for the DS-4 reference reader (getReference).
 *
 * Since the @pkmn migration this is a PURE DB READ — reference detail is
 * pre-built per format at ingest (build-reference.ts), so there is no upstream,
 * no client, and no TTL. `getReference(kind, slug, format, { db })`:
 *   - HIT  → returns the parsed normalized payload for (format, resource_key).
 *   - MISS → { found:false, suggestions } drawn from the format's searchable_names.
 *   - table missing → { found:false, suggestions: [] }.
 * Everything is scoped to the active `format`.
 *
 * Exercised against a fresh, migrated Postgres schema (Testcontainers) with the
 * fixture handle injected directly — no live network, no @/data/db singleton.
 */

import { sql } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// reference-cache.ts statically `import "server-only"` (it throws under the node
// test env). Neutralize it; we inject our own DB handle so @/data/db is never
// loaded.
vi.mock("server-only", () => ({}));

import type { PokebotDb } from "@/data/db";
import { reference_cache, searchable_names } from "@/data/schema";
import { getReference } from "@/data/repos/reference-cache";
import type {
  MoveDetail,
  TypeMatchupsDetail,
  EvolutionChainDetail,
} from "@/agent/schemas";

import { createPgSchema, type PgFixture } from "../../../test/support/pg";

const SV = "scarlet-violet";
const CH = "champions";

// ---------------------------------------------------------------------------
// Fresh, migrated Postgres schema per test (tests mutate / drop tables).
// ---------------------------------------------------------------------------

let fix: PgFixture;
let db: PokebotDb;

beforeEach(async () => {
  fix = await createPgSchema({ seed: "none" });
  db = fix.db;
}, 60_000);

afterEach(async () => {
  await fix?.cleanup();
});

// --- Normalized payloads (the exact tool-output shapes the cache stores) -----

const FAKE_OUT: MoveDetail = {
  found: true,
  display_name: "Fake Out",
  type: "normal",
  damage_class: "physical",
  power: 40,
  accuracy: 100,
  pp: 10,
  priority: 3,
  target: "selected-pokemon",
  effect_short: "Hits first and makes the target flinch; first turn only.",
  effect_full: "Inflicts regular damage. Has +3 priority. The target flinches.",
};

const GROUND: TypeMatchupsDetail = {
  found: true,
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
};

const EEVEE_CHAIN: EvolutionChainDetail = {
  found: true,
  chain: [
    {
      from: "eevee",
      to: "vaporeon",
      conditions: [{ trigger: "use-item", item: "water-stone" }],
    },
  ],
};

/** Seed a reference_cache row for a format. */
async function seedRef(
  database: PokebotDb,
  format: string,
  key: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  await database.insert(reference_cache).values({
    format,
    resource_key: key,
    resource_kind: kind,
    payload: JSON.stringify(payload),
    endpoint_url: "@pkmn/dex (Pokémon Showdown)",
    fetched_at: 0,
  });
}

/** Seed a searchable_names row for a format (backs miss suggestions). */
async function seedName(
  database: PokebotDb,
  format: string,
  kind: string,
  slug: string,
  display: string,
): Promise<void> {
  await database
    .insert(searchable_names)
    .values({ format, kind, slug, display_name: display });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getReference — pure DB read", () => {
  it("HIT: returns the parsed normalized payload for (format, key)", async () => {
    await seedRef(db, SV, "move/fake-out", "move", FAKE_OUT);

    const result = (await getReference("move", "fake-out", SV, {
      db,
    })) as MoveDetail;

    expect(result).toEqual(FAKE_OUT);
  });

  it("MISS: returns { found:false, suggestions } from the format's searchable_names", async () => {
    await seedName(db, SV, "move", "fake-out", "Fake Out");

    const result = await getReference("move", "fake", SV, { db });

    expect(result).toEqual({ found: false, suggestions: ["fake-out"] });
  });

  it("never produces upstream_unavailable (local data) — a clean miss is found:false", async () => {
    const result = await getReference("ability", "armor-tail", SV, { db });
    expect(result).toEqual({ found: false, suggestions: [] });
  });

  it("TYPE: returns the stored matchup profile (Flying immune to Ground, BR-5/G11)", async () => {
    await seedRef(db, SV, "type/ground", "type", GROUND);

    const result = (await getReference("type", "ground", SV, {
      db,
    })) as TypeMatchupsDetail;

    expect(result.found).toBe(true);
    expect(result.offensive?.no_effect_against).toEqual(["flying"]);
    expect(result.defensive.immune_to).toEqual(["electric"]);
  });

  it("EVOLUTION: keys off evolution-chain/<species> and returns the chain", async () => {
    await seedRef(db, SV, "evolution-chain/eevee", "evolution", EEVEE_CHAIN);

    const result = (await getReference("evolution", "eevee", SV, {
      db,
    })) as EvolutionChainDetail;

    expect(result.found).toBe(true);
    expect(result.chain[0]).toMatchObject({ from: "eevee", to: "vaporeon" });
  });

  it("EVOLUTION miss: suggestions come from the pokemon name set", async () => {
    await seedName(db, SV, "pokemon", "eevee", "Eevee");

    const result = await getReference("evolution", "eeve", SV, { db });

    expect(result).toEqual({ found: false, suggestions: ["eevee"] });
  });

  it("a corrupt stored payload falls through to a miss (with suggestions)", async () => {
    // Insert a row whose payload is not valid JSON for the detail shape.
    await db.insert(reference_cache).values({
      format: SV,
      resource_key: "move/garbage",
      resource_kind: "move",
      payload: "{not json",
      endpoint_url: "@pkmn/dex (Pokémon Showdown)",
      fetched_at: 0,
    });
    await seedName(db, SV, "move", "garbage", "Garbage");

    const result = await getReference("move", "garbage", SV, { db });
    expect(result).toEqual({ found: false, suggestions: ["garbage"] });
  });

  it("table missing (migrations not applied) → { found:false, suggestions: [] }", async () => {
    // Drop the table in this test's own schema (search_path-pinned).
    await db.execute(sql`DROP TABLE reference_cache`);

    const result = await getReference("move", "fake-out", SV, { db });
    expect(result).toEqual({ found: false, suggestions: [] });
  });
});

describe("getReference — format scoping", () => {
  it("a row stored under one format is NOT returned for another format", async () => {
    // Same key, different payloads per format.
    await seedRef(db, SV, "move/fake-out", "move", FAKE_OUT);
    const championsFakeOut: MoveDetail = { ...FAKE_OUT, pp: 5 };
    await seedRef(db, CH, "move/fake-out", "move", championsFakeOut);

    const sv = (await getReference("move", "fake-out", SV, { db })) as MoveDetail;
    const ch = (await getReference("move", "fake-out", CH, { db })) as MoveDetail;

    expect(sv.pp).toBe(10);
    expect(ch.pp).toBe(5);
  });

  it("misses do not leak a row that only exists in the other format", async () => {
    // The hit exists only in champions; a scarlet-violet read must miss.
    await seedRef(db, CH, "move/fake-out", "move", FAKE_OUT);
    await seedName(db, SV, "move", "tackle", "Tackle"); // unrelated SV name

    const sv = await getReference("move", "fake-out", SV, { db });
    expect(sv).toEqual({ found: false, suggestions: [] });
  });

  it("suggestions are scoped to the requested format", async () => {
    await seedName(db, SV, "move", "fake-out", "Fake Out");
    await seedName(db, CH, "move", "fake-out", "Fake Out");
    await seedName(db, CH, "move", "fakeout-champ", "Fakeout Champ");

    const sv = await getReference("move", "fake", SV, { db });
    // Only the SV row matches; the champions-only "fakeout-champ" must not appear.
    expect(sv).toEqual({ found: false, suggestions: ["fake-out"] });
  });
});
