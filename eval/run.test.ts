/**
 * eval/run.test.ts — CI-safe tests for the eval runner (eval/run.ts).
 *
 * Covers the pure CLI plumbing (parseArgs / selectCases / report formatting) and
 * drives `main` through its OFFLINE deterministic path (mocked Anthropic client +
 * fixture DB) so the whole runner is exercised in CI without any live model call.
 * The judged (live Sonnet) path is intentionally NOT invoked here — that is the
 * nightly/on-release job, and it is guarded behind real flags + a real API key.
 */

import { describe, expect, it, vi } from "vitest";

// run.ts → deterministic.ts → runtime → tools → reference-cache.ts, which
// statically `import "server-only"`. Neutralize it for the node test env (same
// pattern as src/data/repos/reference-cache.test.ts).
vi.mock("server-only", () => ({}));

import {
  formatAssertReport,
  formatJudgeReport,
  formatRepeatedJudgeReport,
  main,
  parseArgs,
  selectCases,
} from "./run";
import type { AssertResult, JudgeResult, RubricDimension } from "./judge";

describe("parseArgs", () => {
  it("defaults to the full judged suite", () => {
    const o = parseArgs([]);
    expect(o.rebuild).toBe(false);
    expect(o.deterministic).toBe(false);
    expect(o.fixture).toBe(false);
    expect(o.json).toBe(false);
    expect(o.caseIds).toBeUndefined();
    expect(o.repeat).toBe(1);
    expect(o.invalidRepeat).toBeUndefined();
  });

  it("parses every flag", () => {
    const o = parseArgs([
      "--rebuild",
      "--deterministic",
      "--fixture",
      "--json",
      "--case=g4, G11",
      "--live-index=postgres://h:5432/db",
    ]);
    expect(o.rebuild).toBe(true);
    expect(o.deterministic).toBe(true);
    expect(o.fixture).toBe(true);
    expect(o.json).toBe(true);
    expect(o.caseIds).toEqual(["G4", "G11"]);
    expect(o.liveIndexUri).toBe("postgres://h:5432/db");
  });

  it("accepts a known --model key and rejects an unknown one", () => {
    const ok = parseArgs(["--model=claude"]);
    expect(ok.model).toBe("claude");
    expect(ok.invalidModel).toBeUndefined();

    const bad = parseArgs(["--model=bogus"]);
    expect(bad.model).toBeUndefined();
    expect(bad.invalidModel).toBe("bogus");
  });

  it("accepts a valid --repeat and flags an invalid one", () => {
    expect(parseArgs(["--repeat=5"]).repeat).toBe(5);

    for (const bad of ["0", "-1", "abc", "2.5", "05"]) {
      const o = parseArgs([`--repeat=${bad}`]);
      expect(o.repeat).toBe(1); // stays at the default
      expect(o.invalidRepeat).toBe(bad);
    }
  });
});

describe("selectCases", () => {
  it("defaults to all 25 cases for the judged suite", () => {
    const { cases } = selectCases(parseArgs([]));
    expect(cases).toHaveLength(25);
  });

  it("uses the G1/G5/G6/G7/G17/G25 set for --rebuild", () => {
    const { cases } = selectCases(parseArgs(["--rebuild"]));
    expect(cases.map((c) => c.id).sort()).toEqual([
      "G1",
      "G17",
      "G25",
      "G5",
      "G6",
      "G7",
    ]);
  });

  it("narrows --deterministic to planned cases and reports the rest", () => {
    // --rebuild ∩ deterministic-plans = G1/G5/G6; G7/G17/G25 need the live judge.
    const { cases, excludedFromDeterministic } = selectCases(
      parseArgs(["--deterministic", "--rebuild"]),
    );
    expect(cases.map((c) => c.id).sort()).toEqual(["G1", "G5", "G6"]);
    expect(excludedFromDeterministic.sort()).toEqual(["G17", "G25", "G7"]);
  });

  it("honors a --case filter", () => {
    const { cases } = selectCases(parseArgs(["--case=G11,G15"]));
    expect(cases.map((c) => c.id).sort()).toEqual(["G11", "G15"]);
  });
});

describe("report formatting", () => {
  it("summarizes deterministic results", () => {
    const results: AssertResult[] = [
      { caseId: "G1", pass: true, failures: [], answer: {} as never },
      {
        caseId: "G3",
        pass: false,
        failures: ["status: expected x"],
        answer: {} as never,
      },
    ];
    const out = formatAssertReport(results);
    expect(out).toContain("[PASS] G1");
    expect(out).toContain("[FAIL] G3");
    expect(out).toContain("Deterministic: 1/2 cases passed.");
  });

  it("summarizes judged results with rubric averages", () => {
    const results: JudgeResult[] = [
      {
        caseId: "G2",
        input: "q",
        answer: { status: "answered" } as never,
        toolCalls: ["query_pokedex", "submit_answer"],
        structuralFailures: [],
        scores: [
          { dimension: "answer_correctness", pass: true, score: 2, reason: "" },
          { dimension: "inference_flagging", pass: true, score: 2, reason: "" },
          {
            dimension: "mechanics_precision",
            pass: true,
            score: 2,
            reason: "",
          },
          { dimension: "scope_adherence", pass: true, score: 2, reason: "" },
          { dimension: "transparency", pass: true, score: 2, reason: "" },
        ],
        overallPass: true,
        agentLatencyMs: 10,
        judgeLatencyMs: 5,
        covers: ["AC-1.2"],
      },
    ];
    const out = formatJudgeReport(results);
    expect(out).toContain("[PASS] G2");
    expect(out).toContain("Judged: 1/1 cases passed.");
    expect(out).toContain("answer_correctness=2.00");
  });

  it("aggregates a repeated run by caseId with a FLAKY marker", () => {
    const dims: RubricDimension[] = [
      "answer_correctness",
      "inference_flagging",
      "mechanics_precision",
      "scope_adherence",
      "transparency",
    ];
    const makeRun = (caseId: string, pass: boolean): JudgeResult => ({
      caseId,
      input: "q",
      answer: { status: "answered" } as never,
      toolCalls: [],
      structuralFailures: [],
      scores: dims.map((dimension) => ({
        dimension,
        pass,
        score: (pass ? 2 : 0) as 0 | 1 | 2,
        reason: "",
      })),
      overallPass: pass,
      agentLatencyMs: 100,
      judgeLatencyMs: 5,
      covers: [],
    });

    // G8: 1 pass + 1 fail → flaky; G1: 2 passes → stable-pass.
    const results: JudgeResult[] = [
      makeRun("G8", true),
      makeRun("G8", false),
      makeRun("G1", true),
      makeRun("G1", true),
    ];
    const out = formatRepeatedJudgeReport(results, 2);
    expect(out).toContain("[1/2] G8  FLAKY");
    expect(out).toContain("[2/2] G1  stable-pass");
    expect(out).toContain(
      "Judged (repeat=2): 1 stable-pass / 1 flaky / 0 stable-fail  (2 cases)",
    );
    expect(out).toContain("Mean agent latency: 100ms");
  });
});

describe("main — offline deterministic path", () => {
  it("runs the deterministic subset against the fixture and exits 0", async () => {
    // In --fixture mode, buildContext() provisions an isolated, seeded Postgres
    // schema and installs it as the @/data/db singleton (so resolve_entity, which
    // reads the singleton, sees the fixture), then cleans it up in its finally.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const code = await main(["--deterministic", "--fixture"]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(printed).toContain("Deterministic:");
      // All deterministic cases must pass against the fixture.
      expect(printed).toContain("cases passed.");
      expect(printed).not.toContain("[FAIL]");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 120_000);
});
