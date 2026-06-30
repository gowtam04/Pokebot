/**
 * eval/cases.test.ts — structural unit tests for the G1..G25 case definitions.
 *
 * Owned by: phase "Eval" / track "cases".
 *
 * Tests the STRUCTURE and INTENT of cases.ts without any LLM or DB calls:
 *  - all 25 cases present with unique IDs G1..G25
 *  - every case has the required fields with valid types
 *  - multi-turn input (G19) is correctly shaped
 *  - deterministic subset matches the design.md spec
 *  - tool-efficiency cases (G1/G5/G6/G8) specify query_pokedex + maxPerPokemonFetches=0
 *  - status values are valid OakAnswer status strings
 *  - key requirement IDs are covered across the suite
 *  - derived exports (caseById, deterministicCases, rebuildRegressionCases) are consistent
 */

import { describe, it, expect } from "vitest";
import {
  cases,
  caseById,
  deterministicCases,
  rebuildRegressionCases,
  type GoldenCase,
} from "./cases";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<string>([
  "answered",
  "clarification_needed",
  "resolution_failed",
  "insufficient_data",
]);

/**
 * IDs expected in the deterministic CI subset per design.md:
 *  - G3  (resolve_entity suggestion)
 *  - G11 (type immunity assertion)
 *  - G15 (compute_stat value = 169)
 *  - G1, G5, G6, G8 (tool-efficiency assertions)
 */
const EXPECTED_DETERMINISTIC_IDS = new Set([
  "G1",
  "G3",
  "G5",
  "G6",
  "G8",
  "G11",
  "G15",
]);

/**
 * Index-rebuild regression set per evaluation.md § Regression Approach.
 * G25 joins to catch ingest drift of the move spread-damage fields
 * (spread_modifier_doubles / hits_allies) after every re-ingest.
 */
const EXPECTED_REBUILD_REGRESSION_IDS = new Set([
  "G1",
  "G5",
  "G6",
  "G7",
  "G17",
  "G25",
]);

/**
 * Cases that must carry toolEfficiency assertions (evaluation.md § Metrics:
 * "Assert query_pokedex used … on G1/G5/G6/G8").
 */
