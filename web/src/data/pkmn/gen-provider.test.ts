/**
 * Real-behavior smoke test for gen-provider.ts — the SINGLE @pkmn integration
 * point (T2, docs/review/oak-implementation-assessment.md).
 *
 * Unlike the build-*.test.ts files (which feed hand-built fakes, or use Dex only
 * for the row builders), this test calls the REAL loadFormat() for BOTH formats
 * and pins the @pkmn quirks that otherwise ship validated only by a live
 * `npm run ingest`, never in CI:
 *   - the standard (Dex.forGen(9)) vs Champions (Dex.mod + FormatsData) legality
 *     gates — a restricted mon legal in one format is gated out of the other,
 *   - Mega resolution as first-class roster species,
 *   - the 18-battle-type / 25-nature / non-CAP filters,
 *   - display-name → legacy-slug slugify (incl. a documented divergence),
 *   - getLearnset's shape + {} fallback.
 *
 * Fully offline — @pkmn ships its dex data as local npm packages (no DB, no
 * network, no mocks). Values were cross-checked against @pkmn 0.10.11.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadFormat, slugFor, slugify, type FormatSource } from "./gen-provider";

// ---------------------------------------------------------------------------
// slugify / slugFor — pure, no @pkmn needed
// ---------------------------------------------------------------------------

describe("slugify — @pkmn display name → legacy PokeAPI-style slug", () => {
  it("collapses spaces/punctuation to single hyphens and drops periods", () => {
    expect(slugify("Mr. Mime")).toBe("mr-mime");
    expect(slugify("Type: Null")).toBe("type-null");
    expect(slugify("Will-O-Wisp")).toBe("will-o-wisp");
    expect(slugify("Charizard-Mega-X")).toBe("charizard-mega-x");
    expect(slugify("Ho-Oh")).toBe("ho-oh");
    expect(slugify("Nidoran-F")).toBe("nidoran-f");
  });

  it("strips combining diacritics (Flabébé → flabebe)", () => {
    expect(slugify("Flabébé")).toBe("flabebe");
  });

  it("drops a STRAIGHT apostrophe (U+0027)", () => {
    expect(slugify("Farfetch'd")).toBe("farfetchd");
  });

  it("does NOT strip @pkmn's CURLY apostrophe — real name is 'Farfetch’d'", () => {
    // Divergence pinned deliberately (T2): @pkmn's stored .name uses a curly ’
    // (U+2019), which slugify's /['.]/g class (straight ' only) misses. So the
    // REAL slug is "farfetch-d", NOT the "farfetchd" the docstring claims. This
    // documents current behavior; fixing it (a SLUG_OVERRIDES entry or widening
    // the regex) would change stored PKs and is out of scope here.
    expect(slugify("Farfetch’d")).toBe("farfetch-d");
    expect(slugify("Sirfetch’d")).toBe("sirfetch-d");
  });
});

describe("slugFor — overrides map (currently empty) then slugify", () => {
  it("falls through to slugify when no override is registered", () => {
    expect(slugFor("hooh", "Ho-Oh")).toBe("ho-oh");
    expect(slugFor("charizardmegax", "Charizard-Mega-X")).toBe("charizard-mega-x");
  });
});

// ---------------------------------------------------------------------------
// loadFormat — real @pkmn, both formats resolved once
// ---------------------------------------------------------------------------

describe("loadFormat", () => {
  let standard: FormatSource;
  let champions: FormatSource;
  let standardIds: Set<string>;
  let championIds: Set<string>;

  beforeAll(async () => {
    standard = await loadFormat("scarlet-violet");
    // Exercises the dynamic import of @pkmn/mods/champions + Dex.mod.
    champions = await loadFormat("champions");
    standardIds = new Set(standard.roster.map((s) => s.id));
    championIds = new Set(champions.roster.map((s) => s.id));
  });

  describe("scarlet-violet (standard / Dex.forGen(9))", () => {
    it("stamps the format and resolves the whole national-dex roster", () => {
      expect(standard.format).toBe("scarlet-violet");
      // Real ≈1416; assert a floor so a @pkmn dex bump doesn't flake the test.
      expect(standard.roster.length).toBeGreaterThan(1000);
    });

    it("keeps exactly the 18 classic battle types (Stellar excluded) and 25 natures", () => {
      expect(standard.types).toHaveLength(18);
      expect(standard.natures).toHaveLength(25);
      expect(standard.types.map((t) => t.name)).not.toContain("Stellar");
    });

    it("filters moves/abilities/items to non-empty, non-CAP sets (abilities drop noability)", () => {
      expect(standard.moves.length).toBeGreaterThan(0);
      expect(standard.items.length).toBeGreaterThan(0);
      expect(standard.abilities.length).toBeGreaterThan(0);
      expect(standard.abilities.some((a) => a.id === "noability")).toBe(false);
    });

    it("includes ordinary and restricted species alike (whole dex, BR-1)", () => {
      for (const id of ["garchomp", "pikachu", "mewtwo", "koraidon"]) {
        expect(standardIds.has(id)).toBe(true);
      }
    });

    it("resolves Mega formes as first-class species (Charizard-Mega-X)", () => {
      const mega = standard.dex.species.get("charizardmegax");
      expect(mega.exists).toBe(true);
      expect(mega.name).toBe("Charizard-Mega-X");
      expect(mega.num).toBe(6);
      expect(mega.forme).toBe("Mega-X");
      expect(standardIds.has("charizardmegax")).toBe(true);
    });
  });

  describe("champions (Dex.mod + FormatsData legality gate)", () => {
    it("stamps the format and resolves a smaller, gated roster", () => {
      expect(champions.format).toBe("champions");
      // The FormatsData isNonstandard gate (~314), NOT species.all() (~1416).
      expect(champions.roster.length).toBeGreaterThan(200);
      expect(champions.roster.length).toBeLessThan(standard.roster.length);
    });

    it("gates out restricted mons that standard keeps (Reg M-B)", () => {
      for (const id of ["mewtwo", "koraidon", "miraidon"]) {
        expect(standardIds.has(id)).toBe(true); // present in standard
        expect(championIds.has(id)).toBe(false); // gated out of champions
      }
    });

    it("keeps ordinary species and Megas legal", () => {
      for (const id of ["garchomp", "pikachu", "charizardmegax", "venusaurmega"]) {
        expect(championIds.has(id)).toBe(true);
      }
    });

    it("carries Mega formes as distinct roster members", () => {
      const megas = champions.roster.filter((s) => /mega/i.test(s.forme));
      expect(megas.length).toBeGreaterThan(0);
      const venuMega = champions.roster.find((s) => s.name === "Venusaur-Mega");
      expect(venuMega).toBeDefined();
      expect(venuMega?.baseSpecies).toBe("Venusaur");
      expect(venuMega?.forme).toBe("Mega");
    });
  });

  describe("getLearnset", () => {
    it("returns a non-empty learnset with gen-9 sources for a known species", async () => {
      const ls = await standard.getLearnset("garchomp");
      expect(Object.keys(ls).length).toBeGreaterThan(0);
      expect(ls.earthquake).toContain("9M"); // gen-9 machine source
    });

    it("is genuinely scoped under the Champions mod too", async () => {
      const ls = await champions.getLearnset("garchomp");
      expect(Object.keys(ls).length).toBeGreaterThan(0);
    });

    it("returns {} for an unknown species id (never throws, never null)", async () => {
      const ls = await standard.getLearnset("totally-bogus-id");
      expect(ls).toEqual({});
    });
  });
});
