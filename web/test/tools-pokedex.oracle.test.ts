/**
 * INDEPENDENT ORACLE — the DB / reference / resolve / compute tools, exercised
 * through the PUBLIC tool dispatch (src/agent/tools/index.ts) against a small,
 * deterministic fixture DB this test seeds itself.
 *
 * Expected behaviour is derived from tools.md + evaluation.md (the golden cases),
 * NOT from the implementation:
 *   - query_pokedex multi-move intersection (G1, BR-7)
 *   - query_pokedex combined type + ability + move filter (G5)
 *   - query_pokedex sort_by speed desc (G6)
 *   - query_pokedex base-Attack threshold semantics, > vs >= at 130 (G7)
 *   - get_pokemon profile incl. hidden ability + Gen-9 fallback flag (G9, G17)
 *   - resolve_entity("Will-o-Whisp") -> will-o-wisp top match (G3)
 *   - get_type_matchups(["ground"]) -> Flying is immune 0x, NOT "resisted" (G11)
 *   - compute_stat == 169 / estimate_damage min<max+is_estimate via the tools
 *   - structured errors (unresolved / found:false) and NEVER throwing
 *
 * Wiring notes (per the RISK DIRECTIVES):
 *   - We migrate + seed an isolated Postgres schema (createPgSchema) and install
 *     it as the @/data/db singleton (installAsSingleton) BEFORE the first dynamic
 *     import of the tool layer, so resolve_entity (which reads the singleton, not
 *     ctx.db) and the DB-backed tools all see this schema.
 *   - These dynamic imports fail until Phase 4 lands the repos/tools/context;
 *     `loadError` turns that into one clear failing assertion (the red gate).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// src/data/db.ts does `import "server-only"`, whose Node (non-RSC) variant
// throws. Neutralize it so the repos/tools can be loaded under the vitest node
// environment (they are the real Postgres readers in these integration oracles).
vi.mock("server-only", () => ({}));

import {
  getPokemonOutputSchema,
  queryPokedexOutputSchema,
  queryPokedexResultSchema,
  resolveEntityOutputSchema,
  getTypeMatchupsOutputSchema,
  type QueryPokedexResult,
} from "@/agent/schemas";
import type { AgentContext } from "@/agent/types";

import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";
import { loadToolSurface } from "./fixtures/tools-fixture";

let dispatch: (
  name: string,
  args: unknown,
  ctx: AgentContext,
) => Promise<unknown>;
let ctx: AgentContext;
let loadError: unknown = null;
let fix: PgFixture;

beforeAll(async () => {
  try {
    fix = await createPgSchema({ seed: "tools" });
    await installAsSingleton(fix);

    const surface = await loadToolSurface();
    dispatch = surface.dispatch;
    ctx = surface.ctx;
  } catch (e) {
    loadError = e;
  }
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function ensureLoaded(): void {
  if (loadError) {
    throw new Error(
      `Tool layer not loadable yet (Phase 4 incomplete): ${String(loadError)}`,
    );
  }
}

/** Assert a query_pokedex call returned the success union, and return it. */
function expectSuccess(out: unknown): QueryPokedexResult {
  const parsed = queryPokedexOutputSchema.safeParse(out);
  expect(
    parsed.success,
    `query_pokedex output failed schema: ${JSON.stringify(out)}`,
  ).toBe(true);
  const result = queryPokedexResultSchema.safeParse(out);
  expect(
    result.success,
    `expected a success result (total_count/results), got: ${JSON.stringify(out)}`,
  ).toBe(true);
  return result.data as QueryPokedexResult;
}

describe("query_pokedex oracle (T2)", () => {
  it("multi-move intersection: trick-room AND will-o-wisp -> only Ninetales (G1, BR-7)", async () => {
    ensureLoaded();
    const out = await dispatch(
      "query_pokedex",
      { moves: ["trick-room", "will-o-wisp"] },
      ctx,
    );
    const r = expectSuccess(out);
    expect(r.total_count).toBe(1);
    expect(r.results.map((x) => x.display_name)).toEqual(["Ninetales"]);
  });

  it("single move will-o-wisp -> Ninetales + Tauros (Paldean Blaze)", async () => {
    ensureLoaded();
    const out = await dispatch(
      "query_pokedex",
      { moves: ["will-o-wisp"] },
      ctx,
    );
    const r = expectSuccess(out);
    expect(r.total_count).toBe(2);
    expect(new Set(r.results.map((x) => x.display_name))).toEqual(
      new Set(["Ninetales", "Tauros (Paldean Blaze)"]),
    );
  });

  it("combined type + ability + move filter (G5): fire & flash-fire & will-o-wisp -> Ninetales", async () => {
    ensureLoaded();
    const out = await dispatch(
      "query_pokedex",
      { types: ["fire"], abilities: ["flash-fire"], moves: ["will-o-wisp"] },
      ctx,
    );
    const r = expectSuccess(out);
    expect(r.total_count).toBe(1);
    expect(r.results[0]?.display_name).toBe("Ninetales");
  });

  it("sort_by speed desc (G6): sort label set + monotonic non-increasing, top row is the fastest", async () => {
    ensureLoaded();
    const out = await dispatch(
      "query_pokedex",
      { sort_by: "speed", order: "desc" },
      ctx,
    );
    const r = expectSuccess(out);
    expect(r.sort).toBe("speed desc");
    expect(r.results.length).toBeGreaterThan(1);
    const speeds = r.results.map((x) => x.base_stats.speed);
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i - 1]).toBeGreaterThanOrEqual(speeds[i]!);
    }
    // The first row must carry the maximum speed in the returned set — the
    // defining property of a correct desc sort, independent of whether the
    // non-Gen-9 fallback rows are included in an unfiltered query.
    expect(r.results[0]?.base_stats.speed).toBe(Math.max(...speeds));
  });

  it("base-Attack threshold semantics (G7): > 130 excludes Garchomp(130); >= 130 includes it", async () => {
    ensureLoaded();
    const strict = expectSuccess(
      await dispatch(
        "query_pokedex",
        { stat_filters: [{ stat: "attack", op: ">", value: 130 }] },
        ctx,
      ),
    );
    // No fixture mon exceeds 130 -> honest empty, NOT an error.
    expect(strict.total_count).toBe(0);
    expect(strict.results).toEqual([]);

    const inclusive = expectSuccess(
      await dispatch(
        "query_pokedex",
        { stat_filters: [{ stat: "attack", op: ">=", value: 130 }] },
        ctx,
      ),
    );
    expect(inclusive.total_count).toBe(1);
    expect(inclusive.results[0]?.display_name).toBe("Garchomp");
  });

  it("returns { unresolved } (not a throw, not silent empty) for an unknown move slug", async () => {
    ensureLoaded();
    let out: unknown;
    await expect(
      (async () => {
        out = await dispatch("query_pokedex", { moves: ["trik-room"] }, ctx);
      })(),
    ).resolves.toBeUndefined();
    expect(queryPokedexOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toHaveProperty("unresolved");
    expect((out as { unresolved: string[] }).unresolved).toContain("trik-room");
  });
});