const TOOL_EFFICIENCY_IDS = ["G1", "G5", "G6", "G8"];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getCase(id: string): GoldenCase {
  const c = caseById[id];
  if (!c) throw new Error(`Case ${id} not found in caseById`);
  return c;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("eval/cases", () => {
  // -------------------------------------------------------------------------
  // Top-level structure
  // -------------------------------------------------------------------------

  it("exports exactly 25 cases", () => {
    expect(cases).toHaveLength(25);
  });

  it("all IDs follow the G<number> pattern", () => {
    for (const c of cases) {
      expect(c.id).toMatch(/^G\d{1,2}$/);
    }
  });

  it("all IDs G1..G25 are present and unique", () => {
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(25);
    for (let n = 1; n <= 25; n++) {
      expect(ids.has(`G${n}`), `G${n} should be present`).toBe(true);
    }
  });

  it("caseById indexes all 25 cases", () => {
    expect(Object.keys(caseById)).toHaveLength(25);
    for (let n = 1; n <= 25; n++) {
      expect(
        caseById[`G${n}`],
        `caseById["G${n}"] should be defined`,
      ).toBeDefined();
    }
  });

  it("cases array order matches G1..G25 numerically", () => {
    for (let i = 0; i < cases.length; i++) {
      const expected = `G${i + 1}`;
      expect(cases[i].id).toBe(expected);
    }
  });

  // -------------------------------------------------------------------------
  // Per-case required-field shape
  // -------------------------------------------------------------------------

  it.each(cases.map((c) => [c.id, c] as [string, GoldenCase]))(
    "%s — required fields are present and well-typed",
    (_id, c) => {
      // id
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);

      // input: string or non-empty string[]
      if (Array.isArray(c.input)) {
        expect((c.input as string[]).length).toBeGreaterThanOrEqual(2);
        for (const turn of c.input as string[]) {
          expect(typeof turn).toBe("string");
          expect(turn.length).toBeGreaterThan(0);
        }
      } else {
        expect(typeof c.input).toBe("string");
        expect((c.input as string).length).toBeGreaterThan(0);
      }

      // expect object exists
      expect(c.expect).toBeDefined();
      expect(typeof c.expect).toBe("object");
      expect(c.expect).not.toBeNull();

      // status (optional) must be a valid OakAnswer status
      if (c.expect.status !== undefined) {
        expect(
          VALID_STATUSES.has(c.expect.status),
          `${c.id} status "${c.expect.status}" is not a valid OakAnswer status`,
        ).toBe(true);
      }

      // minCandidates (optional) must be a positive integer
      if (c.expect.minCandidates !== undefined) {
        expect(Number.isInteger(c.expect.minCandidates)).toBe(true);
        expect(c.expect.minCandidates).toBeGreaterThan(0);
      }

      // mustCite (optional) must be a non-empty array of non-empty strings
      if (c.expect.mustCite !== undefined) {
        expect(Array.isArray(c.expect.mustCite)).toBe(true);
        expect(c.expect.mustCite.length).toBeGreaterThan(0);
        for (const s of c.expect.mustCite) {
          expect(typeof s).toBe("string");
          expect(s.length).toBeGreaterThan(0);
        }
      }

      // mustInclude (optional) must be a non-empty array of non-empty strings
      if (c.expect.mustInclude !== undefined) {
        expect(Array.isArray(c.expect.mustInclude)).toBe(true);
        expect(c.expect.mustInclude.length).toBeGreaterThan(0);
        for (const s of c.expect.mustInclude) {
          expect(typeof s).toBe("string");
          expect(s.length).toBeGreaterThan(0);
        }
      }

      // toolEfficiency (optional) must have usedTool string + non-negative integer
      if (c.expect.toolEfficiency !== undefined) {
        expect(typeof c.expect.toolEfficiency.usedTool).toBe("string");
        expect(c.expect.toolEfficiency.usedTool.length).toBeGreaterThan(0);
        expect(
          Number.isInteger(c.expect.toolEfficiency.maxPerPokemonFetches),
        ).toBe(true);
        expect(
          c.expect.toolEfficiency.maxPerPokemonFetches,
        ).toBeGreaterThanOrEqual(0);
      }

      // deterministic (optional) must be a boolean when present
      if (c.expect.deterministic !== undefined) {
        expect(typeof c.expect.deterministic).toBe("boolean");
      }

      // covers must be a non-empty array of non-empty strings
      expect(Array.isArray(c.covers)).toBe(true);
      expect(c.covers.length).toBeGreaterThan(0);
      for (const req of c.covers) {
        expect(typeof req).toBe("string");
        expect(req.length).toBeGreaterThan(0);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Multi-turn: only G19 has an array input
  // -------------------------------------------------------------------------

  describe("multi-turn (G19)", () => {
    it("G19 input is an array of exactly 2 turns", () => {
      const g19 = getCase("G19");
      expect(Array.isArray(g19.input)).toBe(true);
      expect((g19.input as string[]).length).toBe(2);
    });

    it("only G19 has an array input", () => {
      const multiTurn = cases.filter((c) => Array.isArray(c.input));
      expect(multiTurn).toHaveLength(1);
      expect(multiTurn[0].id).toBe("G19");
    });

    it("G19 first turn is the Trick Room + Will-O-Wisp query", () => {
      const g19 = getCase("G19");
      const turns = g19.input as string[];
      expect(turns[0].toLowerCase()).toContain("trick room");
      expect(turns[0].toLowerCase()).toContain("will-o-wisp");
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic CI subset
  // -------------------------------------------------------------------------

  describe("deterministic CI subset", () => {
    it("deterministicCases contains all expected IDs", () => {
      const actual = new Set(deterministicCases.map((c) => c.id));
      for (const id of EXPECTED_DETERMINISTIC_IDS) {
        expect(actual.has(id), `${id} should be in deterministicCases`).toBe(
          true,
        );
      }
    });

    it("every entry in deterministicCases has deterministic:true", () => {
      for (const c of deterministicCases) {
        expect(
          c.expect.deterministic,
          `${c.id} should have deterministic:true`,
        ).toBe(true);
      }
    });

    it("deterministicCases is a subset of cases (same objects by reference)", () => {
      const caseSet = new Set(cases);
      for (const c of deterministicCases) {
        expect(caseSet.has(c)).toBe(true);
      }
    });

    it("G3 is deterministic — resolve_entity suggestion check", () => {
      const g3 = getCase("G3");
      expect(g3.expect.deterministic).toBe(true);
      expect(g3.expect.status).toBe("clarification_needed");
      expect(g3.expect.mustInclude).toContain("Will-O-Wisp");
    });

    it("G11 is deterministic — type immunity assertion", () => {
      const g11 = getCase("G11");
      expect(g11.expect.deterministic).toBe(true);
      expect(g11.expect.mustInclude).toContain("immune");
    });

    it("G15 is deterministic — compute_stat value = 169", () => {
      const g15 = getCase("G15");
      expect(g15.expect.deterministic).toBe(true);
      expect(g15.expect.mustInclude).toContain("169");
    });
  });

  // -------------------------------------------------------------------------
  // Tool-efficiency assertions (G1/G5/G6/G8)
  // -------------------------------------------------------------------------

  describe("tool-efficiency assertions", () => {
    it.each(TOOL_EFFICIENCY_IDS)("%s has a toolEfficiency assertion", (id) => {
      expect(
        getCase(id).expect.toolEfficiency,
        `${id} should have toolEfficiency`,
      ).toBeDefined();
    });

    it.each(TOOL_EFFICIENCY_IDS)(
      "%s uses 'query_pokedex' as the required tool",
      (id) => {
        expect(getCase(id).expect.toolEfficiency?.usedTool).toBe(
          "query_pokedex",
        );
      },
    );

    it.each(TOOL_EFFICIENCY_IDS)(
      "%s forbids per-Pokémon brute-force (maxPerPokemonFetches === 0)",
      (id) => {
        expect(getCase(id).expect.toolEfficiency?.maxPerPokemonFetches).toBe(0);
      },
    );

    it.each(TOOL_EFFICIENCY_IDS)(
      "%s is marked deterministic (tool-efficiency is a CI check)",
      (id) => {
        expect(getCase(id).expect.deterministic).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Index-rebuild regression set
  // -------------------------------------------------------------------------

  describe("rebuildRegressionCases", () => {
    it("contains exactly G1/G5/G6/G7/G17/G25", () => {
      const actual = new Set(rebuildRegressionCases.map((c) => c.id));
      expect(actual.size).toBe(6);
      for (const id of EXPECTED_REBUILD_REGRESSION_IDS) {
        expect(
          actual.has(id),
          `${id} should be in rebuildRegressionCases`,
        ).toBe(true);
      }
    });

    it("is a subset of cases (same objects by reference)", () => {
      const caseSet = new Set(cases);
      for (const c of rebuildRegressionCases) {
        expect(caseSet.has(c)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Status coverage
  // -------------------------------------------------------------------------

  describe("status coverage", () => {
    it("at least one case asserts each of: answered, clarification_needed, insufficient_data", () => {
      const usedStatuses = new Set(
        cases
          .filter((c) => c.expect.status !== undefined)
          .map((c) => c.expect.status!),
      );
      expect(usedStatuses.has("answered")).toBe(true);
      expect(usedStatuses.has("clarification_needed")).toBe(true);
      expect(usedStatuses.has("insufficient_data")).toBe(true);
    });

    it("G3 status is clarification_needed (misspelled entity → suggestions)", () => {
      expect(getCase("G3").expect.status).toBe("clarification_needed");
    });

    it("G22 status is insufficient_data (PokeAPI/cache unavailable)", () => {
      expect(getCase("G22").expect.status).toBe("insufficient_data");
    });

    it("all non-out-of-scope main cases assert status: answered", () => {
      const answeredCases = [
        "G1",
        "G2",
        "G4",
        "G5",
        "G6",
        "G7",
        "G8",
        "G9",
        "G10",
        "G11",
        "G12",
        "G13",
        "G14",
        "G15",
        "G16",
        "G17",
        "G19",
        "G24",
      ];
      for (const id of answeredCases) {
        expect(getCase(id).expect.status, `${id} should be answered`).toBe(
          "answered",
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Citation checks: key cases must have mustCite
  // -------------------------------------------------------------------------

  describe("mustCite presence on factual cases", () => {
    it("G1 cites both learnsets", () => {
      const g1 = getCase("G1");
      expect(g1.expect.mustCite).toBeDefined();
      const sources = g1.expect.mustCite!;
      expect(sources.some((s) => s.includes("trick-room"))).toBe(true);
      expect(sources.some((s) => s.includes("will-o-wisp"))).toBe(true);
    });

    it("G4 cites the move and the ability", () => {
      const g4 = getCase("G4");
      expect(g4.expect.mustCite).toBeDefined();
      const sources = g4.expect.mustCite!;
      expect(sources.some((s) => s.includes("fake-out"))).toBe(true);
      expect(sources.some((s) => s.includes("armor-tail"))).toBe(true);
    });

    it("G11 cites the ground type", () => {
      const g11 = getCase("G11");
      expect(g11.expect.mustCite?.some((s) => s.includes("ground"))).toBe(true);
    });

    it("G13 cites the leftovers item", () => {
      const g13 = getCase("G13");
      expect(g13.expect.mustCite?.some((s) => s.includes("leftovers"))).toBe(
        true,
      );
    });

    it("G24 cites leftovers despite the citation-suppression prompt injection", () => {
      const g24 = getCase("G24");
      expect(g24.expect.mustCite).toBeDefined();
      expect(g24.expect.mustCite?.some((s) => s.includes("leftovers"))).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // mustInclude checks: critical term assertions
  // -------------------------------------------------------------------------

  describe("mustInclude critical terms", () => {
    it("G11 requires 'immune' (not just 'not very effective')", () => {
      expect(getCase("G11").expect.mustInclude).toContain("immune");
    });

    it("G15 requires '169' (exact stat value)", () => {
      expect(getCase("G15").expect.mustInclude).toContain("169");
    });

    it("G16 requires 'estimate' (damage range is an estimate)", () => {
      expect(getCase("G16").expect.mustInclude).toContain("estimate");
    });

    it("G9 requires both 'dragon' and 'ground' (Garchomp's types)", () => {
      const mustInclude = getCase("G9").expect.mustInclude ?? [];
      expect(mustInclude).toContain("dragon");
      expect(mustInclude).toContain("ground");
    });

    it("G12 requires 'grass' and 'electric' (Water weaknesses)", () => {
      const mustInclude = getCase("G12").expect.mustInclude ?? [];
      expect(mustInclude).toContain("grass");
      expect(mustInclude).toContain("electric");
    });
  });

  // -------------------------------------------------------------------------
  // G18 — Ambiguous form: minCandidates check
  // -------------------------------------------------------------------------

  it("G18 requires minCandidates >= 2 (multiple Tauros forms must be shown)", () => {
    const g18 = getCase("G18");
    expect(g18.expect.minCandidates).toBeDefined();
    expect(g18.expect.minCandidates!).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Requirement coverage across the suite
  // -------------------------------------------------------------------------

  describe("requirement coverage", () => {
    const allCovers = cases.flatMap((c) => c.covers);

    const keyRequirements = [
      // User Stories
      "US-1",
      "US-2",
      "US-3",
      "US-6",
      "US-7",
      "US-10",
      "US-11",
      "US-12",
      "US-13",
      // Acceptance Criteria
      "AC-1.2",
      "AC-1.3",
      "AC-2.2",
      "AC-3.1",
      "AC-3.2",
      "AC-3.3",
      "AC-4.1",
      "AC-5.1",
      "AC-6.1",
      "AC-7.1",
      "AC-7.2",
      "AC-7.3",
      "AC-8.1",
      "AC-9.1",
      "AC-9.2",
      "AC-10.1",
      // Business Rules
      "BR-1",
      "BR-2",
      "BR-3",
      "BR-4",
      "BR-5",
      "BR-6",
      "BR-7",
      "BR-9",
      // Technical Decisions
      "D8",
      // Non-functional
      "NFR-reliability",
    ];

    it.each(keyRequirements)("%s is covered by at least one case", (req) => {
      expect(
        allCovers.some((c) => c.includes(req)),
        `Requirement ${req} should be covered by some case`,
      ).toBe(true);
    });
  });
});
