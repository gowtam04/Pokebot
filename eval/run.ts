/**
 * eval/run.ts — the `npm run eval` golden-suite runner (design.md Build Manifest:
 * `eval: "tsx eval/run.ts"`; design.md Phase 8).
 *
 * Owned by: phase "Eval" / assembly seam.
 *
 * Three runnable modes (the module never auto-runs — see the bottom guard):
 *
 *   tsx eval/run.ts                  Full LLM-judge suite (G1..G24), LIVE Sonnet
 *                                    for both the agent and the judge, against
 *                                    the built on-disk index (data/pokebot.sqlite,
 *                                    or the fixture if no index exists yet).
 *                                    Nightly / on-release; NOT PR-blocking.
 *
 *   tsx eval/run.ts --rebuild        Index-rebuild regression set (G1/G5/G6/G7/
 *                                    G17) — run on demand after every ingest to
 *                                    catch data drift (evaluation.md § Regression
 *                                    Approach). Live judge by default.
 *
 *   tsx eval/run.ts --deterministic  The CI subset, OFFLINE (mocked Anthropic
 *                                    client + real tools + fixture DB). No model
 *                                    call, no API key needed beyond a non-empty
 *                                    placeholder. This is what the Vitest gate
 *                                    runs (eval/deterministic.test.ts); exposed
 *                                    here for ad-hoc local runs.
 *
 * Flags:
 *   --rebuild              use the G1/G5/G6/G7/G17 regression set
 *   --deterministic        run the offline deterministic subset (no live LLM)
 *   --case=G4,G11          run only these case IDs
 *   --fixture              force an isolated, seeded Postgres fixture schema
 *   --live-index[=URI]     force the live Postgres index (default: $DATABASE_URL)
 *   --json                 emit a machine-readable JSON report
 *
 * Live mode (judged) needs a REAL ANTHROPIC_API_KEY in the environment; the
 * dummy key used by the Vitest config will 401. The deterministic mode needs no
 * real key.
 */

import { createRequire } from "node:module";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { env } from "@/env";
import { createAgentContext } from "@/agent/context";
import type { AgentContext } from "@/agent/types";
import * as schema from "@/data/schema";

import {
  cases as ALL_CASES,
  deterministicCases,
  rebuildRegressionCases,
} from "./cases";
import { createPgSchema, installAsSingleton } from "../test/support/pg";
// NOTE: ./judge and ./deterministic pull in the agent runtime → tool layer →
// reference-cache.ts, which statically `import "server-only"`. We import them
// DYNAMICALLY inside main() (TYPE-only here) so the server-only shim below runs
// first. Under tsx/node there is no Next `react-server` export condition, so
// server-only's default entry throws; the shim neutralizes it for the CLI.
import type {
  AssertResult,
  GoldenCase,
  JudgeResult,
  RubricDimension,
} from "./judge";

// ---------------------------------------------------------------------------
// `server-only` shim (CLI only — Vitest mocks the module itself)
// ---------------------------------------------------------------------------
// Short-circuits the CJS loader for the `server-only` specifier so the agent
// tool layer can load under `tsx eval/run.ts`. Scoped to that one specifier and
// skipped under Vitest (process.env.VITEST), which supplies its own mock.
if (!process.env.VITEST) {
  const req = createRequire(import.meta.url);
  const Mod = req("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    __pokebotServerOnlyPatched?: boolean;
  };
  if (!Mod.__pokebotServerOnlyPatched) {
    const orig = Mod._load;
    Mod._load = function patched(
      this: unknown,
      request: string,
      ...rest: [unknown, boolean]
    ): unknown {
      if (typeof request === "string" && request.includes("server-only")) {
        return {};
      }
      return orig.call(this, request, ...rest);
    } as typeof Mod._load;
    Mod.__pokebotServerOnlyPatched = true;
  }
}

/** Case IDs that have a deterministic plan (== the `deterministic: true` set). */
const DETERMINISTIC_PLANNED_IDS: ReadonlySet<string> = new Set(
  deterministicCases.map((c) => c.id),
);

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface EvalOptions {
  /** Run only the G1/G5/G6/G7/G17 index-rebuild regression set. */
  rebuild: boolean;
  /** Run the offline deterministic subset (no live LLM). */
  deterministic: boolean;
  /** Restrict to these case IDs (uppercased, e.g. "G4"). */
  caseIds?: string[];
  /** Force an isolated, seeded Postgres fixture schema. */
  fixture: boolean;
  /** Force the live index; value is the Postgres URI (defaults to DATABASE_URL). */
  liveIndexUri?: string;
  /** Emit a JSON report instead of the human-readable summary. */
  json: boolean;
}

