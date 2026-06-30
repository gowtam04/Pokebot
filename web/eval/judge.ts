/**
 * eval/judge.ts — LLM-as-judge rubric + scoring (design.md Phase 8; evaluation.md § Metrics).
 *
 * WIRED but NOT RUN LIVE in the current build phase.
 * eval/run.ts controls when runJudged is invoked (nightly / on release).
 *
 * Exports:
 *   Types:
 *     GoldenCase        — shared case contract (cases.ts, deterministic.ts, run.ts)
 *     AssertResult      — structural-only result for the Vitest CI subset
 *     RubricDimension   — string union of LLM-judged dimensions
 *     RubricScore       — per-dimension score (0/1/2 + reason)
 *     JudgeResult       — full result: structural failures + LLM rubric + timing
 *     JudgeClientLike   — injectable judge-client seam
 *     RunOakFn      — injectable runOak seam
 *   Functions:
 *     runStructural     — structural assertions only (fast, no LLM).
 *                         Exported for eval/deterministic.ts CI subset.
 *     runJudgedWith     — full pipeline with injected clients (used in tests).
 *     runJudged         — production entry point (real Anthropic + real runOak).
 *
 * Risk-directive note:
 *   The judge uses `tool_choice: { type: "tool", name: "submit_judgment" }` WITHOUT
 *   adaptive thinking. The HARD 400 on Sonnet 4.6 fires only when thinking AND
 *   forced tool_choice are BOTH enabled. Omitting thinking for the judge is correct
 *   and intentional — it does not need reasoning chains, only rubric application.
 */

import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/env";
import { runOak as defaultRunOak } from "@/agent/runtime";
import type { AgentContext, ChatMessage } from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One golden test case (design.md § Interface Definitions — Eval harness).
 *
 * This is the SINGLE SOURCE OF TRUTH for the GoldenCase type. All other eval
 * modules (cases.ts, deterministic.ts, run.ts) import from here.
 */
export interface GoldenCase {
  /** "G1"…"G24" */
  id: string;
  /**
   * User input. A plain string for single-turn cases; a string[] for multi-turn
   * cases where each element is one user message in sequence (e.g. G19 follow-up).
   */
  input: string | string[];
  expect: {
    /** Expected OakAnswer.status value. */
    status?: OakAnswer["status"];
    /** candidates.total_count must be >= this value. */
    minCandidates?: number;
    /**
     * Every string here must appear as a prefix in at least one
     * citations[].source, e.g. "move/fake-out", "learnset/will-o-wisp (gen-9)".
     */
    mustCite?: string[];
    /** Every string here must appear as a substring of answer_markdown. */
    mustInclude?: string[];
    /**
     * Tool efficiency gate:
     *   - `usedTool` must appear at least once in the tool call trace.
     *   - The number of `get_pokemon` calls must not exceed `maxPerPokemonFetches`
     *     times the number of Pokémon in the result set (guards brute-force fetching).
     */
    toolEfficiency?: {
      usedTool: string;
      maxPerPokemonFetches: number;
    };
    /** true → this case is in the Vitest CI subset (eval/deterministic.ts). */
    deterministic?: boolean;
    /**
     * Judge-only expected-behavior note. Ignored by runStructural; surfaced to the
     * LLM judge via buildJudgeUserMessage as a "## Expected Behavior" line. Use it to
     * tell the judge what a CORRECT response looks like when status alone is
     * ambiguous — e.g. that an out-of-scope decline (status "answered" with empty
     * citations) is the right outcome.
     */
    rubricNote?: string;
  };
  /** Requirement IDs covered by this case, e.g. ["US-1", "BR-7", "BR-2"]. */
  covers: string[];
}

/**
 * Result of structural-only assertion (no LLM). Returned by the Vitest CI subset
 * in eval/deterministic.ts via runStructural.
 */
export interface AssertResult {
  caseId: string;
  pass: boolean;
  failures: string[];
  answer: OakAnswer;
}

/**
 * The five dimensions the LLM judge scores (evaluation.md § Metrics —
 * answer correctness, inference-flag accuracy, mechanics precision,
 * scope adherence, transparency).
 */
export type RubricDimension =
  | "answer_correctness"
  | "inference_flagging"
  | "mechanics_precision"
  | "scope_adherence"
  | "transparency";

/** Per-dimension LLM score. 0 = fail, 1 = partial pass, 2 = full pass. */
export interface RubricScore {
  dimension: RubricDimension;
  /** true when score >= 1 (at least a partial pass). */
  pass: boolean;
  score: 0 | 1 | 2;
  reason: string;
}

