/**
 * eval/deterministic.ts — the CI subset of the golden suite (design.md Phase 8;
 * evaluation.md § Regression Approach: "a fast subset … G3 suggestion, G11
 * immunity, G15 stat value, tool-efficiency asserts").
 *
 * Owned by: phase "Eval" / assembly seam.
 *
 * WHAT THIS IS
 * ------------
 * The deterministic subset is everything that can be asserted WITHOUT a live
 * Sonnet call. It runs in Vitest on every PR (eval/deterministic.test.ts) and is
 * runnable from the CLI via `tsx eval/run.ts --deterministic`.
 *
 * HOW IT STAYS DETERMINISTIC ("MOCKED Anthropic client / pure tools")
 * -------------------------------------------------------------------
 * Each case is driven through the REAL agent runtime (`runPokebotWith`) but with
 * a *scripted* Anthropic client injected in place of the model. The scripted
 * client:
 *   1. On its first turn, emits the exact `tool_use` block(s) a correct agent
 *      would issue for the case (e.g. one `query_pokedex` call).
 *   2. The runtime dispatches those calls against the REAL tool layer + the
 *      fixture SQLite DB — so the tool outputs, the tool-call trace, and the
 *      tool-efficiency guard are all genuinely exercised (no hard-coded data).
 *   3. On its second turn, it reads the real `tool_result` blocks the runtime
 *      fed back, and composes the `submit_answer` payload DIRECTLY FROM THAT
 *      REAL TOOL DATA (the candidate count, the resolved suggestion, the "immune"
 *      verdict, the computed stat value). Nothing the structural assertions check
 *      is faked — only the natural-language authoring the LLM would otherwise do
 *      is replaced by a fixed template.
 *
 * Because the answer text is derived from live tool output, a regression in the
 * tools (e.g. Flying stops being immune to Ground, or compute_stat stops
 * returning 169) makes the composed answer fail the structural assertion — which
 * is the whole point of the deterministic subset.
 *
 * No real Anthropic client is ever constructed here (the client is injected via
 * `runPokebotWith`), so this module never reaches the network.
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  runPokebotWith,
  type AnthropicClientLike,
  type MessageStreamLike,
} from "@/agent/runtime";
import type { AgentContext } from "@/agent/types";
import type {
  Candidates,
  PokebotAnswer,
  QueryPokedexResult,
  ResolveEntityOutput,
  TypeMatchupsDetail,
  TypeName,
} from "@/agent/schemas";

import { runStructural, type AssertResult, type GoldenCase } from "./judge";

// ---------------------------------------------------------------------------
// Scripted-client plumbing
// ---------------------------------------------------------------------------

/** A `tool_use` block as the runtime expects to read it off an assistant turn. */
interface ToolUseBlockLike {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * A deterministic plan for one case: the read-phase tool calls, plus a
 * `compose` that builds the final answer from the (real) tool outputs, keyed by
 * tool name.
 */
interface DeterministicPlan {
  reads: Array<{ name: string; input: unknown }>;
  compose: (outputs: Record<string, unknown>) => PokebotAnswer;
}

/** Build a minimal-but-valid Anthropic.Message carrying the given blocks. */
function scriptedMessage(content: unknown[]): Anthropic.Message {
  return {
    id: "msg_deterministic",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

/**
 * Pull the real tool outputs out of the `tool_result` blocks the runtime placed
 * in the last user message, keyed by the tool name (resolved via the id map the
 * read phase recorded).
 */
function extractToolOutputs(
  params: Anthropic.MessageStreamParams,
  idToName: Map<string, string>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  const last = params.messages[params.messages.length - 1];
  const content = last?.content;
  if (!Array.isArray(content)) return outputs;

  for (const block of content) {
    const b = block as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
    };
    if (b.type !== "tool_result" || !b.tool_use_id) continue;
    const name = idToName.get(b.tool_use_id);
    if (!name) continue;
    let parsed: unknown = b.content;
    if (typeof b.content === "string") {
      try {
        parsed = JSON.parse(b.content);
      } catch {
        parsed = b.content;
      }
    }
    outputs[name] = parsed;
  }
  return outputs;
}

/** Wrap a scripted message in a (no-events) MessageStreamLike. */
function streamOf(message: Anthropic.Message): MessageStreamLike {
  return {
    // No incremental events are needed for the deterministic eval — the runtime
    // just reads finalMessage(). An empty iterator keeps the for-await a no-op.
    [Symbol.asyncIterator](): AsyncIterator<Anthropic.RawMessageStreamEvent> {
      return { next: () => Promise.resolve({ done: true, value: undefined }) };
    },
    finalMessage: () => Promise.resolve(message),
  };
}

/**
 * A scripted Anthropic client that replays a {@link DeterministicPlan}: read
 * phase first, then a single `submit_answer` composed from the real tool data.
 */
function makeScriptedClient(plan: DeterministicPlan): AnthropicClientLike {
  const idToName = new Map<string, string>();
  let call = 0;

  return {
    messages: {
      stream(params: Anthropic.MessageStreamParams): MessageStreamLike {
        call += 1;

        // Turn 1 — issue the planned read tool calls (real dispatch follows).
        if (call === 1 && plan.reads.length > 0) {
          const content: ToolUseBlockLike[] = plan.reads.map((read, i) => {
            const id = `read-${i}`;
            idToName.set(id, read.name);
            return { type: "tool_use", id, name: read.name, input: read.input };
          });
          return streamOf(scriptedMessage(content));
        }

        // Turn 2 — compose submit_answer from the real tool outputs.
        const outputs = extractToolOutputs(params, idToName);
        let answer: PokebotAnswer;
        try {
          answer = plan.compose(outputs);
        } catch (err) {
          // A compose throw means the tool output wasn't the expected shape;
          // surface it as a clearly-failing answer rather than a transport fault.
          answer = {
            status: "insufficient_data",
            answer_markdown: `deterministic compose failed: ${String(err)}`,
            reasoning_markdown: "",
            citations: [],
            inferences: [],
            generation_basis: { generation: "gen-9", fallback: false },
          };
        }
        return streamOf(
          scriptedMessage([
            {
              type: "tool_use",
              id: "submit",
              name: "submit_answer",
              input: answer,
            },
          ]),
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Compose helpers
// ---------------------------------------------------------------------------

const GEN9_BASIS: PokebotAnswer["generation_basis"] = {
  generation: "gen-9",
  fallback: false,
};

/** Is this a successful query_pokedex result (vs. an error/unresolved shape)? */
function isQueryResult(o: unknown): o is QueryPokedexResult {
  return (
    typeof o === "object" &&
    o !== null &&
    Array.isArray((o as { results?: unknown }).results)
  );
}

/** Map a query_pokedex result to the PokebotAnswer `candidates` block. */
function candidatesFrom(q: QueryPokedexResult): Candidates {
  return {
    total_count: q.total_count,
    truncated: q.truncated,
    sort: q.sort,
    shown: q.results.map((r) => ({
      name: r.display_name,
      dex_number: r.national_dex_number,
      sprite_url: r.sprite_url,
      types: r.types as TypeName[],
      base_stats: r.base_stats,
      ability: r.abilities.slot1,
    })),
  };
}

/** Total match count for a query result, or 0 for a non-result shape. */
function totalOf(o: unknown): number {
  return isQueryResult(o) ? o.total_count : 0;
}

// ---------------------------------------------------------------------------
// Per-case deterministic plans (only the `deterministic: true` cases)
// ---------------------------------------------------------------------------

const PLANS: Record<string, DeterministicPlan> = {
  // G1 — multi-move intersection in ONE query_pokedex call (no per-mon fetches).
  G1: {
    reads: [
      {
        name: "query_pokedex",
        input: { moves: ["trick-room", "will-o-wisp"], limit: 50 },
      },
    ],
    compose: (o) => {
      const q = o.query_pokedex;
      const total = totalOf(q);
      return {
        status: "answered",
        answer_markdown: `**${total}** Pokémon can learn both Trick Room and Will-O-Wisp in Gen 9.`,
        reasoning_markdown:
          "Intersected the Gen-9 learnsets for both moves in a single query — only Pokémon that learn BOTH appear.",
        candidates: isQueryResult(q) ? candidatesFrom(q) : undefined,
        citations: [
          {
            source: "learnset/trick-room (gen-9)",
            detail: "Gen-9 learnset, intersected",
          },
          {
            source: "learnset/will-o-wisp (gen-9)",
            detail: "Gen-9 learnset, intersected",
          },
        ],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G3 — misspelling resolves to a suggestion (resolve_entity quality).
  G3: {
    reads: [
      {
        name: "resolve_entity",
        input: { query: "Will-o-Whisp", kind: "move" },
      },
    ],
    compose: (o) => {
      const r = o.resolve_entity as ResolveEntityOutput | undefined;
      const matches = r?.matches ?? [];
      const top = matches[0]?.display_name ?? "(no match)";
      return {
        status: "clarification_needed",
        answer_markdown: `I couldn't find a move with that exact name — did you mean **${top}**? If so, I'll pull the list of Pokémon that can learn it.`,
        reasoning_markdown:
          "The name didn't match a known move; offering the closest valid match rather than returning a silent empty result (BR-9).",
        suggestions: matches.map((m) => m.display_name),
        citations: [],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G5 — combined type + ability + move filter in ONE query_pokedex call.
  G5: {
    reads: [
      {
        name: "query_pokedex",
        input: {
          types: ["fire"],
          abilities: ["flash-fire"],
          moves: ["will-o-wisp"],
        },
      },
    ],
    compose: (o) => {
      const q = o.query_pokedex;
      const total = totalOf(q);
      return {
        status: "answered",
        answer_markdown: `**${total}** Fire-type Pokémon with Flash Fire can learn Will-O-Wisp in Gen 9.`,
        reasoning_markdown:
          "Single query intersecting type, ability, and Gen-9 learnset — no per-Pokémon fetching.",
        candidates: isQueryResult(q) ? candidatesFrom(q) : undefined,
        citations: [
          {
            source: "learnset/will-o-wisp (gen-9)",
            detail: "Gen-9 learnset filter",
          },
        ],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G6 — superlative via sort, not N fetches.
  G6: {
    reads: [
      {
        name: "query_pokedex",
        input: { sort_by: "speed", order: "desc", limit: 20 },
      },
    ],
    compose: (o) => {
      const q = o.query_pokedex;
      const top = isQueryResult(q) ? q.results[0]?.display_name : undefined;
      return {
        status: "answered",
        answer_markdown:
          `Ranked by base **speed** (descending).` +
          (top ? ` Fastest in the index: **${top}**.` : ""),
        reasoning_markdown:
          "Sorted the Pokédex index by base speed — a ranked superlative query, no per-Pokémon fetching.",
        candidates: isQueryResult(q) ? candidatesFrom(q) : undefined,
        citations: [
          { source: "Pokédex index", detail: "sorted by base speed (desc)" },
        ],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G8 — type + stat threshold + move filter in ONE query_pokedex call.
  G8: {
    reads: [
      {
        name: "query_pokedex",
        input: {
          types: ["fire"],
          stat_filters: [{ stat: "speed", op: ">", value: 100 }],
          moves: ["will-o-wisp"],
        },
      },
    ],
    compose: (o) => {
      const q = o.query_pokedex;
      const total = totalOf(q);
      return {
        status: "answered",
        answer_markdown: `**${total}** Fire-type Pokémon with base Speed over 100 can learn Will-O-Wisp in Gen 9.`,
        reasoning_markdown:
          "One combined query over type + a Speed threshold + the Gen-9 learnset.",
        candidates: isQueryResult(q) ? candidatesFrom(q) : undefined,
        citations: [
          {
            source: "learnset/will-o-wisp (gen-9)",
            detail: "Gen-9 learnset filter",
          },
        ],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G11 — immunity must be reported as immune (0×), derived from the type chart.
  G11: {
    reads: [{ name: "get_type_matchups", input: { types: ["ground"] } }],
    compose: (o) => {
      const t = o.get_type_matchups as TypeMatchupsDetail | undefined;
      const noEffect = t?.offensive?.no_effect_against ?? [];
      const flyingImmune = noEffect.includes("flying");
      const verdict = flyingImmune
        ? "No — **Flying is immune (0×) to Ground**: Ground deals zero damage to Flying. That is a full immunity, not a partial resistance."
        : "Flying is **not immune** to Ground in the current type chart.";
      return {
        status: "answered",
        answer_markdown: verdict,
        reasoning_markdown:
          "Read the Ground type's offensive profile from the latest type chart; Flying appears under no_effect_against (0×).",
        citations: [
          {
            source: "type/ground",
            detail: "Ground has no effect (0×) on Flying",
          },
        ],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },

  // G15 — exact stat value comes from the real compute_stat formula tool.
  G15: {
    reads: [
      {
        name: "compute_stat",
        input: {
          base_stat: 102,
          level: 50,
          ev: 252,
          iv: 31,
          nature_effect: "boosted",
        },
      },
    ],
    compose: (o) => {
      const c = o.compute_stat as
        | { value?: number; breakdown?: string }
        | undefined;
      const value = c?.value;
      return {
        status: "answered",
        answer_markdown: `Garchomp's Speed is **${value}** at Level 50 with 252 Speed EVs, a 31 Speed IV, and a Jolly (+Speed) nature.`,
        reasoning_markdown:
          "Garchomp's base Speed is 102. The exact in-game formula (per-step flooring) is applied by compute_stat, not by hand.",
        damage_calc: {
          // `value ?? 0`: the free-form damage_calc maps are now typed as JSON
          // scalars (no undefined) so the submit_answer schema stays xAI-strict-
          // safe; the real compute_stat tool always returns a number here.
          assumptions: { level: 50, ev: 252, iv: 31, nature: "Jolly (+Spe)" },
          result: { stat: "speed", value: value ?? 0 },
          is_estimate: true,
          breakdown: c?.breakdown ?? "",
        },
        citations: [{ source: "pokemon/garchomp", detail: "base Speed 102" }],
        inferences: [],
        generation_basis: GEN9_BASIS,
      };
    },
  },
};

/** Case IDs that have a registered deterministic plan. */
export const PLANNED_CASE_IDS: readonly string[] = Object.keys(PLANS);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** First (or only) user input of a case. Deterministic cases are single-turn. */
function primaryInput(gc: GoldenCase): string {
  return Array.isArray(gc.input) ? (gc.input[0] ?? "") : gc.input;
}

/**
 * Run the deterministic subset against the supplied {@link AgentContext} (which
 * must be bound to the fixture DB — see eval/fixtures/seed-fixture-db.ts).
 *
 * For each case: drive the real runtime with a scripted (mocked) Anthropic
 * client + the real tool layer, then apply the shared structural assertions
 * (runStructural — the same checks the judged suite uses). No LLM is called.
 *
 * A case without a registered plan is reported as a failure (so the subset can
 * never silently shrink), not skipped.
 */
export async function runDeterministic(
  cases: GoldenCase[],
  ctx: AgentContext,
): Promise<AssertResult[]> {
  const results: AssertResult[] = [];

  for (const gc of cases) {
    const plan = PLANS[gc.id];

    if (!plan) {
      results.push({
        caseId: gc.id,
        pass: false,
        failures: [
          `no deterministic plan registered for ${gc.id} — add one to eval/deterministic.ts PLANS or remove deterministic:true from the case`,
        ],
        answer: {
          status: "insufficient_data",
          answer_markdown: "",
          reasoning_markdown: "",
          citations: [],
          inferences: [],
          generation_basis: GEN9_BASIS,
        },
      });
      continue;
    }

    const toolCalls: string[] = [];
    const client = makeScriptedClient(plan);
    const answer = await runPokebotWith(
      client,
      primaryInput(gc),
      [],
      ctx,
      (event) => toolCalls.push(event.tool),
    );

    const failures = runStructural(answer, gc, toolCalls);
    results.push({
      caseId: gc.id,
      pass: failures.length === 0,
      failures,
      answer,
    });
  }

  return results;
}