export function parseArgs(argv: string[]): EvalOptions {
  const opts: EvalOptions = {
    rebuild: false,
    deterministic: false,
    fixture: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "--rebuild") opts.rebuild = true;
    else if (arg === "--deterministic" || arg === "--offline")
      opts.deterministic = true;
    else if (arg === "--fixture") opts.fixture = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--live-index") opts.liveIndexUri = env.DATABASE_URL;
    else if (arg.startsWith("--live-index=")) {
      opts.liveIndexUri = arg.slice("--live-index=".length);
    } else if (arg.startsWith("--case=")) {
      opts.caseIds = arg
        .slice("--case=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Case selection
// ---------------------------------------------------------------------------

/**
 * Resolve the case pool for a run. In deterministic mode the pool is narrowed to
 * cases that actually have a registered plan; the excluded IDs are returned so
 * the caller can report them (they require the live judge).
 */
export function selectCases(opts: EvalOptions): {
  cases: GoldenCase[];
  excludedFromDeterministic: string[];
} {
  let pool: GoldenCase[] = ALL_CASES;

  if (opts.rebuild) {
    pool = rebuildRegressionCases;
  } else if (opts.deterministic && !opts.caseIds) {
    pool = deterministicCases;
  }

  if (opts.caseIds) {
    const wanted = new Set(opts.caseIds);
    pool = pool.filter((c) => wanted.has(c.id));
  }

  let excludedFromDeterministic: string[] = [];
  if (opts.deterministic) {
    excludedFromDeterministic = pool
      .filter((c) => !DETERMINISTIC_PLANNED_IDS.has(c.id))
      .map((c) => c.id);
    pool = pool.filter((c) => DETERMINISTIC_PLANNED_IDS.has(c.id));
  }

  return { cases: pool, excludedFromDeterministic };
}

// ---------------------------------------------------------------------------
// Context wiring (installs the @/data/db singleton so resolve_entity sees it)
// ---------------------------------------------------------------------------

interface BuiltContext {
  ctx: AgentContext;
  label: string;
  close: () => Promise<void>;
}

/**
 * Build an AgentContext bound to either an isolated, seeded Postgres fixture
 * schema or the live Postgres index. Both paths INSTALL the chosen handle as the
 * @/data/db singleton (globalThis.__pokebotDb) so resolve_entity — which reads
 * the singleton, not ctx.db — sees the same data as ctx.db.
 */
async function buildContext(opts: EvalOptions): Promise<BuiltContext> {
  // Deterministic mode is offline → fixture by default. Judged/rebuild modes hit
  // the live index unless --fixture forces the seeded schema.
  const wantsLive = !opts.fixture && !opts.deterministic;

  if (wantsLive) {
    const uri = opts.liveIndexUri ?? env.DATABASE_URL;
    const pool = new Pool({ connectionString: uri });
    const db = drizzle(pool, { schema });
    (globalThis as { __pokebotDb?: { pool: Pool; db: typeof db } }).__pokebotDb =
      { pool, db };
    (await import("@/data/repos/resolve-index")).resetResolveIndex();
    const ctx = await createAgentContext();
    return {
      ctx,
      label: `live index (${uri})`,
      close: async () => {
        await pool.end();
      },
    };
  }

  // Fixture: an isolated, migrated + seeded Postgres schema.
  const fix = await createPgSchema({ seed: "eval" });
  await installAsSingleton(fix);
  const ctx = await createAgentContext();
  return {
    ctx,
    label: "fixture (pg schema)",
    close: () => fix.cleanup(),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const RUBRIC_DIMENSIONS: RubricDimension[] = [
  "answer_correctness",
  "inference_flagging",
  "mechanics_precision",
  "scope_adherence",
  "transparency",
];

export function formatJudgeReport(results: JudgeResult[]): string {
  const lines: string[] = [];
  let passed = 0;

  for (const r of results) {
    if (r.overallPass) passed += 1;
    const mark = r.overallPass ? "PASS" : "FAIL";
    const scores = r.scores.map((s) => `${s.dimension}=${s.score}`).join(" ");
    lines.push(
      `[${mark}] ${r.caseId}  (agent ${r.agentLatencyMs}ms / judge ${r.judgeLatencyMs}ms)`,
    );
    lines.push(
      `        status=${r.answer.status}  tools=[${r.toolCalls.join(", ")}]`,
    );
    lines.push(`        rubric: ${scores}`);
    if (r.structuralFailures.length > 0) {
      for (const f of r.structuralFailures) {
        lines.push(`        ✗ structural: ${f}`);
      }
    }
    for (const s of r.scores) {
      if (s.score === 0) lines.push(`        ✗ ${s.dimension}: ${s.reason}`);
    }
  }

  // Per-dimension averages.
  const dimAvg: string[] = [];
  for (const dim of RUBRIC_DIMENSIONS) {
    const vals = results
      .map((r) => r.scores.find((s) => s.dimension === dim)?.score ?? 0)
      .filter((v) => v !== undefined);
    const avg =
      vals.length > 0
        ? vals.reduce<number>((a, b) => a + b, 0) / vals.length
        : 0;
    dimAvg.push(`${dim}=${avg.toFixed(2)}`);
  }

  lines.push("");
  lines.push(`Judged: ${passed}/${results.length} cases passed.`);
  lines.push(`Avg rubric (0–2): ${dimAvg.join("  ")}`);
  return lines.join("\n");
}

export function formatAssertReport(results: AssertResult[]): string {
  const lines: string[] = [];
  let passed = 0;
  for (const r of results) {
    if (r.pass) passed += 1;
    lines.push(`[${r.pass ? "PASS" : "FAIL"}] ${r.caseId}`);
    for (const f of r.failures) lines.push(`        ✗ ${f}`);
  }
  lines.push("");
  lines.push(`Deterministic: ${passed}/${results.length} cases passed.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main — returns an exit code (the bottom guard owns process.exit)
// ---------------------------------------------------------------------------

/**
 * Run the eval per the parsed options. Returns an exit code: 0 when every case
 * in scope passed, 1 otherwise. Pure of `process.exit` so it is unit-testable.
 */
export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const { cases: selected, excludedFromDeterministic } = selectCases(opts);

  if (selected.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "[eval] no cases selected (check --case / --rebuild filters).",
    );
    return 1;
  }

  const built = await buildContext(opts);
  const log = (s: string) =>
    // eslint-disable-next-line no-console
    console.log(s);

  try {
    if (excludedFromDeterministic.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[eval] deterministic mode skips (need the live judge): ${excludedFromDeterministic.join(", ")}`,
      );
    }

    if (opts.deterministic) {
      // Dynamic import: pulls the agent runtime (server-only) — load it only
      // after the shim above has run.
      const { runDeterministic } = await import("./deterministic");
      const results = await runDeterministic(selected, built.ctx);
      if (opts.json) {
        log(
          JSON.stringify(
            { mode: "deterministic", db: built.label, results },
            null,
            2,
          ),
        );
      } else {
        log(`Mode: deterministic (offline)  DB: ${built.label}`);
        log(formatAssertReport(results));
      }
      return results.every((r) => r.pass) ? 0 : 1;
    }

    // Judged (live Sonnet + live judge).
    const mode = opts.rebuild ? "rebuild-regression (judged)" : "judged (full)";
    if (!opts.json)
      log(`Mode: ${mode}  DB: ${built.label}  model: ${env.ANTHROPIC_MODEL}`);
    // Dynamic import: pulls the agent runtime + judge (server-only) after the shim.
    const { runJudged } = await import("./judge");
    const results = await runJudged(selected, built.ctx);
    if (opts.json) {
      log(JSON.stringify({ mode, db: built.label, results }, null, 2));
    } else {
      log(formatJudgeReport(results));
    }
    return results.every((r) => r.overallPass) ? 0 : 1;
  } finally {
    await built.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when invoked directly (`tsx eval/run.ts ...`), never on
// import. This is what keeps the live suite "wired, not auto-run".
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[eval] run failed:", err);
      process.exit(1);
    });
}
