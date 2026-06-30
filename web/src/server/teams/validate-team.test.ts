/**
 * Oracle tests for the team validation service (validate-team.ts).
 *
 * Run against a REAL throwaway Postgres schema seeded with the curated `tools`
 * fixture (Testcontainers) so species/ability/item/learnset legality is checked
 * end-to-end against actual index rows — no mocks, no network. The pure EV/IV/
 * clause math runs in-process.
 *
 * Fixture facts these tests rely on (test/fixtures/tools-fixture.ts):
 *   - garchomp: abilities { sand-veil, rough-skin }; learns earthquake,
 *     dragon-claw, fire-fang.
 *   - ninetales: abilities { flash-fire, drought }; learns will-o-wisp,
 *     trick-room, flamethrower.
 *   - the ONLY legal held item is "leftovers".
 *
 * Each WarningCode gets a test that proves it fires on a bad team AND is silent
 * on a clean one; the service never throws and always returns an array (BR-T6).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OakDb } from "@/data/db";
import type { StatSpread, TeamMember } from "@/data/teams/team-schema";

import { validateTeam, type WarningCode } from "./validate-team";
import { createPgSchema, type PgFixture } from "../../../test/support/pg";

const SV = "scarlet-violet" as const;

const ZERO_EVS: StatSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const PERFECT_IVS: StatSpread = {
  hp: 31,
  atk: 31,
  def: 31,
  spa: 31,
  spd: 31,
  spe: 31,
};

/** A blank, legal-by-default member; override only what a test exercises. */
function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    species: null,
    ability: null,
    item: null,
    moves: [],
    nature: null,
    evs: { ...ZERO_EVS },
    ivs: { ...PERFECT_IVS },
    tera_type: null,
    level: 50,
    ...overrides,
  };
}

/**
 * A fully-legal Garchomp set. Garchomp only learns 3 moves in the fixture, so a
 * legal move repeats to reach 4 slots (there is no duplicate-move clause) and
 * thus avoid an `incomplete` warning.
 */
function legalGarchomp(overrides: Partial<TeamMember> = {}): TeamMember {
  return member({
    species: "garchomp",
    ability: "sand-veil",
    item: "leftovers",
    moves: ["earthquake", "dragon-claw", "fire-fang", "earthquake"],
    ...overrides,
  });
}

function codes(warnings: { code: WarningCode }[]): WarningCode[] {
  return warnings.map((w) => w.code);
}

let fix: PgFixture;
let db: OakDb;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools" });
  db = fix.db;
});

afterAll(async () => {
  await fix.cleanup();
});