/**
 * Full result for one golden case: structural failures + LLM rubric scores + timing.
 * Returned by runJudged / runJudgedWith.
 */
export interface JudgeResult {
  caseId: string;
  input: string | string[];
  answer: OakAnswer;
  /** Tool names in call order, captured from onProgress during the agent run. */
  toolCalls: string[];
  /** Structural assertion failures (empty = all structural checks pass). */
  structuralFailures: string[];
  /** LLM rubric scores — one entry per RubricDimension. */
  scores: RubricScore[];
  /**
   * true when structuralFailures is empty AND every rubric score >= 1.
   * (partial passes count as passing; only score=0 is a hard failure.)
   */
  overallPass: boolean;
  agentLatencyMs: number;
  judgeLatencyMs: number;
  covers: string[];
}

// ─── Injectable seam types ────────────────────────────────────────────────────

/** Subset of the Anthropic client that the judge uses. */
export interface JudgeClientLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

/** The runOak signature the judge depends on (mirrors @/agent/runtime). */
export type RunOakFn = typeof defaultRunOak;

// ─── Structural assertions ────────────────────────────────────────────────────

/**
 * Run all deterministic (structural) assertions for one case. Returns an array of
 * human-readable failure strings; empty = all assertions pass.
 *
 * Exported for eval/deterministic.ts so the Vitest CI subset shares these checks
 * without re-implementing them.
 *
 * Assertions performed (evaluation.md § Metrics):
 *   1. Expected status
 *   2. Minimum candidate count (total_count)
 *   3. mustCite — source prefixes present in citations[]
 *   4. mustInclude — substrings present in answer_markdown
 *   5. Tool efficiency — usedTool present; get_pokemon calls bounded
 *   6. Citation presence for factual "answered" cases (BR-4)
 *   7. Generation correctness — fallback flag consistent with subjects (BR-1)
 */
export function runStructural(
  answer: OakAnswer,
  gc: GoldenCase,
  toolCalls: string[],
): string[] {
  const failures: string[] = [];

  // 1. Expected status
  if (gc.expect.status !== undefined && answer.status !== gc.expect.status) {
    failures.push(
      `status: expected "${gc.expect.status}", got "${answer.status}"`,
    );
  }

  // 2. Minimum candidate count
  if (gc.expect.minCandidates !== undefined) {
    const actual = answer.candidates?.total_count ?? 0;
    if (actual < gc.expect.minCandidates) {
      failures.push(
        `minCandidates: expected >= ${gc.expect.minCandidates}, got ${actual}`,
      );
    }
  }

  // 3. mustCite — every required source prefix must be present in citations[].source
  for (const prefix of gc.expect.mustCite ?? []) {
    const found = answer.citations.some((c) => c.source.startsWith(prefix));
    if (!found) {
      failures.push(`mustCite: no citation with source prefix "${prefix}"`);
    }
  }

  // 4. mustInclude — every required substring must appear in answer_markdown
  for (const needle of gc.expect.mustInclude ?? []) {
    if (!answer.answer_markdown.includes(needle)) {
      failures.push(
        `mustInclude: answer_markdown does not contain "${needle}"`,
      );
    }
  }

  // 5. Tool efficiency
  if (gc.expect.toolEfficiency) {
    const { usedTool, maxPerPokemonFetches } = gc.expect.toolEfficiency;

    if (!toolCalls.includes(usedTool)) {
      failures.push(
        `toolEfficiency: "${usedTool}" was never called (expected >= 1 call)`,
      );
    }

    // Brute-force guard: count get_pokemon calls against the result set size.
    // Use max(1) so single-Pokémon queries still get the guard.
    const pokemonFetches = toolCalls.filter((t) => t === "get_pokemon").length;
    const resultCount = Math.max(
      answer.candidates?.shown.length ?? 0,
      answer.subjects?.length ?? 0,
      1,
    );
    if (pokemonFetches > maxPerPokemonFetches * resultCount) {
      failures.push(
        `toolEfficiency: get_pokemon called ${pokemonFetches} times for ${resultCount} result(s) ` +
          `(max ${maxPerPokemonFetches} per result = ${maxPerPokemonFetches * resultCount} allowed)`,
      );
    }
  }

  // 6. Citation presence for factual "answered" cases (BR-4).
  //    Pure scope-declines are the only answered cases that may have empty citations
  //    (output-formats.md § Failure/Abstention Output example E). Heuristic: if
  //    there are subjects, candidates, or a damage_calc, the answer is factual.
  if (answer.status === "answered" && answer.citations.length === 0) {
    const hasFacts =
      (answer.subjects?.length ?? 0) > 0 ||
      (answer.candidates?.shown.length ?? 0) > 0 ||
      answer.damage_calc !== undefined;
    if (hasFacts) {
      failures.push(
        "citation_presence: status=answered with factual content but citations[] is empty (BR-4)",
      );
    }
  }

  // 7. Generation correctness — if any subject is flagged as a fallback, the
  //    top-level generation_basis.fallback must also be true (BR-1).
  const anyFallbackSubject = (answer.subjects ?? []).some((s) => s.is_fallback);
  if (anyFallbackSubject && !answer.generation_basis.fallback) {
    failures.push(
      "generation_correctness: subjects[] contain is_fallback=true but generation_basis.fallback=false (BR-1)",
    );
  }

  return failures;
}

