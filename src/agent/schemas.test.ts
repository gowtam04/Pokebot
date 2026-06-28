/**
 * Unit tests for the team-builder additions to the agent schema contract
 * (src/agent/schemas.ts): the additive `proposed_team` field on the `.strict()`
 * OakAnswer (TEAM-AD-6) and the T12 `get_active_team` I/O.
 *
 * Pure schema tests — no DB / server-only (schemas.ts pulls only the shared
 * team-schema and a type-only EnrichedActiveTeam import).
 *
 * Focus:
 *   - backward-compat: a stored answer_json WITHOUT proposed_team still parses;
 *   - a valid proposed_team parses; an unknown key / bad format is rejected;
 *   - get_active_team is in TOOL_NAMES with an empty, strict input schema.
 */

import { describe, expect, it } from "vitest";

import {
  oakAnswerSchema,
  getActiveTeamInputSchema,
  TOOL_NAMES,
  toolInputJsonSchemas,
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

describe("get_active_team I/O (T12)", () => {
  it("registers get_active_team in TOOL_NAMES and toolInputJsonSchemas", () => {
    expect(TOOL_NAMES).toContain("get_active_team");
    expect(toolInputJsonSchemas.get_active_team).toBeDefined();
  });

  it("input schema accepts {} and rejects any team-selecting argument", () => {
    expect(getActiveTeamInputSchema.safeParse({}).success).toBe(true);
    expect(
      getActiveTeamInputSchema.safeParse({ team_id: "abc" }).success,
    ).toBe(false);
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
