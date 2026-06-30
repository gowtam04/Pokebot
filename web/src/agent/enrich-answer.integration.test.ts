/**
 * ENRICH-ANSWER-E2E — the server-side sprite/dex enrichment seam exercised
 * end-to-end through the REAL agent runtime + tool layer + a REAL migrated +
 * seeded Postgres schema (Testcontainers), with a SCRIPTED OpenAI-compatible
 * (Grok) provider standing in for the model.
 *
 * This is the regression guard for the reported bug: Grok answers carried no
 * sprite_url / dex_number / subjects, so nothing rendered. The runtime now
 * enriches every validated answer from the index, so a "Grok" payload that omits
 * those fields comes out with them populated — proving sprites are now
 * model-independent.
 *
 * Two cases:
 *   1. candidate list — rows with NO sprite_url/dex_number get them backfilled
 *      (matched by display name, incl. a parenthesized form).
 *   2. single entity — an answer with NO subjects[] gets one SYNTHESIZED from the
 *      get_pokemon profile the turn already fetched (the Farigiraf sprite-card case).
 *
 * Wiring mirrors active-team.integration.test.ts: neutralize `server-only`,
 * install a seeded schema as the `@/data/db` singleton BEFORE importing the
 * repos/runtime (enrichment's fuzzy fallback reads the SINGLETON), and drive the
 * loop with a scripted provider.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "@/agent/providers/openai-compatible-provider";
import type { OpenAIClientLike } from "@/agent/providers/openai-compatible-provider";
import type { AgentContext, AgentMode } from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../test/support/pg";

// src/data/db.ts does `import "server-only"`; neutralize it so the real repos
// load under the vitest node environment.
import { vi } from "vitest";
vi.mock("server-only", () => ({}));

type Runtime = typeof import("@/agent/runtime");
type ContextMod = typeof import("@/agent/context");

let fix: PgFixture;
let runtime: Runtime;
let contextMod: ContextMod;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY ??= "test-dummy-key";
  // seed "tools" → Garchomp (#445), Farigiraf (#981), Tauros forms, etc., in
  // the scarlet-violet format, with sprite_url + searchable_names populated.
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);

  runtime = await import("@/agent/runtime");
  contextMod = await import("@/agent/context");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

/* eslint-disable @typescript-eslint/no-explicit-any */

const USAGE_CHUNK = {
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

/** Stream one tool call (id+name, then chunked JSON args, then finish + usage). */
function toolCallChunks(name: string, input: unknown, callId: string): any[] {
  const json = JSON.stringify(input);
  const out: any[] = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  ];
  for (let i = 0; i < json.length; i += 16) {
    out.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: json.slice(i, i + 16) } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  out.push(USAGE_CHUNK);
  return out;
}

/** Fake client that replays one chunk-array PER create() call (one per turn). */
function fakeClient(turns: any[][]): OpenAIClientLike {
  const queue = [...turns];
  return {
    chat: {
      completions: {
        create() {
          const chunks = queue.shift() ?? [];
          return (async function* () {
            for (const c of chunks) yield c as any;
          })();
        },
      },
    },
  };
}

function grokProvider(turns: any[][]): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    { kind: "xai", apiModelId: "grok-4.3", apiKey: "k" },
    fakeClient(turns),
  );
}

async function buildCtx(mode: AgentMode): Promise<AgentContext> {
  return contextMod.createAgentContext({
    requestId: "enrich-it",
    mode,
    db: fix.db as unknown as import("@/data/db").OakDb,
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

describe("enrich-answer-e2e — server backfills sprites/dex (model-independent)", () => {
  it("backfills sprite_url + dex_number into candidate rows that omit them", async () => {
    // A "Grok" answer: candidate rows with NO sprite_url and NO dex_number
    // (exactly what the reported Grok payloads looked like). Includes a
    // parenthesized form name to prove the display-name match handles it.
    const answer: OakAnswer = {
      status: "answered",
      answer_markdown: "**2 Pokémon** match.",
      reasoning_markdown: "Queried the index.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      candidates: {
        total_count: 2,
        truncated: false,
        sort: "base_stat_total",
        shown: [
          {
            name: "Garchomp",
            types: ["dragon", "ground"],
            base_stats: {
              hp: 108,
              attack: 130,
              defense: 95,
              special_attack: 80,
              special_defense: 85,
              speed: 102,
            },
          },
          {
            name: "Tauros (Paldean Aqua)",
            types: ["fighting", "water"],
            base_stats: {
              hp: 75,
              attack: 110,
              defense: 105,
              special_attack: 30,
              special_defense: 70,
              speed: 100,
            },
          },
        ],
      },
    };

    const ctx = await buildCtx("standard");
    const result = await runtime.runWithProvider(
      grokProvider([toolCallChunks("submit_answer", answer, "c1")]),
      "which dragons?",
      [],
      ctx,
    );

    const rows = result.candidates!.shown;
    expect(rows[0].sprite_url).toBe("https://img.example/sprite/445.png");
    expect(rows[0].dex_number).toBe(445);
    // The parenthesized form is matched by its stored display_name.
    expect(rows[1].sprite_url).toBe("https://img.example/sprite/128-aqua.png");
    expect(rows[1].dex_number).toBe(128);
    // base_stats the model supplied are left untouched.
    expect(rows[0].base_stats?.speed).toBe(102);
  });

  it("synthesizes subjects[] from the turn's get_pokemon profile when omitted", async () => {
    // A "Grok" single-entity answer with NO subjects[] — the Farigiraf case.
    const answer: OakAnswer = {
      status: "answered",
      answer_markdown: "**No**, if Farigiraf has Armor Tail.",
      reasoning_markdown: "Read the ability.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };

    const ctx = await buildCtx("standard");
    const result = await runtime.runWithProvider(
      grokProvider([
        toolCallChunks("get_pokemon", { name: "farigiraf" }, "c1"),
        toolCallChunks("submit_answer", answer, "c2"),
      ]),
      "does fake out work on farigiraf?",
      [],
      ctx,
    );

    expect(result.subjects).toBeDefined();
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects![0]).toMatchObject({
      name: "Farigiraf",
      dex_number: 981,
      sprite_url: "https://img.example/sprite/981.png",
    });
  });

  it("leaves a Claude-style answer (already has sprites) unchanged", async () => {
    // Enrichment only ADDS missing fields — an answer that already carries
    // sprite_url/dex_number is returned as-is (no regression to the Claude path).
    const answer: OakAnswer = {
      status: "answered",
      answer_markdown: "**Garchomp**.",
      reasoning_markdown: "Looked it up.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      subjects: [
        {
          name: "Garchomp",
          dex_number: 445,
          sprite_url: "https://cdn.example/custom-garchomp.png",
          types: ["dragon", "ground"],
          is_fallback: false,
        },
      ],
    };

    const ctx = await buildCtx("standard");
    const result = await runtime.runWithProvider(
      grokProvider([toolCallChunks("submit_answer", answer, "c1")]),
      "tell me about garchomp",
      [],
      ctx,
    );

    // The model-supplied sprite_url is preserved, not overwritten by the index.
    expect(result.subjects![0].sprite_url).toBe(
      "https://cdn.example/custom-garchomp.png",
    );
  });
});