// ─── LLM judge prompt & tool ──────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for Oak, a Pokémon knowledge agent built on Gen 9 (Scarlet/Violet) data.
Your task: given a user question, a description of the expected behavior, and the agent's OakAnswer JSON, score the answer on five rubric dimensions.
Each dimension gets an integer score: 0 (fail), 1 (partial pass), or 2 (full pass).

RUBRIC DIMENSIONS

1. answer_correctness
   Is the answer's bottom-line conclusion factually correct with correct Pokémon mechanics?
   2 = clearly correct and complete — no factual errors, no missing critical pieces.
   1 = mostly correct but has a minor gap, omission, or a low-stakes imprecision.
   0 = wrong conclusion, fabricated Pokémon data, or a critical mechanical error.

2. inference_flagging
   Are the agent's OWN DEDUCTIONS placed in inferences[] with a confidence level?
   Facts the tools returned (priority values, stat numbers, effect text) should NOT be in inferences[].
   Conversely, deductions like "Armor Tail therefore blocks Fake Out" MUST be in inferences[].
   2 = perfectly separated — all deductions flagged, no facts mislabeled.
   1 = one item mislabeled (a fact in inferences, or a deduction omitted).
   0 = systematic failure — key deductions absent, or inferences[] filled with plain facts.

3. mechanics_precision
   For type effectiveness, priority, ability effects, and formula results:
   are the specifics precise? Critical test: immunities MUST be stated as "immune" or "0×",
   NOT as "not very effective". Priority values and ability effect text must be accurate.
   2 = all mechanical assertions precise.
   1 = mostly precise with a minor wording imprecision that doesn't change the conclusion.
   0 = mechanical error that would mislead the player (e.g. calling an immunity a resistance).

4. scope_adherence
   In-scope queries (moves, abilities, types, stats, evolutions, items, mechanics): answered?
   Out-of-scope queries (egg moves, catch locations, breeding, full battle simulation): politely
   declined with an offer of relevant in-scope help?
   2 = correct handling.
   1 = minor boundary error (declined something slightly in-scope, or answered a borderline edge).
   0 = wrong — answered an out-of-scope query as fact, or refused a clearly in-scope query.

5. transparency
   Does the answer state its reasoning, assumptions, and cite tool-returned data?
   Stat/damage calculations must state every assumed input (level, EVs, IVs, nature) and mark
   the result as an estimate. Citations must reference specific data points.
   2 = fully transparent — reasoning explained, all assumptions stated, citations specific.
   1 = mostly transparent — one assumption unstated or one unexplained reasoning step.
   0 = opaque — no reasoning, no assumptions stated for math, or no citations for factual claims.

ABSTENTIONS AND DECLINES
A correct answer is sometimes NON-factual. Two cases:
  (a) Out-of-scope DECLINE — status "answered" that politely declines a topic Oak does
      NOT cover (egg moves, catch/encounter locations, breeding, full battle simulation)
      and offers in-scope help instead.
  (b) Data-unavailable ABSTENTION — status "insufficient_data" when the tools genuinely
      lack the data needed.
Note: "answered" is the status enum value Oak uses for BOTH factual answers AND polite
declines, so an "Expected status: answered" line alone does NOT mean a factual answer is
required — read the "## Expected Behavior" note to tell which is intended.
When the response is a correct decline/abstention, score this way:
  - answer_correctness: judge whether declining/abstaining was the CORRECT action and the
    response accurately states the boundary — NOT on the presence of Pokémon facts. A
    correct, clearly-explained decline is a 2.
  - scope_adherence: a polite decline of an out-of-scope query is CORRECT handling = 2. Do
    NOT infer from "Expected status: answered" that the query is in-scope.
  - transparency: empty citations[]/inferences[] are EXPECTED for a decline — do NOT
    penalize their absence; score on whether it clearly says why it won't/can't answer.
  - inference_flagging / mechanics_precision: with no deductions or mechanics to judge,
    default to 2; don't invent something to dock.
