/**
 * Focused unit tests for the reference-cache-backed tools and the
 * `get_type_matchups` two-type combination logic — the behaviours NOT covered by
 * the independent oracle suite (test/tools-pokedex.oracle.test.ts only exercises
 * the single-type `get_type_matchups(["ground"])` path and the DB tools).
 *
 * The reference cache + learnset repos are mocked so these tests are pure and
 * never touch SQLite/PokeAPI; they assert the wrapper contract:
 *   - misses / upstream-unavailable shapes pass straight through (no throw),
 *   - get_move augments a hit with gen9_learner_count only when requested,
 *   - get_type_matchups combines two single-type defensive profiles correctly
 *     and reports 0× as immune_to (BR-5).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentContext } from "@/agent/types";

const getReference = vi.fn();
const gen9LearnerCount = vi.fn();

vi.mock("@/data/repos/reference-cache", () => ({
  getReference: (...args: unknown[]) => getReference(...args),
}));
vi.mock("@/data/repos/learnset-repo", () => ({
  gen9LearnerCount: (...args: unknown[]) => gen9LearnerCount(...args),
}));

import { getMoveTool } from "./get-move";
import { getAbilityTool } from "./get-ability";
import { getEvolutionChainTool } from "./get-evolution-chain";
import { getItemTool } from "./get-item";
import { getTypeMatchupsTool } from "./get-type-matchups";

const ctx = {
  db: {},
  logger: console,
  requestId: "test",
  mode: "standard",
} as unknown as AgentContext;

// Standard mode maps to the scarlet-violet data format (formatForMode); the
// reference tools thread it into getReference / gen9LearnerCount.
const FMT = "scarlet-violet";

beforeEach(() => {
  getReference.mockReset();
  gen9LearnerCount.mockReset();
});

describe("get_move (T4)", () => {
  const fakeOut = {
    found: true,
    display_name: "Fake Out",
    type: "normal",
    damage_class: "physical",
    power: 40,
    accuracy: 100,
    pp: 10,
    priority: 3,
    target: "selected-pokemon",
    effect_short: "Hits first and flinches; first turn only.",
    effect_full: "…",
  };

  it("passes a hit through and queries the cache with kind 'move'", async () => {
    getReference.mockResolvedValue(fakeOut);
    const out = await getMoveTool.run({ name: "fake-out" }, ctx);
    expect(getReference).toHaveBeenCalledWith("move", "fake-out", FMT, ctx.db);
    expect(out).toEqual(fakeOut);
    expect(gen9LearnerCount).not.toHaveBeenCalled();
  });

  it("adds gen9_learner_count only when include_gen9_learner_count is true", async () => {
    getReference.mockResolvedValue(fakeOut);
    gen9LearnerCount.mockReturnValue(112);
    const out = (await getMoveTool.run(
      { name: "fake-out", include_gen9_learner_count: true },
      ctx,
    )) as { gen9_learner_count?: number };
    expect(gen9LearnerCount).toHaveBeenCalledWith("fake-out", FMT, ctx.db);
    expect(out.gen9_learner_count).toBe(112);
  });

  it("does NOT add a learner count to a miss, and passes the miss through", async () => {
    getReference.mockResolvedValue({ found: false, suggestions: ["fake-out"] });
    const out = await getMoveTool.run(
      { name: "fak-out", include_gen9_learner_count: true },
      ctx,
    );
    expect(out).toEqual({ found: false, suggestions: ["fake-out"] });
    expect(gen9LearnerCount).not.toHaveBeenCalled();
  });

  it("passes upstream_unavailable through without throwing", async () => {
    getReference.mockResolvedValue({ error: "upstream_unavailable" });
    const out = await getMoveTool.run({ name: "fake-out" }, ctx);
    expect(out).toEqual({ error: "upstream_unavailable" });
  });
});

describe("get_ability / get_evolution_chain / get_item kind routing (T5/T7/T8)", () => {
  it("get_ability queries kind 'ability'", async () => {
    getReference.mockResolvedValue({
      found: true,
      display_name: "Armor Tail",
      effect_short: "x",
      effect_full: "y",
    });
    await getAbilityTool.run({ name: "armor-tail" }, ctx);
    expect(getReference).toHaveBeenCalledWith(
      "ability",
      "armor-tail",
      FMT,
      ctx.db,
    );
  });

  it("get_evolution_chain queries kind 'evolution' using the species arg", async () => {
    getReference.mockResolvedValue({ found: true, chain: [] });
    await getEvolutionChainTool.run({ species: "eevee" }, ctx);
    expect(getReference).toHaveBeenCalledWith("evolution", "eevee", FMT, ctx.db);
  });

  it("get_item queries kind 'item' and passes a miss through", async () => {
    getReference.mockResolvedValue({
      found: false,
      suggestions: ["leftovers"],
    });
    const out = await getItemTool.run({ name: "leftover" }, ctx);
    expect(getReference).toHaveBeenCalledWith("item", "leftover", FMT, ctx.db);
    expect(out).toEqual({ found: false, suggestions: ["leftovers"] });
  });
});

describe("get_type_matchups (T6)", () => {
  const ground = {
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
  const flying = {
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
  };

  it("single type returns the cached offensive+defensive profile verbatim", async () => {
    getReference.mockResolvedValue(ground);
    const out = await getTypeMatchupsTool.run({ types: ["ground"] }, ctx);
    expect(getReference).toHaveBeenCalledTimes(1);
    expect(out).toEqual(ground);
  });

  it("combines two defensive profiles; 0× lands in immune_to, never resists (BR-5)", async () => {
    getReference.mockImplementation((_kind: string, slug: string) =>
      Promise.resolve(slug === "ground" ? ground : flying),
    );
    const out = (await getTypeMatchupsTool.run(
      { types: ["ground", "flying"] },
      ctx,
    )) as {
      offensive?: unknown;
      defensive: { weak_to: string[]; resists: string[]; immune_to: string[] };
      types: string[];
    };

    // Two-type request is defensive only.
    expect(out.offensive).toBeUndefined();
    expect(out.types).toEqual(["ground", "flying"]);

    // ground (electric 0×) × flying = electric immune; flying (ground 0×) × ground = ground immune.
    expect(out.defensive.immune_to).toEqual(["electric", "ground"]);
    expect(out.defensive.immune_to).toContain("electric");
    expect(out.defensive.resists).not.toContain("electric");

    // water: 2×1; ice: 2×2 -> both weak.
    expect(out.defensive.weak_to).toEqual(["water", "ice"]);
    // fighting 1×0.5; poison 0.5×1; bug 1×0.5 -> resists.
    expect(out.defensive.resists).toEqual(["fighting", "poison", "bug"]);
  });

  it("propagates a not-found on either type without combining", async () => {
    getReference.mockImplementation((_kind: string, slug: string) =>
      Promise.resolve(
        slug === "ground" ? ground : { found: false, suggestions: ["fire"] },
      ),
    );
    const out = await getTypeMatchupsTool.run(
      { types: ["ground", "fier"] },
      ctx,
    );
    expect(out).toEqual({ found: false, suggestions: ["fire"] });
  });
});
