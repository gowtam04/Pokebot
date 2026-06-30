/**
 * Tests for src/data/teams/team-schema.ts — the shared TeamMember Zod schema.
 *
 * Pure (no DB / no @pkmn / no server-only); runs in the node project without
 * Docker. Verifies the single-source-of-truth contract: strictness (unknown
 * keys rejected), the raw 0..255 EV/IV range (warn-but-allow lives elsewhere),
 * partial-team tolerance (null slots, <4 moves, <6 members), cosmetic optionals,
 * and the array cap.
 */

import { describe, expect, it } from "vitest";

import {
  statSpreadSchema,
  teamMemberSchema,
  teamMembersSchema,
} from "@/data/teams/team-schema";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ZERO_SPREAD = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const MAX_IV = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function member(overrides: Record<string, unknown> = {}) {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: "life-orb",
    moves: ["earthquake", "dragon-claw", "swords-dance", "fire-fang"],
    nature: "jolly",
    evs: { ...ZERO_SPREAD, atk: 252, spe: 252, hp: 4 },
    ivs: { ...MAX_IV },
    tera_type: "fire",
    level: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// statSpreadSchema
// ---------------------------------------------------------------------------

describe("statSpreadSchema", () => {
  it("accepts a full 6-stat spread", () => {
    expect(statSpreadSchema.safeParse(ZERO_SPREAD).success).toBe(true);
  });

  it("accepts the raw 0..255 range (legality is warn-but-allow, not schema)", () => {
    const r = statSpreadSchema.safeParse({ ...ZERO_SPREAD, atk: 255, spe: 200 });
    expect(r.success).toBe(true);
  });

  it("rejects values above 255", () => {
    expect(statSpreadSchema.safeParse({ ...ZERO_SPREAD, atk: 256 }).success).toBe(false);
  });

  it("rejects negative values", () => {
    expect(statSpreadSchema.safeParse({ ...ZERO_SPREAD, hp: -1 }).success).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(statSpreadSchema.safeParse({ ...ZERO_SPREAD, hp: 1.5 }).success).toBe(false);
  });

  it("rejects a missing stat key", () => {
    const { spe, ...partial } = ZERO_SPREAD;
    void spe;
    expect(statSpreadSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects unknown stat keys (.strict)", () => {
    expect(statSpreadSchema.safeParse({ ...ZERO_SPREAD, spc: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// teamMemberSchema
// ---------------------------------------------------------------------------

describe("teamMemberSchema", () => {
  it("accepts a fully-specified competitive set", () => {
    expect(teamMemberSchema.safeParse(member()).success).toBe(true);
  });

  it("accepts a fully-empty slot (all nullable fields null, no moves)", () => {
    const empty = {
      species: null,
      ability: null,
      item: null,
      moves: [],
      nature: null,
      evs: ZERO_SPREAD,
      ivs: MAX_IV,
      tera_type: null,
      level: 50,
    };
    expect(teamMemberSchema.safeParse(empty).success).toBe(true);
  });

  it("accepts a partial moveset (fewer than 4 moves)", () => {
    expect(teamMemberSchema.safeParse(member({ moves: ["earthquake"] })).success).toBe(true);
  });

  it("rejects more than 4 moves", () => {
    const r = teamMemberSchema.safeParse(
      member({ moves: ["a", "b", "c", "d", "e"] }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts the cosmetic optionals (nickname/gender/shiny)", () => {
    const r = teamMemberSchema.safeParse(
      member({ nickname: "Chompy", gender: "F", shiny: true }),
    );
    expect(r.success).toBe(true);
  });

  it("allows nickname to be null and gender to be null", () => {
    expect(
      teamMemberSchema.safeParse(member({ nickname: null, gender: null })).success,
    ).toBe(true);
  });

  it("rejects an invalid gender enum value", () => {
    expect(teamMemberSchema.safeParse(member({ gender: "X" })).success).toBe(false);
  });

  it("rejects level 0 and level 101", () => {
    expect(teamMemberSchema.safeParse(member({ level: 0 })).success).toBe(false);
    expect(teamMemberSchema.safeParse(member({ level: 101 })).success).toBe(false);
  });

  it("rejects unknown keys (.strict)", () => {
    expect(teamMemberSchema.safeParse(member({ happiness: 255 })).success).toBe(false);
  });

  it("rejects a non-string species (must be slug or null)", () => {
    expect(teamMemberSchema.safeParse(member({ species: 445 })).success).toBe(false);
  });

  it("infers a usable TeamMember type round-trip", () => {
    const parsed = teamMemberSchema.parse(member());
    expect(parsed.species).toBe("garchomp");
    expect(parsed.evs.atk).toBe(252);
  });
});

// ---------------------------------------------------------------------------
// teamMembersSchema
// ---------------------------------------------------------------------------

describe("teamMembersSchema", () => {
  it("accepts an empty team (0 members)", () => {
    expect(teamMembersSchema.safeParse([]).success).toBe(true);
  });

  it("accepts a full 6-member team", () => {
    const six = Array.from({ length: 6 }, () => member());
    expect(teamMembersSchema.safeParse(six).success).toBe(true);
  });

  it("rejects more than 6 members", () => {
    const seven = Array.from({ length: 7 }, () => member());
    expect(teamMembersSchema.safeParse(seven).success).toBe(false);
  });

  it("rejects a member that itself fails validation", () => {
    expect(teamMembersSchema.safeParse([member({ level: 0 })]).success).toBe(false);
  });
});