describe("validateTeam", () => {
  it("returns [] for an empty team", async () => {
    expect(await validateTeam([], SV, db)).toEqual([]);
  });

  it("returns [] for a fully-legal member (clean team)", async () => {
    const warnings = await validateTeam([legalGarchomp()], SV, db);
    expect(warnings).toEqual([]);
  });

  describe("EV/IV math (AC-5.1)", () => {
    it("flags ev_total_exceeded when the EV total tops 508", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp({
            evs: { hp: 252, atk: 252, def: 252, spa: 0, spd: 0, spe: 0 },
          }),
        ],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "ev_total_exceeded");
      expect(w).toBeDefined();
      expect(w?.slot).toBe(0);
      expect(w?.field).toBe("evs");
      // 252*3 = 756 ≤ 252 each, so no per-stat warning here.
      expect(codes(warnings)).not.toContain("ev_stat_exceeded");
    });

    it("flags ev_stat_exceeded (per stat) when a single EV tops 252", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp({
            evs: { hp: 253, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
          }),
        ],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "ev_stat_exceeded");
      expect(w).toBeDefined();
      expect(w?.field).toBe("evs.hp");
      // 253 total is under 508 → no total warning.
      expect(codes(warnings)).not.toContain("ev_total_exceeded");
    });

    it("flags iv_out_of_range (per stat) for an IV outside 0..31", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp({
            ivs: { hp: 32, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
          }),
        ],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "iv_out_of_range");
      expect(w).toBeDefined();
      expect(w?.field).toBe("ivs.hp");
    });

    it("is silent on legal EV/IV spreads", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp({
            evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
            ivs: { ...PERFECT_IVS },
          }),
        ],
        SV,
        db,
      );
      expect(codes(warnings)).not.toContain("ev_total_exceeded");
      expect(codes(warnings)).not.toContain("ev_stat_exceeded");
      expect(codes(warnings)).not.toContain("iv_out_of_range");
    });
  });

  describe("legality vs the index (AC-5.2)", () => {
    it("flags species_illegal for a species not in the roster", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ species: "missingno" })],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "species_illegal");
      expect(w).toBeDefined();
      expect(w?.slot).toBe(0);
      expect(w?.field).toBe("species");
      // An illegal species short-circuits ability/move legality (no noise).
      expect(codes(warnings)).not.toContain("ability_not_for_species");
      expect(codes(warnings)).not.toContain("move_not_in_learnset");
    });

    it("flags ability_not_for_species for an ability the species can't have", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ ability: "intimidate" })],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "ability_not_for_species");
      expect(w).toBeDefined();
      expect(w?.field).toBe("ability");
    });

    it("accepts a hidden ability as legal", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ ability: "rough-skin" })],
        SV,
        db,
      );
      expect(codes(warnings)).not.toContain("ability_not_for_species");
    });

    it("flags move_not_in_learnset per offending move slot", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp({
            moves: ["earthquake", "psychic", "fire-fang", "trick-room"],
          }),
        ],
        SV,
        db,
      );
      const offenders = warnings.filter(
        (x) => x.code === "move_not_in_learnset",
      );
      // "psychic" (idx 1) and "trick-room" (idx 3) are not in Garchomp's learnset.
      expect(offenders.map((w) => w.field).sort()).toEqual([
        "moves[1]",
        "moves[3]",
      ]);
    });

    it("flags item_illegal for an item not in the format master list", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ item: "choice-band" })],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "item_illegal");
      expect(w).toBeDefined();
      expect(w?.field).toBe("item");
    });

    it("is silent on a legal item", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ item: "leftovers" })],
        SV,
        db,
      );
      expect(codes(warnings)).not.toContain("item_illegal");
    });
  });

  describe("clauses (AC-5.3) — team-level, no slot", () => {
    it("flags duplicate_species (species clause)", async () => {
      const warnings = await validateTeam(
        [legalGarchomp(), legalGarchomp({ item: null })],
        SV,
        db,
      );
      const w = warnings.find((x) => x.code === "duplicate_species");
      expect(w).toBeDefined();
      expect(w?.slot).toBeUndefined(); // team-level
    });

    it("flags duplicate_item (item clause)", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp(),
          legalGarchomp({ species: "ninetales", ability: "flash-fire", moves: ["will-o-wisp", "trick-room", "flamethrower", "will-o-wisp"] }),
        ],
        SV,
        db,
      );
      // Both hold "leftovers" → item clause; different species → no species clause.
      const w = warnings.find((x) => x.code === "duplicate_item");
      expect(w).toBeDefined();
      expect(w?.slot).toBeUndefined();
      expect(codes(warnings)).not.toContain("duplicate_species");
    });

    it("does not treat different forms / blank slots as duplicates", async () => {
      const warnings = await validateTeam(
        [
          legalGarchomp(),
          member({ species: "ninetales", item: null }), // partial, different species
          member(), // empty slot
        ],
        SV,
        db,
      );
      expect(codes(warnings)).not.toContain("duplicate_species");
      expect(codes(warnings)).not.toContain("duplicate_item");
    });
  });

  describe("incomplete (BR-T4, informational)", () => {
    it("flags an empty species slot", async () => {
      const warnings = await validateTeam([member()], SV, db);
      const w = warnings.find((x) => x.code === "incomplete");
      expect(w).toBeDefined();
      expect(w?.slot).toBe(0);
    });

    it("flags a species with fewer than 4 moves", async () => {
      const warnings = await validateTeam(
        [legalGarchomp({ moves: ["earthquake", "dragon-claw"] })],
        SV,
        db,
      );
      expect(codes(warnings)).toContain("incomplete");
    });

    it("is silent when species is set and there are 4 moves", async () => {
      const warnings = await validateTeam([legalGarchomp()], SV, db);
      expect(codes(warnings)).not.toContain("incomplete");
    });
  });

  it("never blocks: always returns an array, even with many warnings (BR-T6)", async () => {
    const warnings = await validateTeam(
      [
        legalGarchomp({
          species: "missingno",
          ability: "intimidate",
          item: "choice-band",
          moves: ["psychic"],
          evs: { hp: 253, atk: 253, def: 253, spa: 0, spd: 0, spe: 0 },
          ivs: { hp: 99, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        }),
      ],
      SV,
      db,
    );
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
