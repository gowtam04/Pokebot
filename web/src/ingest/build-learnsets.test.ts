/**
 * Unit tests for the DS-3 learnset transform (build-learnsets), @pkmn-backed.
 *
 * After the migration `buildLearnsetRows(pokemonId, learnset, moveSlugFor,
 * { format, gen9Only })` consumes an @pkmn learnset record — `{ moveId:
 * sourceString[] }` where each source encodes gen+method at indexes 0/1
 * ("9M" = Gen-9 machine, "9L42" = Gen-9 level-up @42, "9E" = egg, "8M" = Gen-8
 * machine, "9T" = tutor). The inputs here are small synthetic records so the
 * filtering + method-priority rules are asserted directly.
 *
 * Rules (D6 / BR-2):
 *   - Keep level-up / machine / tutor; drop egg (and event/virtual/other).
 *   - gen9Only (standard) keeps only '9…' sources.
 *   - One row per (pokemon_id, move_slug, format); highest-priority method wins
 *     (level-up > machine > tutor).
 *   - moveSlugFor → null skips the move.
 */

import { describe, expect, it } from "vitest";

import type { Format } from "@/data/formats";
import { buildLearnsetRows } from "./build-learnsets";

const SV: Format = "scarlet-violet";
const CH: Format = "champions";

// @pkmn moveId → canonical slug. An id absent here resolves to null (skipped).
const SLUGS: Record<string, string> = {
  earthquake: "earthquake",
  dragonclaw: "dragon-claw",
  dragonrush: "dragon-rush",
  dig: "dig",
  firespin: "fire-spin",
  willowisp: "will-o-wisp",
};
const moveSlugFor = (id: string): string | null => SLUGS[id] ?? null;

describe("buildLearnsetRows — standard (gen9Only)", () => {
  const learnset = {
    earthquake: ["9M"], // Gen-9 machine
    dragonclaw: ["9L1"], // Gen-9 level-up
    dragonrush: ["9L5", "8M"], // Gen-9 level-up wins over the Gen-8 machine
    dig: ["9E"], // egg-only → dropped
    firespin: ["8M"], // Gen-8 only → dropped under gen9Only
    unknownmove: ["9M"], // moveSlugFor → null → skipped
  };
  const rows = buildLearnsetRows("garchomp", learnset, moveSlugFor, {
    format: SV,
    gen9Only: true,
  });
  const bySlug = new Map(rows.map((r) => [r.move_slug, r]));

  it("attributes every row to the source pokemon and stamps the format", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.pokemon_id === "garchomp")).toBe(true);
    expect(rows.every((r) => r.format === SV)).toBe(true);
  });

  it("keeps Gen-9 machine / level-up moves with the right method", () => {
    expect(bySlug.get("earthquake")?.method).toBe("machine");
    expect(bySlug.get("dragon-claw")?.method).toBe("level-up");
  });

  it("collapses multiple sources to the highest-priority non-egg method", () => {
    // 9L5 (level-up) beats 8M (machine) — and 8M is filtered by gen9Only anyway.
    expect(bySlug.get("dragon-rush")?.method).toBe("level-up");
  });

  it("never emits an egg row (egg-only moves are dropped)", () => {
    expect(rows.every((r) => r.method !== "egg")).toBe(true);
    expect(bySlug.has("dig")).toBe(false);
  });

  it("excludes moves present only in non-Gen-9 sources", () => {
    expect(bySlug.has("fire-spin")).toBe(false);
  });

  it("skips a move whose slug does not resolve (moveSlugFor → null)", () => {
    // 'unknownmove' has a valid Gen-9 machine source but no canonical slug.
    expect(rows.some((r) => r.move_slug === "unknownmove")).toBe(false);
  });

  it("emits unique move_slug rows (composite-PK safe)", () => {
    const slugs = rows.map((r) => r.move_slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("buildLearnsetRows — method priority", () => {
  it("level-up beats machine", () => {
    const rows = buildLearnsetRows(
      "x",
      { tackle: ["9M", "9L20"] },
      (id) => id,
      { format: SV, gen9Only: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("level-up");
  });

  it("machine beats tutor", () => {
    const rows = buildLearnsetRows(
      "x",
      { tackle: ["9T", "9M"] },
      (id) => id,
      { format: SV, gen9Only: true },
    );
    expect(rows[0].method).toBe("machine");
  });
});

describe("buildLearnsetRows — champions (gen9Only false)", () => {
  it("keeps non-'9' sources from the already-scoped mod learnset", () => {
    const rows = buildLearnsetRows(
      "y",
      { firespin: ["8M"], willowisp: ["9M"] },
      moveSlugFor,
      { format: CH, gen9Only: false },
    );
    const bySlug = new Map(rows.map((r) => [r.move_slug, r]));
    expect(bySlug.get("fire-spin")?.method).toBe("machine");
    expect(bySlug.get("fire-spin")?.format).toBe(CH);
    expect(bySlug.get("will-o-wisp")?.method).toBe("machine");
  });

  it("still drops egg moves regardless of gen9Only", () => {
    const rows = buildLearnsetRows("y", { dig: ["9E"] }, moveSlugFor, {
      format: CH,
      gen9Only: false,
    });
    expect(rows).toEqual([]);
  });
});

describe("buildLearnsetRows — edge cases", () => {
  it("returns [] for an empty learnset", () => {
    expect(
      buildLearnsetRows("z", {}, moveSlugFor, { format: SV, gen9Only: true }),
    ).toEqual([]);
  });

  it("ignores malformed source strings", () => {
    const rows = buildLearnsetRows(
      "z",
      { earthquake: ["", "9"] }, // too short / no method letter
      moveSlugFor,
      { format: SV, gen9Only: true },
    );
    expect(rows).toEqual([]);
  });
});
