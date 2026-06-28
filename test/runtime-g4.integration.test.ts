/**
 * G4 INTEGRATION ORACLE — "does Fake Out work on Farigiraf?" driven through the
 * REAL agent runtime + the REAL tool layer + a fixture SQLite DB.
 *
 * This is the test the design's Phase-5 test-focus calls for and that the unit
 * `runtime.test.ts` deliberately cannot cover (it mocks `@/agent/tools`):
 *
 *   design.md Phase 5: "conditional Farigiraf answer carries an inferences[]
 *   entry (G4)" ... exercised against "real tools/fixture DB".
 *
 * It records a 4-step tool transcript (get_move -> get_pokemon -> get_ability ->
 * submit_answer) and replays it through `runOakWith(client, ...)`, where the
 * tool calls are dispatched by the genuine tool layer reading the seeded fixture.
 * We assert BOTH:
 *   (1) the real tools returned the grounding FACTS (Fake Out priority 3;
 *       Farigiraf has armor-tail; Armor Tail negates positive-priority moves) —
 *       by inspecting the tool_result blocks fed back to the model; and
 *   (2) the produced OakAnswer is schema-valid, status "answered", and
 *       carries an inferences[] entry about Armor Tail blocking priority (BR-3).
 *
 * Wiring mirrors the *.oracle.test.ts harness: neutralize `server-only`, migrate
 * + seed an isolated Postgres schema (createPgSchema), and install it as the
 * @/data/db singleton BEFORE the first dynamic import of the tool layer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { oakAnswerSchema } from "@/agent/schemas";
import { reference_cache } from "@/data/schema";
import type { AgentContext, ChatMessage } from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";

import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";
import { loadToolSurface } from "./fixtures/tools-fixture";

// src/data/db.ts does `import "server-only"`; its Node (non-RSC) variant throws.
// Neutralize it so the real repos/tools load under the vitest node environment.
vi.mock("server-only", () => ({}));

// --- Reference-cache rows G4 needs (the fixture only warms the type chart). ---
// A fresh reference_cache hit is returned verbatim as the tool output, so these
// payloads ARE the MoveDetail / AbilityDetail shapes (schemas.ts T4/T5), drawn
// from the tools.md samples.
const FAKE_OUT_MOVE = {
  found: true,
  display_name: "Fake Out",
  type: "normal",
  damage_class: "physical",
  power: 40,
  accuracy: 100,
  pp: 10,
  priority: 3,
  target: "selected-pokemon",
  effect_short:
    "Hits first (priority +3) and makes the target flinch; only works on the user's first turn out.",
  effect_full:
    "Inflicts regular damage. Has +3 priority. The target flinches. Only succeeds on the first turn after the user switches in.",
};
const ARMOR_TAIL_ABILITY = {
  found: true,
  display_name: "Armor Tail",
  effect_short:
    "Prevents the holder from being hit by moves with increased priority.",
  effect_full:
    "The Pokémon and its allies cannot be targeted by opposing moves that have positive priority (e.g. Fake Out, Quick Attack, Extreme Speed).",
};

let runOakWith: (
  client: unknown,
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: (e: { tool: string; label: string }) => void,
) => Promise<OakAnswer>;
let ctx: AgentContext;
let loadError: unknown = null;
let fix: PgFixture;

beforeAll(async () => {
  try {
    // runOakWith takes the client directly, so no real Anthropic client is
    // built — but importing the env-validated modules wants a key present.
    process.env.ANTHROPIC_API_KEY ??= "test-dummy-key";

    // Seed dataset B, then warm the two reference rows G4 reasons over so
    // get_move / get_ability are cache HITS — exactly like the type-chart rows.
    fix = await createPgSchema({
      seed: "tools",
      after: async (db) => {
        const now = Date.now();
        // Standard mode → the scarlet-violet data scope (formatForMode).
        await db.insert(reference_cache).values([
          {
            format: "scarlet-violet",
            resource_key: "move/fake-out",
            resource_kind: "move",
            payload: JSON.stringify(FAKE_OUT_MOVE),
            endpoint_url: "@pkmn/dex (Pokémon Showdown)",
            fetched_at: now,
          },
          {
            format: "scarlet-violet",
            resource_key: "ability/armor-tail",
            resource_kind: "ability",
            payload: JSON.stringify(ARMOR_TAIL_ABILITY),
            endpoint_url: "@pkmn/dex (Pokémon Showdown)",
            fetched_at: now,
          },
        ]);
      },
    });
    await installAsSingleton(fix);

    // Real tool surface (dispatch + ctx) bound to the seeded singleton DB...
    const surface = await loadToolSurface();
    ctx = surface.ctx;
    // ...and the real runtime (NOT mocking @/agent/tools — that is the point).
    const rt = (await import("@/agent/runtime")) as {
      runOakWith: typeof runOakWith;
    };
    runOakWith = rt.runOakWith;
  } catch (e) {
    loadError = e;
  }
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function ensureLoaded(): void {
  if (loadError) {
    throw new Error(
      `Runtime/tool layer not loadable (Phase 4/5 incomplete): ${String(loadError)}`,
    );
  }
}

// --- Recorded-transcript client (mirrors runtime.test.ts scriptedClient) ------

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function toolUse(name: string, input: unknown, id: string): Block {
  return { type: "tool_use", id, name, input };
}

function message(content: Block[]): unknown {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 7,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: { thinking_tokens: 3 },
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeStream(message: any, events: any[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      // No incremental events needed for this oracle — finalMessage suffices.
      for (const e of events) yield e;
    },
    finalMessage: () => Promise.resolve(message),
  };
}

function scriptedClient(responses: unknown[]) {
  const snapshots: any[] = [];
  const stream = vi.fn((params: any) => {
    snapshots.push(structuredClone(params));
    const next = responses.shift();
    if (next === undefined) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error("transcript exhausted")),
          };
        },
        finalMessage: () => Promise.reject(new Error("transcript exhausted")),
      };
    }
    return fakeStream(next);
  });
  return { client: { messages: { stream } } as any, stream, snapshots };
}

/** Concatenate the tool_result string content of the LAST user message. */
function lastToolResultText(params: any): string {
  const msgs = params.messages;
  const lastUser = msgs[msgs.length - 1];
  return (lastUser.content as { content?: unknown }[])
    .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c)))
    .join(" ");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// The conditional, inference-bearing G4 answer the model submits last.
