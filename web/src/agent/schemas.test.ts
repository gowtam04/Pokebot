/**
 * Unit tests for the team-builder additions to the agent schema contract
 * (src/agent/schemas.ts): the additive `proposed_team` field on the `.strict()`
 * OakAnswer (TEAM-AD-6) and the team-lookup tool I/O (`get_team` / `list_teams`).
 *
 * Pure schema tests — no DB / server-only (schemas.ts pulls only the shared
 * team-schema and a type-only EnrichedActiveTeam import).
 *
 * Focus:
 *   - backward-compat: a stored answer_json WITHOUT proposed_team still parses;
 *   - a valid proposed_team parses; an unknown key / bad format is rejected;
 *   - get_team takes a `team_id` and list_teams takes no args; both are in
 *     TOOL_NAMES with strict input schemas.
 */

import { describe, expect, it } from "vitest";

import {
  oakAnswerSchema,
  getTeamInputSchema,
  listTeamsInputSchema,
  TOOL_NAMES,
  toolInputJsonSchemas,
  TYPE_DISPLAY_ORDER,
  TYPE_NAMES,
  typeDisplayIndex,
  type OakAnswer,
} from "@/agent/schemas";
import type { TeamMember } from "@/data/teams/team-schema";

/** A minimal valid OakAnswer (the pre-team-builder required surface). */
const BASE_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "Bottom line.",
  reasoning_markdown: "Because.",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

const MEMBER: TeamMember = {
  species: "garchomp",
  ability: "rough-skin",
  item: "life-orb",
  moves: ["earthquake", "dragon-claw"],
  nature: "jolly",
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "fire",
  level: 50,
};

describe("oakAnswerSchema — proposed_team (TEAM-AD-6)", () => {
  it("parses a stored answer WITHOUT proposed_team (backward compatible)", () => {
    const parsed = oakAnswerSchema.safeParse(BASE_ANSWER);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.proposed_team).toBeUndefined();
    }
  });

  it("parses an answer carrying a valid proposed_team", () => {
    const parsed = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      proposed_team: {
        name: "Rain Offense",
        format: "scarlet-violet",
        members: [MEMBER],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts both formats in proposed_team.format and rejects an unknown one", () => {
    for (const format of ["scarlet-violet", "champions"] as const) {
      const parsed = oakAnswerSchema.safeParse({
        ...BASE_ANSWER,
        proposed_team: { name: "T", format, members: [] },
      });
      expect(parsed.success).toBe(true);
    }
    const bad = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      proposed_team: { name: "T", format: "gen-1", members: [] },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown key inside proposed_team (.strict())", () => {
    const parsed = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      proposed_team: {
        name: "T",
        format: "scarlet-violet",
        members: [],
        notes: "nope",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("still rejects unknown TOP-LEVEL keys (the answer stays strict)", () => {
    const parsed = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      not_a_field: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("oakAnswerSchema — proposed_team_warnings (server-stamped, BR-T5)", () => {
  it("parses a stored answer WITHOUT proposed_team_warnings (backward compatible)", () => {
    const parsed = oakAnswerSchema.safeParse(BASE_ANSWER);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.proposed_team_warnings).toBeUndefined();
    }
  });

  it("parses an answer carrying a species_illegal warning", () => {
    const parsed = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      proposed_team: { name: "T", format: "champions", members: [MEMBER] },
      proposed_team_warnings: [
        {
          code: "species_illegal",
          message: 'Species "heatran" is not legal in this format.',
          slot: 0,
          field: "species",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.proposed_team_warnings?.[0]?.code).toBe(
        "species_illegal",
      );
    }
  });

  it("rejects an unknown warning code (.strict() enum)", () => {
    const parsed = oakAnswerSchema.safeParse({
      ...BASE_ANSWER,
      proposed_team_warnings: [{ code: "not_a_code", message: "x" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("team-lookup I/O (get_team T12, list_teams T16)", () => {
  it("registers get_team and list_teams in TOOL_NAMES and toolInputJsonSchemas", () => {
    expect(TOOL_NAMES).toContain("get_team");
    expect(TOOL_NAMES).toContain("list_teams");
    expect(toolInputJsonSchemas.get_team).toBeDefined();
    expect(toolInputJsonSchemas.list_teams).toBeDefined();
    // The retired server-bound tool is gone from the contract.
    expect(TOOL_NAMES).not.toContain("get_active_team");
  });

  it("get_team requires a non-empty team_id and rejects strays", () => {
    expect(getTeamInputSchema.safeParse({ team_id: "t_rain" }).success).toBe(
      true,
    );
    expect(getTeamInputSchema.safeParse({}).success).toBe(false);
    expect(getTeamInputSchema.safeParse({ team_id: "" }).success).toBe(false);
    expect(
      getTeamInputSchema.safeParse({ team_id: "t_rain", extra: 1 }).success,
    ).toBe(false);
  });

  it("list_teams accepts {} and rejects any argument", () => {
    expect(listTeamsInputSchema.safeParse({}).success).toBe(true);
    expect(listTeamsInputSchema.safeParse({ name: "rain" }).success).toBe(false);
  });
});

describe("TYPE_DISPLAY_ORDER / typeDisplayIndex (Champions display order)", () => {
  it("is a permutation of TYPE_NAMES (same 18 members, presentation order only)", () => {
    expect(TYPE_DISPLAY_ORDER).toHaveLength(18);
    expect(new Set(TYPE_DISPLAY_ORDER).size).toBe(TYPE_DISPLAY_ORDER.length);
    expect(new Set(TYPE_DISPLAY_ORDER)).toEqual(new Set(TYPE_NAMES));
  });

  it("starts with the Champions order normal, grass, fire, water", () => {
    expect(TYPE_DISPLAY_ORDER.slice(0, 4)).toEqual([
      "normal",
      "grass",
      "fire",
      "water",
    ]);
  });

  it("returns the slot index; unknown/empty sorts last", () => {
    expect(typeDisplayIndex("normal")).toBe(0);
    expect(typeDisplayIndex("grass")).toBe(1);
    expect(typeDisplayIndex("fire")).toBe(2);
    expect(typeDisplayIndex("water")).toBe(3);
    expect(typeDisplayIndex("fairy")).toBe(17);
    expect(typeDisplayIndex("")).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeDisplayIndex("notatype")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("submit_answer JSON Schema — xAI strict-safe (P3a)", () => {
  // xAI tool-call arguments are ALWAYS implicitly strict; its validator can
  // reject an open `additionalProperties: {}` (what z.record(z.unknown())
  // generates). The free-form maps (candidate key_stats, damage_calc
  // assumptions/result) are typed as JSON scalars so they emit a CONCRETE
  // additionalProperties schema instead. Guard that no bare `{}` map remains.
  it("has no bare `additionalProperties: {}` anywhere", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const ap = obj.additionalProperties;
      if (
        ap !== null &&
        typeof ap === "object" &&
        !Array.isArray(ap) &&
        Object.keys(ap as object).length === 0
      ) {
        offenders.push(`${path}.additionalProperties`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(toolInputJsonSchemas.submit_answer, "submit_answer");
    expect(offenders).toEqual([]);
  });
});
