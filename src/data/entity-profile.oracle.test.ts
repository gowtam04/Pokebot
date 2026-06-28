/**
 * INDEPENDENT ORACLE — assembleEntityProfile (B-4 Phase 2) over a seeded fixture
 * DB. Expected behaviour is derived from the B-4 spec, not the implementation:
 *   - per-kind full-profile assembly (pokemon incl. combined matchups + grouped
 *     movepool, move, ability + learned_by, item, type)
 *   - the Pokémon combined defensive grid matches the shared type-chart formula
 *     (Garchomp = Ground/Dragon → 4× Ice, weak Dragon/Fairy, immune Electric)
 *   - the Gen-9 fallback flag (Dracovish, is_gen9_native = 0)
 *   - not_found (unresolved slug) and unavailable (unbuilt index) envelopes
 *   - every ok result round-trips through the shared contract schema
 *
 * The "tools" seed carries only type/ground + type/flying reference rows, so this
 * test adds the move / ability / item / type-dragon references its assertions
 * need via the createPgSchema `after` hook.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Repos under test `import "server-only"`, whose Node variant throws — neutralize
// it so the real Postgres readers load under the vitest node environment.
vi.mock("server-only", () => ({}));

import { entityArtifactResponseSchema } from "@/lib/entity-artifact";

import { createPgSchema, type PgFixture } from "../../test/support/pg";
import { seedEntityRefs } from "../../test/fixtures/entity-refs";

const SV = "scarlet-violet";

// Imported dynamically after server-only is mocked.
let assembleEntityProfile: typeof import("./entity-profile").assembleEntityProfile;
let fix: PgFixture;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools", after: seedEntityRefs });
  ({ assembleEntityProfile } = await import("./entity-profile"));
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

describe("assembleEntityProfile — pokemon", () => {
  it("assembles Garchomp's full profile with combined matchups and grouped movepool", async () => {
    const res = await assembleEntityProfile("pokemon", "garchomp", SV, fix.db);
    expect(entityArtifactResponseSchema.parse(res)).toEqual(res);
    expect(res.status).toBe("ok");
    if (res.status !== "ok" || res.kind !== "pokemon") {
      throw new Error("expected ok pokemon");
    }

    expect(res.resolved).toEqual({ slug: "garchomp", display_name: "Garchomp" });
    expect(res.is_fallback).toBe(false);
    expect(res.generation).toBe("Scarlet/Violet (Gen 9)");
    expect(res.data.types).toEqual(["dragon", "ground"]);
    expect(res.data.base_stats.attack).toBe(130);
    expect(res.data.base_stat_total).toBe(600);

    // Ground × Dragon (computed by the shared type-chart formula).
    expect(res.data.matchups.weak_to.sort()).toEqual(
      ["dragon", "fairy", "ice"].sort(),
    );
    expect(res.data.matchups.resists.sort()).toEqual(
      ["fire", "poison", "rock"].sort(),
    );
    expect(res.data.matchups.immune_to).toEqual(["electric"]);
    // Quad subsets: Ground × Dragon stacks to 4× Ice (a subset of weak_to);
    // no attacking type is resisted by both, so nothing is 0.25×.
    expect(res.data.matchups.quad_weak_to).toEqual(["ice"]);
    expect(res.data.matchups.quad_resists).toEqual([]);

    // Movepool grouped by method, names + types hydrated, sorted within a group.
    const levelUp = res.data.movepool.find((g) => g.method === "Level-up");
    const machine = res.data.movepool.find((g) => g.method === "TM/HM");
    expect(levelUp?.moves.map((m) => m.display_name)).toEqual([
      "Dragon Claw",
      "Fire Fang",
    ]);
    expect(levelUp?.moves[0]).toEqual({
      slug: "dragon-claw",
      display_name: "Dragon Claw",
      type: "dragon",
    });
    expect(machine?.moves.map((m) => m.slug)).toEqual(["earthquake"]);
    expect(res.citations[0]?.source).toBe("pokemon/garchomp");
  });

  it("flags a non-native species as a fallback (Dracovish)", async () => {
    const res = await assembleEntityProfile("pokemon", "dracovish", SV, fix.db);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.is_fallback).toBe(true);
    expect(res.fallback_note).toMatch(/gen-8/);
  });

  it("returns not_found for an unresolved Pokémon slug", async () => {
    const res = await assembleEntityProfile("pokemon", "missingno", SV, fix.db);
    expect(res).toMatchObject({ status: "not_found", kind: "pokemon" });
  });
});

describe("assembleEntityProfile — move / ability / item / type", () => {
  it("assembles a move profile", async () => {
    const res = await assembleEntityProfile("move", "earthquake", SV, fix.db);
    expect(entityArtifactResponseSchema.parse(res)).toEqual(res);
    if (res.status !== "ok" || res.kind !== "move") {
      throw new Error("expected ok move");
    }
    expect(res.data.type).toBe("ground");
    expect(res.data.damage_class).toBe("physical");
    expect(res.data.power).toBe(100);
  });

  it("assembles an ability profile with its learned_by roster", async () => {
    const res = await assembleEntityProfile("ability", "rough-skin", SV, fix.db);
    expect(entityArtifactResponseSchema.parse(res)).toEqual(res);
    if (res.status !== "ok" || res.kind !== "ability") {
      throw new Error("expected ok ability");
    }
    expect(res.data.effect_short).toMatch(/contact/i);
    expect(res.data.learned_by).toContainEqual({
      slug: "garchomp",
      display_name: "Garchomp",
    });
  });

  it("assembles an item profile", async () => {
    const res = await assembleEntityProfile("item", "leftovers", SV, fix.db);
    if (res.status !== "ok" || res.kind !== "item") {
      throw new Error("expected ok item");
    }
    expect(res.data.display_name).toBe("Leftovers");
    expect(res.data.effect_short).toMatch(/HP/);
  });

  it("assembles a type profile with offensive + defensive grids", async () => {
    const res = await assembleEntityProfile("type", "ground", SV, fix.db);
    expect(entityArtifactResponseSchema.parse(res)).toEqual(res);
    if (res.status !== "ok" || res.kind !== "type") {
      throw new Error("expected ok type");
    }
    expect(res.resolved.display_name).toBe("Ground");
    expect(res.data.offensive?.no_effect_against).toContain("flying");
    expect(res.data.defensive.immune_to).toContain("electric");
    // A single type never reaches 4× / 0.25×, so the quad subsets are empty
    // (but present, mirroring the Pokémon grid's shape).
    expect(res.data.defensive.quad_weak_to).toEqual([]);
    expect(res.data.defensive.quad_resists).toEqual([]);
  });

  it("returns not_found for a move with no reference row", async () => {
    const res = await assembleEntityProfile("move", "splash", SV, fix.db);
    expect(res).toMatchObject({ status: "not_found", kind: "move" });
  });
});

describe("assembleEntityProfile — unavailable index", () => {
  it("returns unavailable when the format's index is unbuilt", async () => {
    const empty = await createPgSchema({ seed: "none" });
    try {
      const res = await assembleEntityProfile(
        "pokemon",
        "garchomp",
        SV,
        empty.db,
      );
      expect(res).toEqual({
        status: "unavailable",
        kind: "pokemon",
        format: SV,
      });
    } finally {
      await empty.cleanup();
    }
  });
});