const G4_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown:
    "It depends on Farigiraf's ability. Fake Out is a +3 priority move, and **Armor Tail negates moves with increased priority** — so if Farigiraf has Armor Tail, Fake Out fails. With Cud Chew or Sap Sipper, Fake Out works normally (and flinches).",
  reasoning_markdown:
    "Fake Out has priority +3 (get_move). Farigiraf can have Cud Chew, Armor Tail, or Sap Sipper (get_pokemon). Armor Tail blocks opposing positive-priority moves (get_ability). Therefore the outcome is conditional on which ability is active.",
  citations: [
    { source: "move/fake-out", detail: "priority: 3" },
    {
      source: "ability/armor-tail",
      detail:
        "Prevents the holder from being hit by moves with increased priority.",
    },
    {
      source: "pokemon/farigiraf",
      detail: "abilities: cud-chew, armor-tail (slot 2), sap-sipper (hidden)",
    },
  ],
  inferences: [
    {
      claim:
        "If Farigiraf has Armor Tail, Fake Out fails because Armor Tail negates increased-priority moves.",
      confidence: "high",
      note: "Deduced by combining Fake Out's +3 priority with Armor Tail's effect text; hinges on which ability Farigiraf actually has.",
    },
  ],
  generation_basis: { generation: "gen-9", fallback: false },
  subjects: [
    {
      name: "Farigiraf",
      dex_number: 981,
      sprite_url: "https://img.example/sprite/981.png",
      types: ["normal", "psychic"],
      is_fallback: false,
    },
  ],
};

describe("G4 integration: Fake Out vs Farigiraf through the real runtime + tools", () => {
  it("dispatches the real tools and returns a schema-valid, conditional answer with an inference", async () => {
    ensureLoaded();

    const { client, snapshots, stream } = scriptedClient([
      message([toolUse("get_move", { name: "fake-out" }, "m1")]),
      message([toolUse("get_pokemon", { name: "farigiraf" }, "m2")]),
      message([toolUse("get_ability", { name: "armor-tail" }, "m3")]),
      message([toolUse("submit_answer", G4_ANSWER, "m4")]),
    ]);

    const progress: string[] = [];
    const result = await runOakWith(
      client,
      "does Fake Out work on Farigiraf?",
      [],
      ctx,
      (e) => progress.push(e.tool),
    );

    // (1) The REAL tools ran and returned the grounding facts (proven by the
    //     tool_result blocks fed back to the model on each subsequent turn).
    expect(stream).toHaveBeenCalledTimes(4);
    expect(lastToolResultText(snapshots[1])).toMatch(/"priority":\s*3/); // get_move
    expect(lastToolResultText(snapshots[2])).toMatch(/armor-tail/); // get_pokemon abilities
    expect(lastToolResultText(snapshots[3])).toMatch(
      /increased priority|positive priority/i,
    ); // get_ability effect text
    expect(progress).toEqual([
      "get_move",
      "get_pokemon",
      "get_ability",
      "submit_answer",
    ]);

    // (2) The produced OakAnswer is valid and carries the conditional inference.
    expect(oakAnswerSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("answered");
    expect(result.generation_basis).toEqual({
      generation: "gen-9",
      fallback: false,
    });
    expect(result.inferences.length).toBeGreaterThanOrEqual(1);
    const inf = result.inferences[0]!;
    expect(inf.claim).toMatch(/armor.?tail/i);
    expect(inf.claim).toMatch(/priorit/i);
    expect(inf.confidence).toBe("high");
    // The conditional answer must cite the priority value and the ability text (BR-4).
    expect(result.citations.map((c) => c.source)).toEqual(
      expect.arrayContaining(["move/fake-out", "ability/armor-tail"]),
    );
  });
});
