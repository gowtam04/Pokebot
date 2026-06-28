/**
 * eval/judge.test.ts — focused unit tests for eval/judge.ts.
 *
 * Coverage:
 *   - runStructural: all seven assertion dimensions
 *   - runJudgedWith: orchestration, multi-turn, tool-call capture, score aggregation
 *
 * Design constraints (design.md § Testing Strategy — mocking policy):
 *   - @/agent/runtime is mocked so no SQLite / real Anthropic calls are made.
 *   - The judge Anthropic client is injected via runJudgedWith (injectable seam).
 *   - env ANTHROPIC_API_KEY is the test-dummy injected by vitest.config.ts.
 *
 * What is NOT tested here (covered elsewhere):
 *   - The actual quality of the LLM judge's rubric reasoning (eval golden suite).
 *   - The main agent's tool loop (src/agent/runtime.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OakAnswer } from "@/agent/schemas";
import type { AgentContext } from "@/agent/types";

// ── Mock @/agent/runtime to prevent SQLite / Anthropic imports ─────────────
vi.mock("@/agent/runtime", () => ({
  runOak: vi.fn(),
  default: vi.fn(),
}));

import {
  runStructural,
  runJudgedWith,
  type GoldenCase,
  type JudgeClientLike,
  type RunOakFn,
} from "./judge";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "Garchomp is Dragon/Ground with 102 base Speed.",
  reasoning_markdown: "Looked up Garchomp's profile.",
  citations: [{ source: "pokemon/garchomp", detail: "base speed: 102" }],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

const CANDIDATE_ANSWER: OakAnswer = {
  ...BASE_ANSWER,
  candidates: {
    total_count: 6,
    truncated: false,
    shown: [
      {
        name: "Ninetales",
        types: ["fire"],
        sprite_url: "https://example.com/ninetales.png",
      },
      {
        name: "Ceruledge",
        types: ["fire", "ghost"],
        sprite_url: "https://example.com/ceruledge.png",
      },
    ],
  },
};

const FALLBACK_ANSWER: OakAnswer = {
  ...BASE_ANSWER,
  subjects: [
    {
      name: "Dracovish",
      sprite_url: "https://example.com/dracovish.png",
      types: ["water", "dragon"],
      is_fallback: true,
      source_generation: "gen-8",
    },
  ],
  generation_basis: {
    generation: "gen-8",
    fallback: true,
    note: "Dracovish is gen-8",
  },
};

function makeGoldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "G1",
    input: "find a Pokémon that can learn both Trick Room and Will-O-Wisp",
    expect: {},
    covers: ["US-1", "BR-7"],
    ...overrides,
  };
}

const SILENT_CTX = {
  db: {},
  requestId: "test-req",
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => SILENT_CTX.logger,
    bindings: () => ({}),
  },
} as unknown as AgentContext;

// ─── Helpers for mocked clients ───────────────────────────────────────────────

type DimScore = { score: 0 | 1 | 2; reason: string };
type MockJudgment = {
  answer_correctness: DimScore;
  inference_flagging: DimScore;
  mechanics_precision: DimScore;
  scope_adherence: DimScore;
  transparency: DimScore;
};

function mockJudgeClient(judgment: MockJudgment): JudgeClientLike {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        id: "msg_judge",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 30 },
        content: [
          {
            type: "tool_use",
            id: "tu_judge",
            name: "submit_judgment",
            input: judgment,
          },
        ],
      }),
    },
  };
}

function mockRunOak(
  answer: OakAnswer,
  toolsToEmit: string[] = [],
): RunOakFn {
  const fn = vi
    .fn()
    .mockImplementation(
      async (
        _message: string,
        _history: unknown,
        _ctx: unknown,
        onProgress?: (e: { tool: string; label: string }) => void,
      ) => {
        for (const tool of toolsToEmit) {
          onProgress?.({ tool, label: `Running ${tool}` });
        }
        return answer;
      },
    );
  return fn as unknown as RunOakFn;
}

const PASSING_JUDGMENT: MockJudgment = {
  answer_correctness: { score: 2, reason: "Correct." },
  inference_flagging: { score: 2, reason: "Correct." },
  mechanics_precision: { score: 2, reason: "Correct." },
  scope_adherence: { score: 2, reason: "Correct." },
  transparency: { score: 2, reason: "Correct." },
};

// ─── runStructural ────────────────────────────────────────────────────────────

describe("runStructural", () => {
  it("returns empty failures when all assertions are satisfied", () => {
    const gc = makeGoldenCase({
      expect: {
        status: "answered",
        minCandidates: 2,
        mustCite: ["pokemon/garchomp"],
        mustInclude: ["Dragon/Ground"],
        toolEfficiency: { usedTool: "query_pokedex", maxPerPokemonFetches: 2 },
      },
    });
    const toolCalls = ["query_pokedex", "get_pokemon"];
    const failures = runStructural(CANDIDATE_ANSWER, gc, toolCalls);
    expect(failures).toHaveLength(0);
  });

  describe("status assertion", () => {
    it("fails when status does not match expected", () => {
      const gc = makeGoldenCase({ expect: { status: "clarification_needed" } });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([expect.stringContaining("status")]),
      );
    });

    it("passes when status is not specified in expect", () => {
      const gc = makeGoldenCase({ expect: {} });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures.filter((f) => f.startsWith("status"))).toHaveLength(0);
    });
  });

  describe("minCandidates assertion", () => {
    it("fails when total_count is below minCandidates", () => {
      const gc = makeGoldenCase({ expect: { minCandidates: 10 } });
      const failures = runStructural(CANDIDATE_ANSWER, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([expect.stringContaining("minCandidates")]),
      );
    });

    it("passes when total_count meets minCandidates", () => {
      const gc = makeGoldenCase({ expect: { minCandidates: 6 } });
      const failures = runStructural(CANDIDATE_ANSWER, gc, []);
      expect(
        failures.filter((f) => f.startsWith("minCandidates")),
      ).toHaveLength(0);
    });

    it("fails when candidates is absent and minCandidates > 0", () => {
      const gc = makeGoldenCase({ expect: { minCandidates: 1 } });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([expect.stringContaining("minCandidates")]),
      );
    });
  });

  describe("mustCite assertion", () => {
    it("fails when a required source prefix is absent from citations", () => {
      const gc = makeGoldenCase({
        expect: { mustCite: ["learnset/will-o-wisp"] },
      });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'mustCite: no citation with source prefix "learnset/will-o-wisp"',
          ),
        ]),
      );
    });

    it("passes when the source prefix matches a citation", () => {
      const gc = makeGoldenCase({ expect: { mustCite: ["pokemon/garchomp"] } });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures.filter((f) => f.startsWith("mustCite"))).toHaveLength(0);
    });

    it("passes when mustCite is an empty array", () => {
      const gc = makeGoldenCase({ expect: { mustCite: [] } });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures.filter((f) => f.startsWith("mustCite"))).toHaveLength(0);
    });
  });

  describe("mustInclude assertion", () => {
    it("fails when a required substring is absent from answer_markdown", () => {
      const gc = makeGoldenCase({ expect: { mustInclude: ["169 Speed"] } });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'mustInclude: answer_markdown does not contain "169 Speed"',
          ),
        ]),
      );
    });

    it("passes when all required substrings are present", () => {
      const gc = makeGoldenCase({
        expect: { mustInclude: ["Dragon/Ground", "102"] },
      });
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(failures.filter((f) => f.startsWith("mustInclude"))).toHaveLength(
        0,
      );
    });
  });

  describe("toolEfficiency assertion", () => {
    it("fails when the required tool was never called", () => {
      const gc = makeGoldenCase({
        expect: {
          toolEfficiency: {
            usedTool: "query_pokedex",
            maxPerPokemonFetches: 1,
          },
        },
      });
      // toolCalls does not contain query_pokedex
      const failures = runStructural(BASE_ANSWER, gc, ["get_pokemon"]);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"query_pokedex" was never called'),
        ]),
      );
    });

    it("fails when get_pokemon is called too many times per result", () => {
      // CANDIDATE_ANSWER has 2 shown results; maxPerPokemonFetches=1 means max 2 calls.
      // 5 get_pokemon calls should fail.
      const gc = makeGoldenCase({
        expect: {
          toolEfficiency: {
            usedTool: "query_pokedex",
            maxPerPokemonFetches: 1,
          },
        },
      });
      const toolCalls = [
        "query_pokedex",
        "get_pokemon",
        "get_pokemon",
        "get_pokemon",
        "get_pokemon",
        "get_pokemon",
      ];
      const failures = runStructural(CANDIDATE_ANSWER, gc, toolCalls);
      expect(failures).toEqual(
        expect.arrayContaining([expect.stringContaining("toolEfficiency")]),
      );
    });

    it("passes when get_pokemon calls are within the bound", () => {
      const gc = makeGoldenCase({
        expect: {
          toolEfficiency: {
            usedTool: "query_pokedex",
            maxPerPokemonFetches: 2,
          },
        },
      });
      // 2 results * maxPerPokemonFetches 2 = 4 allowed; 2 get_pokemon calls = pass
      const toolCalls = ["query_pokedex", "get_pokemon", "get_pokemon"];
      const failures = runStructural(CANDIDATE_ANSWER, gc, toolCalls);
      expect(
        failures.filter((f) => f.startsWith("toolEfficiency")),
      ).toHaveLength(0);
    });
  });

  describe("citation_presence assertion (BR-4)", () => {
    it("fails for answered factual answer with empty citations and subjects", () => {
      const factualWithoutCitations: OakAnswer = {
        ...BASE_ANSWER,
        citations: [],
        subjects: [
          {
            name: "Garchomp",
            sprite_url: "https://example.com/garchomp.png",
            types: ["dragon", "ground"],
            is_fallback: false,
          },
        ],
      };
      const gc = makeGoldenCase();
      const failures = runStructural(factualWithoutCitations, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([expect.stringContaining("citation_presence")]),
      );
    });

    it("does NOT fail for answered scope-decline with no subjects/candidates/damage_calc", () => {
      const scopeDecline: OakAnswer = {
        status: "answered",
        answer_markdown: "Egg moves are outside what I cover.",
        reasoning_markdown: "Out of scope.",
        citations: [],
        inferences: [],
        generation_basis: { generation: "gen-9", fallback: false },
      };
      const gc = makeGoldenCase({ expect: { status: "answered" } });
      const failures = runStructural(scopeDecline, gc, []);
      expect(
        failures.filter((f) => f.startsWith("citation_presence")),
      ).toHaveLength(0);
    });

    it("does NOT fail for clarification_needed with empty citations", () => {
      const clarification: OakAnswer = {
        status: "clarification_needed",
        answer_markdown: 'Did you mean "Will-O-Wisp"?',
        reasoning_markdown: "Name not found.",
        citations: [],
        inferences: [],
        suggestions: ["Will-O-Wisp"],
        generation_basis: { generation: "gen-9", fallback: false },
      };
      const gc = makeGoldenCase();
      const failures = runStructural(clarification, gc, []);
      expect(
        failures.filter((f) => f.startsWith("citation_presence")),
      ).toHaveLength(0);
    });
  });

  describe("generation_correctness assertion (BR-1)", () => {
    it("fails when subjects has is_fallback=true but generation_basis.fallback=false", () => {
      const bad: OakAnswer = {
        ...FALLBACK_ANSWER,
        generation_basis: { generation: "gen-9", fallback: false }, // inconsistent
      };
      const gc = makeGoldenCase();
      const failures = runStructural(bad, gc, []);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("generation_correctness"),
        ]),
      );
    });

    it("passes when fallback is consistent (fallback=true on both)", () => {
      const gc = makeGoldenCase();
      const failures = runStructural(FALLBACK_ANSWER, gc, []);
      expect(
        failures.filter((f) => f.startsWith("generation_correctness")),
      ).toHaveLength(0);
    });

    it("passes when no subjects are fallback and generation_basis.fallback=false", () => {
      const gc = makeGoldenCase();
      const failures = runStructural(BASE_ANSWER, gc, []);
      expect(
        failures.filter((f) => f.startsWith("generation_correctness")),
      ).toHaveLength(0);
    });
  });
});

// ─── runJudgedWith ────────────────────────────────────────────────────────────

describe("runJudgedWith", () => {
  let judgeClient: JudgeClientLike;
  let runOak: RunOakFn;

  beforeEach(() => {
    judgeClient = mockJudgeClient(PASSING_JUDGMENT);
    runOak = mockRunOak(BASE_ANSWER, ["query_pokedex"]);
  });

  it("calls runOak once for a single-turn case", async () => {
    const gc = makeGoldenCase({ input: "is Garchomp fast?" });
    await runJudgedWith([gc], SILENT_CTX, judgeClient, runOak);
    expect(runOak).toHaveBeenCalledOnce();
    expect(runOak).toHaveBeenCalledWith(
      "is Garchomp fast?",
      [],
      SILENT_CTX,
      expect.any(Function),
    );
  });

  it("calls runOak once per turn for a multi-turn case", async () => {
    const gc = makeGoldenCase({
      id: "G19",
      input: [
        "find a Pokémon that can learn both Trick Room and Will-O-Wisp",
        "now only the Fire types",
      ],
      covers: ["US-10"],
    });
    await runJudgedWith([gc], SILENT_CTX, judgeClient, runOak);
    expect(runOak).toHaveBeenCalledTimes(2);
  });

  it("passes accumulated history to subsequent turns", async () => {
    const gc = makeGoldenCase({
      id: "G19",
      input: ["first question", "follow-up question"],
      covers: [],
    });
    await runJudgedWith([gc], SILENT_CTX, judgeClient, runOak);

    const secondCallArgs = vi.mocked(runOak).mock.calls[1];
    // Second call should have non-empty history (the first turn's exchange).
    const history = secondCallArgs[1] as unknown[];
    expect(history).toHaveLength(2); // one user turn + one assistant turn
  });

  it("captures tool calls from onProgress into JudgeResult.toolCalls", async () => {
    runOak = mockRunOak(BASE_ANSWER, [
      "query_pokedex",
      "get_pokemon",
      "submit_answer",
    ]);
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.toolCalls).toEqual([
      "query_pokedex",
      "get_pokemon",
      "submit_answer",
    ]);
  });

  it("calls the judge client once per case", async () => {
    const cases = [makeGoldenCase({ id: "G1" }), makeGoldenCase({ id: "G2" })];
    await runJudgedWith(cases, SILENT_CTX, judgeClient, runOak);
    expect(judgeClient.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns JudgeResult with correct caseId and input", async () => {
    const gc = makeGoldenCase({
      id: "G5",
      input: "Fire types with Flash Fire",
    });
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.caseId).toBe("G5");
    expect(result.input).toBe("Fire types with Flash Fire");
  });

  it("returns the OakAnswer produced by runOak", async () => {
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.answer).toEqual(BASE_ANSWER);
  });

  it("includes the covers array from the GoldenCase", async () => {
    const gc = makeGoldenCase({ covers: ["US-1", "BR-7"] });
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.covers).toEqual(["US-1", "BR-7"]);
  });

  it("populates scores with one entry per rubric dimension", async () => {
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    const dimNames = result.scores.map((s) => s.dimension);
    expect(dimNames).toEqual(
      expect.arrayContaining([
        "answer_correctness",
        "inference_flagging",
        "mechanics_precision",
        "scope_adherence",
        "transparency",
      ]),
    );
    expect(result.scores).toHaveLength(5);
  });

  it("reports overallPass=true when all rubric scores pass and no structural failures", async () => {
    const gc = makeGoldenCase({ expect: { status: "answered" } });
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.overallPass).toBe(true);
    expect(result.structuralFailures).toHaveLength(0);
  });

  it("reports overallPass=false when a structural assertion fails", async () => {
    // Expect status=clarification_needed but agent returns "answered"
    const gc = makeGoldenCase({ expect: { status: "clarification_needed" } });
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.overallPass).toBe(false);
    expect(result.structuralFailures).not.toHaveLength(0);
  });

  it("reports overallPass=false when any rubric score is 0", async () => {
    judgeClient = mockJudgeClient({
      ...PASSING_JUDGMENT,
      answer_correctness: { score: 0, reason: "Wrong conclusion." },
    });
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.overallPass).toBe(false);
    const failing = result.scores.find(
      (s) => s.dimension === "answer_correctness",
    );
    expect(failing?.pass).toBe(false);
    expect(failing?.score).toBe(0);
  });

  it("treats score=1 (partial) as passing (overallPass not blocked)", async () => {
    judgeClient = mockJudgeClient({
      ...PASSING_JUDGMENT,
      transparency: { score: 1, reason: "Mostly transparent." },
    });
    const gc = makeGoldenCase({ expect: { status: "answered" } });
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.overallPass).toBe(true);
    const partial = result.scores.find((s) => s.dimension === "transparency");
    expect(partial?.pass).toBe(true);
    expect(partial?.score).toBe(1);
  });

  it("records agentLatencyMs and judgeLatencyMs as non-negative numbers", async () => {
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(result.agentLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.judgeLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("handles an empty cases array without error", async () => {
    const results = await runJudgedWith(
      [],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    expect(results).toEqual([]);
    expect(runOak).not.toHaveBeenCalled();
    expect(judgeClient.messages.create).not.toHaveBeenCalled();
  });

  it("uses the judge's reason text in the returned score", async () => {
    judgeClient = mockJudgeClient({
      ...PASSING_JUDGMENT,
      mechanics_precision: {
        score: 2,
        reason: "Immunity stated correctly as 0×.",
      },
    });
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      judgeClient,
      runOak,
    );
    const mech = result.scores.find(
      (s) => s.dimension === "mechanics_precision",
    );
    expect(mech?.reason).toBe("Immunity stated correctly as 0×.");
  });
});

// ─── Score clamping edge cases ────────────────────────────────────────────────

describe("score clamping", () => {
  it("clamps a score > 2 down to 2", async () => {
    // Send a judgment with score=3 (out-of-range) — should be treated as 2.
    const client = mockJudgeClient({
      ...PASSING_JUDGMENT,
      scope_adherence: { score: 3 as unknown as 2, reason: "Perfect." },
    });
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      client,
      mockRunOak(BASE_ANSWER),
    );
    const scopeScore = result.scores.find(
      (s) => s.dimension === "scope_adherence",
    );
    expect(scopeScore?.score).toBe(2);
    expect(scopeScore?.pass).toBe(true);
  });

  it("clamps a negative score to 0", async () => {
    const client = mockJudgeClient({
      ...PASSING_JUDGMENT,
      answer_correctness: { score: -1 as unknown as 0, reason: "Very wrong." },
    });
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      client,
      mockRunOak(BASE_ANSWER),
    );
    const correctness = result.scores.find(
      (s) => s.dimension === "answer_correctness",
    );
    expect(correctness?.score).toBe(0);
    expect(correctness?.pass).toBe(false);
  });
});

// ─── Judge fallback when tool not called ─────────────────────────────────────

describe("judge fallback", () => {
  it("returns partial-pass scores when judge does not use the tool", async () => {
    const noToolClient: JudgeClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          id: "msg_notool",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 10 },
          content: [{ type: "text", text: "The answer looks correct." }],
        }),
      },
    };
    const gc = makeGoldenCase();
    const [result] = await runJudgedWith(
      [gc],
      SILENT_CTX,
      noToolClient,
      mockRunOak(BASE_ANSWER),
    );
    // All scores should default to 1 (partial pass)
    expect(result.scores.every((s) => s.score === 1 && s.pass === true)).toBe(
      true,
    );
    // overallPass — the structural check for status passes (no expected status),
    // and all scores are 1 (partial pass), so overall should pass.
    expect(result.overallPass).toBe(true);
  });
});