Give a 0 on these dimensions ONLY if the agent fabricated data, declined a clearly
IN-scope query, or answered an out-of-scope query as fact.

Use the submit_judgment tool to return your five scores. Keep each reason field to ≤ 2 sentences.`;

/**
 * Judgment tool schema. Forced via tool_choice (no thinking) — see module header.
 * Uses `as Anthropic.Tool["input_schema"]` to satisfy the SDK type (mirrors
 * the pattern in src/agent/runtime.ts).
 */
const JUDGMENT_TOOL: Anthropic.Tool = {
  name: "submit_judgment",
  description:
    "Submit rubric scores (0, 1, or 2) for all five dimensions. Call this exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "answer_correctness",
      "inference_flagging",
      "mechanics_precision",
      "scope_adherence",
      "transparency",
    ],
    properties: {
      answer_correctness: dimensionScoreSchema(),
      inference_flagging: dimensionScoreSchema(),
      mechanics_precision: dimensionScoreSchema(),
      scope_adherence: dimensionScoreSchema(),
      transparency: dimensionScoreSchema(),
    },
  } as Anthropic.Tool["input_schema"],
};

function dimensionScoreSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["score", "reason"],
    properties: {
      score: {
        type: "integer",
        enum: [0, 1, 2],
        description: "0=fail, 1=partial pass, 2=full pass",
      },
      reason: {
        type: "string",
        description: "≤2-sentence explanation of the score.",
      },
    },
  };
}

type DimensionEntry = { score: number; reason: string };
type JudgmentInput = Record<RubricDimension, DimensionEntry>;

const RUBRIC_DIMENSIONS: RubricDimension[] = [
  "answer_correctness",
  "inference_flagging",
  "mechanics_precision",
  "scope_adherence",
  "transparency",
];

function clampScore(raw: number | undefined): 0 | 1 | 2 {
  if (raw === undefined || raw <= 0) return 0;
  if (raw >= 2) return 2;
  return 1;
}

export function buildJudgeUserMessage(gc: GoldenCase, answer: OakAnswer): string {
  const questionText = Array.isArray(gc.input)
    ? gc.input.map((q, i) => `Turn ${i + 1}: ${JSON.stringify(q)}`).join("\n")
    : `Question: ${JSON.stringify(gc.input)}`;

  const expectLines: string[] = [
    `Case ${gc.id} | covers: ${gc.covers.join(", ")}`,
  ];
  // Per-case judge guidance leads the section so the judge reads it before the
  // (sometimes ambiguous) status line below.
  if (gc.expect.rubricNote) {
    expectLines.push(gc.expect.rubricNote);
  }
  if (gc.expect.status) {
    expectLines.push(`Expected status: ${gc.expect.status}`);
  }
  if (gc.expect.mustInclude?.length) {
    expectLines.push(
      `Answer must include: ${gc.expect.mustInclude.join(", ")}`,
    );
  }

  return [
    "## User Question",
    questionText,
    "",
    "## Expected Behavior",
    ...expectLines,
    "",
    "## Actual OakAnswer (JSON)",
    "```json",
    JSON.stringify(answer, null, 2),
    "```",
  ].join("\n");
}

/**
 * Call the LLM judge for one answer. Returns RubricScore[] for the five dimensions.
 *
 * Uses `tool_choice: { type: "tool" }` (forced) WITHOUT thinking — the HARD 400
 * on Sonnet 4.6 only fires when thinking AND forced tool_choice are combined.
 * The judge does not use thinking here (it applies a rubric, not creative reasoning).
 */