describe("get_pokemon oracle (T3)", () => {
  it("Garchomp profile: types, hidden ability, base stats, Gen-9 native (G9)", async () => {
    ensureLoaded();
    const out = await dispatch("get_pokemon", { name: "garchomp" }, ctx);
    expect(getPokemonOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({
      found: true,
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
      is_gen9_native: true,
    });
  });

  it("Farigiraf exposes all three abilities incl. Armor Tail (G4 grounding)", async () => {
    ensureLoaded();
    const out = (await dispatch("get_pokemon", { name: "farigiraf" }, ctx)) as {
      abilities: {
        slot1: string;
        slot2?: string | null;
        hidden?: string | null;
      };
    };
    expect(out.abilities.slot1).toBe("cud-chew");
    expect(out.abilities.slot2).toBe("armor-tail");
    expect(out.abilities.hidden).toBe("sap-sipper");
  });

  it("non-Gen-9 species flags the fallback (G17, BR-1)", async () => {
    ensureLoaded();
    const out = await dispatch("get_pokemon", { name: "dracovish" }, ctx);
    expect(out).toMatchObject({
      found: true,
      is_gen9_native: false,
      source_generation: "gen-8",
    });
  });

  it("unknown name -> { found:false, suggestions } and NEVER throws", async () => {
    ensureLoaded();
    let out: unknown;
    await expect(
      (async () => {
        out = await dispatch(
          "get_pokemon",
          { name: "definitely-not-a-mon" },
          ctx,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(out).toMatchObject({ found: false });
    expect(Array.isArray((out as { suggestions: unknown }).suggestions)).toBe(
      true,
    );
  });
});

describe("resolve_entity oracle (T1)", () => {
  it('"Will-o-Whisp" resolves with will-o-wisp as the top match (G3, BR-9)', async () => {
    ensureLoaded();
    const out = await dispatch(
      "resolve_entity",
      { query: "Will-o-Whisp" },
      ctx,
    );
    expect(resolveEntityOutputSchema.safeParse(out).success).toBe(true);
    const matches = (out as { matches: { slug: string }[] }).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.slug).toBe("will-o-wisp");
  });
});

describe("get_type_matchups oracle (T6)", () => {
  it("Ground reports Flying as IMMUNE (0x), not merely not-very-effective (G11, BR-5)", async () => {
    ensureLoaded();
    const out = await dispatch("get_type_matchups", { types: ["ground"] }, ctx);
    expect(getTypeMatchupsOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ found: true });
    const detail = out as {
      offensive?: {
        no_effect_against: string[];
        not_very_effective_against: string[];
        super_effective_against: string[];
      };
    };
    expect(detail.offensive?.no_effect_against).toContain("flying");
    expect(detail.offensive?.not_very_effective_against ?? []).not.toContain(
      "flying",
    );
    expect(detail.offensive?.super_effective_against ?? []).not.toContain(
      "flying",
    );
  });
});

describe("compute_stat / estimate_damage via dispatch (T9/T10)", () => {
  it("compute_stat returns 169 for Garchomp Speed (G15)", async () => {
    ensureLoaded();
    const out = await dispatch(
      "compute_stat",
      { base_stat: 102, ev: 252, iv: 31, level: 50, nature_effect: "boosted" },
      ctx,
    );
    expect(out).toMatchObject({ value: 169 });
  });

  it("estimate_damage returns the deterministic unmodified range with is_estimate (G16)", async () => {
    ensureLoaded();
    const out = await dispatch(
      "estimate_damage",
      { power: 80, attack_stat: 100, defense_stat: 100 },
      ctx,
    );
    expect(out).toMatchObject({
      is_estimate: true,
      min_damage: 31,
      max_damage: 37,
    });
  });
});