async function callJudge(
  client: JudgeClientLike,
  gc: GoldenCase,
  answer: OakAnswer,
): Promise<RubricScore[]> {
  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: JUDGE_SYSTEM_PROMPT,
    tools: [JUDGMENT_TOOL],
    // Forced tool — safe here because we do NOT set thinking (see module header).
    tool_choice: { type: "tool", name: "submit_judgment" },
    messages: [{ role: "user", content: buildJudgeUserMessage(gc, answer) }],
  });

  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === "submit_judgment",
  );

  if (!toolUseBlock) {
    // Defensive fallback: judge did not use the tool. Treat all dimensions as
    // partial (score=1) so a stray model response doesn't kill a whole eval run.
    const fallbackReason =
      "judge did not call submit_judgment — all dimensions treated as partial pass";
    return RUBRIC_DIMENSIONS.map((dim) => ({
      dimension: dim,
      pass: true,
      score: 1 as const,
      reason: fallbackReason,
    }));
  }

  const judgment = toolUseBlock.input as JudgmentInput;
  return RUBRIC_DIMENSIONS.map((dim) => {
    const entry = judgment[dim];
    const score = clampScore(entry?.score);
    return {
      dimension: dim,
      pass: score >= 1,
      score,
      reason: entry?.reason ?? "(no reason provided)",
    };
  });
}

// ─── Lazy singleton for the production judge client ───────────────────────────

let _judgeClient: Anthropic | undefined;

/** Lazily build + memoize the real Anthropic judge client (one per process). */
function getJudgeClient(): Anthropic {
  if (!_judgeClient) {
    _judgeClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _judgeClient;
}

// ─── Core per-case engine ─────────────────────────────────────────────────────

/** Minimal placeholder answer used when the agent loop is initialised. */
function notStartedAnswer(): OakAnswer {
  return {
    status: "insufficient_data",
    answer_markdown: "Agent did not produce an answer.",
    reasoning_markdown: "",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
  };
}

async function runOneCase(
  gc: GoldenCase,
  ctx: AgentContext,
  judgeClient: JudgeClientLike,
  runOak: RunOakFn,
): Promise<JudgeResult> {
  const toolCalls: string[] = [];
  const inputs = Array.isArray(gc.input) ? gc.input : [gc.input];

  // ── 1. Run the agent (supports multi-turn via sequential calls) ──────────
  const agentStart = Date.now();
  let history: ChatMessage[] = [];
  let lastAnswer: OakAnswer = notStartedAnswer();

  for (const message of inputs) {
    lastAnswer = await runOak(message, history, ctx, (event) => {
      toolCalls.push(event.tool);
    });
    // Build history for the next turn (multi-turn: each assistant reply is the
    // answer_markdown; not the raw JSON, which the session store doesn't persist).
    history = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: lastAnswer.answer_markdown },
    ];
  }
  const agentLatencyMs = Date.now() - agentStart;

  // ── 2. Structural assertions (fast, no LLM) ───────────────────────────────
  const structuralFailures = runStructural(lastAnswer, gc, toolCalls);

  // ── 3. LLM judge ─────────────────────────────────────────────────────────
  const judgeStart = Date.now();
  const scores = await callJudge(judgeClient, gc, lastAnswer);
  const judgeLatencyMs = Date.now() - judgeStart;

  // ── 4. Aggregate pass/fail ────────────────────────────────────────────────
  const overallPass =
    structuralFailures.length === 0 && scores.every((s) => s.pass);

  return {
    caseId: gc.id,
    input: gc.input,
    answer: lastAnswer,
    toolCalls,
    structuralFailures,
    scores,
    overallPass,
    agentLatencyMs,
    judgeLatencyMs,
    covers: gc.covers,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Injectable entry point: run the full pipeline with supplied judge client and
 * runOak function. Use in tests (pass mocked clients); can also be used by
 * advanced callers that need custom injection.
 *
 * `repeat` (default 1) runs each case N times for variance measurement; results
 * stay a flat array (each entry carries `caseId`, so the caller aggregates by it).
 */
export async function runJudgedWith(
  cases: GoldenCase[],
  ctx: AgentContext,
  judgeClient: JudgeClientLike,
  runOak: RunOakFn,
  repeat = 1,
): Promise<JudgeResult[]> {
  const results: JudgeResult[] = [];
  for (const gc of cases) {
    for (let i = 0; i < repeat; i++) {
      results.push(await runOneCase(gc, ctx, judgeClient, runOak));
    }
  }
  return results;
}

/**
 * Production entry point. Runs the full golden suite with the real Anthropic
 * judge client and the real runOak. Called by eval/run.ts (nightly / on release).
 *
 * WIRED here but NOT invoked in the current build phase — see module header.
 */
export async function runJudged(
  cases: GoldenCase[],
  ctx: AgentContext,
  repeat = 1,
): Promise<JudgeResult[]> {
  return runJudgedWith(cases, ctx, getJudgeClient(), defaultRunOak, repeat);
}
