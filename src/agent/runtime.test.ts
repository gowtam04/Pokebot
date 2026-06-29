/**
 * Unit tests for the agent runtime (`runOakWith` — the injectable seam of
 * `runOak`). The Anthropic client is a recorded-transcript stub and the
 * tool layer (`@/agent/tools`) is mocked, so these tests are deterministic and
 * never open SQLite or hit the model (design.md Phase 5 test focus).
 *
 * Coverage: the request shape (adaptive thinking + tool_choice "auto", NOT a
 * forced tool_choice; one ephemeral cache breakpoint on the last system block),
 * the happy path, tool dispatch + onProgress + single-user-message tool_results,
 * the submit_answer validate/re-emit budget, and every synthesized-fallback /
 * propagation branch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentContext, ChatMessage } from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";

// --- Mock the tool layer so importing the runtime never opens a Postgres pool.
const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock("@/agent/tools", () => ({
  tools: [
    {
      name: "query_pokedex",
      description: "d",
      inputSchema: { type: "object" },
      run: vi.fn(),
    },
    {
      name: "get_pokemon",
      description: "d",
      inputSchema: { type: "object" },
      run: vi.fn(),
    },
    {
      name: "submit_answer",
      description: "d",
      inputSchema: { type: "object" },
      run: vi.fn(),
    },
  ],
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

// Enrichment is integration-tested separately (enrich-answer.integration.test.ts).
// Stub it to a pass-through here so this unit test never pulls the data layer
// (@/data/repos/* → @/data/db is `server-only`).
vi.mock("@/agent/enrich-answer", () => ({
  enrichAnswer: async (answer: unknown) => answer,
}));

import {
  AnswerMarkdownExtractor,
  describeToolCall,
  MAX_EMPTY_TURN_NUDGES,
  MAX_ITERATIONS,
  runOakWith,
  SUBMIT_NUDGE_REMAINING,
} from "./runtime";

// --- Fixtures --------------------------------------------------------------

const validAnswer: OakAnswer = {
  status: "answered",
  answer_markdown: "Garchomp is Dragon/Ground.",
  reasoning_markdown: "Looked up the profile.",
  citations: [{ source: "Pokédex index", detail: "Garchomp #445" }],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

const info = vi.fn();
const ctx = {
  db: {},
  requestId: "req-1",
  logger: {
    info,
    bindings: () => ({ request_id: "req-1", session_id: "sess-1" }),
  },
} as unknown as AgentContext;

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function textBlock(text: string): Block {
  return { type: "text", text };
}

function toolUse(name: string, input: unknown, id: string): Block {
  return { type: "tool_use", id, name, input };
}

function message(content: Block[], stopReason = "tool_use"): unknown {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: stopReason,
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
/** A fake MessageStream: async-iterable over `events`, finalMessage = `message`. */
function fakeStream(message: any, events: any[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: () => Promise.resolve(message),
  };
}

/** A fake MessageStream that faults (transport error) on iteration + finalMessage. */
function faultStream(err: Error) {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(err) };
    },
    finalMessage: () => Promise.reject(err),
  };
}

/**
 * Build a client whose `messages.stream` replays a scripted transcript. The
 * runtime keeps mutating its live `messages` array after each call, so we snap
 * a deep copy of every request's params into `snapshots[i]` for assertions.
 *
 * Each entry of `responses` is either a bare scripted message (no streaming
 * events), an `Error` (a transport fault), or `{ message, events }` to also
 * replay raw stream events (used by the answer-delta streaming test).
 */
function scriptedClient(responses: unknown[]) {
  const snapshots: any[] = [];
  const stream = vi.fn((params: any, _options?: { signal?: AbortSignal }) => {
    snapshots.push(structuredClone(params));
    const next = responses.shift();
    if (next === undefined) return faultStream(new Error("transcript exhausted"));
    if (next instanceof Error) return faultStream(next);
    if (next && typeof next === "object" && "message" in next) {
      return fakeStream((next as any).message, (next as any).events ?? []);
    }
    return fakeStream(next);
  });
  return { client: { messages: { stream } } as any, stream, snapshots };
}

/** Raw stream events for a submit_answer block, chunking its JSON input. */
function submitAnswerEvents(input: unknown, index = 0, chunkSize = 7): any[] {
  const json = JSON.stringify(input);
  const deltas: any[] = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    deltas.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json.slice(i, i + chunkSize) },
    });
  }
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: "t1", name: "submit_answer", input: {} },
    },
    ...deltas,
    { type: "content_block_stop", index },
  ];
}

/** Raw stream events for an assistant text block (drives text_delta capture). */
function textEvents(text: string, index = 0): any[] {
  return [
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  ];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  mockDispatch.mockReset();
  info.mockReset();
});

// --- Request shape ---------------------------------------------------------

describe("request shape (RISK DIRECTIVE: no forced tool_choice on Sonnet 4.6)", () => {
  it("sends adaptive thinking + tool_choice auto, never a forced tool", async () => {
    const { client, snapshots } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);

    await runOakWith(client, "is Garchomp fast?", [], ctx);

    const params = snapshots[0];
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.tool_choice).toEqual({ type: "auto" });
    // Must NOT force submit_answer (that would 400 alongside thinking).
    expect(params.tool_choice.type).not.toBe("tool");
    expect(params.model).toBe("claude-sonnet-4-6");
  });

  it("places exactly one ephemeral cache breakpoint on the last system block", async () => {
    const { client, snapshots } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);

    await runOakWith(client, "q", [], ctx);

    const { system } = snapshots[0];
    expect(system[0].cache_control).toBeUndefined();
    expect(system[system.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
    const breakpoints = system.filter(
      (b: { cache_control?: unknown }) => b.cache_control,
    );
    expect(breakpoints).toHaveLength(1);
  });

  it("appends history then the current message as the variable tail", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "prev question" },
      { role: "assistant", content: "prev answer" },
    ];
    const { client, snapshots } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);

    await runOakWith(client, "follow up", history, ctx);

    const { messages } = snapshots[0];
    expect(messages[0]).toEqual({ role: "user", content: "prev question" });
    expect(messages[1]).toEqual({ role: "assistant", content: "prev answer" });
    expect(messages[2]).toEqual({ role: "user", content: "follow up" });
  });

  it("threads ctx.images onto the current user message (consume-on-turn)", async () => {
    const { client, snapshots } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);
    const ctxWithImage = {
      ...ctx,
      images: [{ mimeType: "image/png", data: "AAAA" }],
    } as unknown as AgentContext;

    await runOakWith(client, "what's on this team?", [], ctxWithImage);

    const { messages } = snapshots[0];
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "text", text: "what's on this team?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});

// --- Happy paths -----------------------------------------------------------

describe("submit_answer termination", () => {
  it("returns the validated answer on a first valid submit (no dispatch)", async () => {
    const onProgress = vi.fn();
    const { client } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);

    const result = await runOakWith(client, "q", [], ctx, onProgress);

    expect(result).toEqual(validAnswer);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      tool: "submit_answer",
      label: expect.any(String),
    });
    // Per-turn trace logged exactly once.
    expect(info).toHaveBeenCalledTimes(1);
    const [trace] = info.mock.calls[0];
    expect(trace).toMatchObject({
      request_id: "req-1",
      session_id: "sess-1",
      status: "answered",
      citation_count: 1,
      thinking_tokens: 3,
    });
  });

  it("passes a stop-and-ask payload (question.options) through unchanged", async () => {
    const questionAnswer = {
      status: "clarification_needed",
      answer_markdown: "Singles or Doubles?",
      reasoning_markdown: "Format changes the recommendation.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      question: {
        options: [
          { label: "Singles", description: "6v6" },
          { label: "Doubles" },
        ],
      },
    };
    const { client } = scriptedClient([
      message([toolUse("submit_answer", questionAnswer, "t1")]),
    ]);

    const result = await runOakWith(client, "build a TR team", [], ctx);

    // The loop returns the validated answer verbatim — the new field is intact.
    expect(result).toEqual(questionAnswer);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches a tool, emits progress, then returns the answer", async () => {
    mockDispatch.mockResolvedValueOnce({ total_count: 3, results: [] });
    const onProgress = vi.fn();
    const { client, snapshots } = scriptedClient([
      message([toolUse("query_pokedex", { types: ["fire"] }, "t1")]),
      message([toolUse("submit_answer", validAnswer, "t2")]),
    ]);

    const result = await runOakWith(
      client,
      "fire types",
      [],
      ctx,
      onProgress,
    );

    expect(result).toEqual(validAnswer);
    expect(mockDispatch).toHaveBeenCalledWith(
      "query_pokedex",
      { types: ["fire"] },
      ctx,
    );
    expect(onProgress).toHaveBeenCalledWith({
      tool: "query_pokedex",
      label: expect.any(String),
    });

    // The tool result is fed back in ONE user message with the matching id.
    const secondCallMessages = snapshots[1].messages;
    const lastUser = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toHaveLength(1);
    expect(lastUser.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
    });
  });

  it("returns ALL parallel tool_results in a single user message", async () => {
    mockDispatch.mockResolvedValue({ ok: true });
    const { client, snapshots } = scriptedClient([
      message([
        toolUse("query_pokedex", {}, "t1"),
        toolUse("get_pokemon", { name: "x" }, "t2"),
      ]),
      message([toolUse("submit_answer", validAnswer, "t3")]),
    ]);

    await runOakWith(client, "q", [], ctx);

    const secondCallMessages = snapshots[1].messages;
    const lastUser = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUser.content).toHaveLength(2);
    expect(
      lastUser.content.map((c: { tool_use_id: string }) => c.tool_use_id),
    ).toEqual(["t1", "t2"]);
  });
});

// --- Validation / retry budget --------------------------------------------

describe("submit_answer validation + re-emit budget", () => {
  it("re-emits a validation error on an invalid payload, then accepts the fix", async () => {
    const { client, snapshots } = scriptedClient([
      message([toolUse("submit_answer", { status: "answered" }, "t1")]), // invalid
      message([toolUse("submit_answer", validAnswer, "t2")]),
    ]);

    const result = await runOakWith(client, "q", [], ctx);

    expect(result).toEqual(validAnswer);
    const secondCallMessages = snapshots[1].messages;
    const lastUser = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUser.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      is_error: true,
    });
    expect(lastUser.content[0].content).toMatch(/failed validation/i);
  });

  it("synthesizes insufficient_data after the re-emit budget is exhausted", async () => {
    const invalid = () =>
      message([toolUse("submit_answer", { status: "answered" }, "tx")]);
    const { client, stream } = scriptedClient([
      invalid(),
      invalid(),
      invalid(),
    ]);

    const result = await runOakWith(client, "q", [], ctx);

    expect(result.status).toBe("insufficient_data");
    expect(result.uncertainty_flags).toContain(
      "submit_answer_invalid_after_retries",
    );
    // 2 re-emits → 3 model calls total.
    expect(stream).toHaveBeenCalledTimes(3);
  });
});

// --- Synthesized fallbacks + propagation -----------------------------------

describe("orchestration fallbacks", () => {
  it("synthesizes insufficient_data when the loop hits the iteration cap", async () => {
    // The model never submits — always asks for another tool.
    const { client, stream } = scriptedClient([]);
    stream.mockImplementation(() =>
      fakeStream(message([toolUse("query_pokedex", {}, "t")])),
    );
    mockDispatch.mockResolvedValue({ ok: true });

    const result = await runOakWith(client, "q", [], ctx);

    expect(result.status).toBe("insufficient_data");
    expect(result.uncertainty_flags).toContain("max_iterations_reached");
    expect(stream).toHaveBeenCalledTimes(MAX_ITERATIONS);
  });

  it("nudges the model to submit once, SUBMIT_NUDGE_REMAINING iterations before the cap", async () => {
    // The model never submits — always asks for another tool, so the loop runs
    // every iteration and the late-iteration submit nudge fires. Script one
    // tool-use response per iteration (rather than mockImplementation, which
    // would bypass the snapshot recorder).
    const { client, stream, snapshots } = scriptedClient(
      Array.from({ length: MAX_ITERATIONS }, () =>
        message([toolUse("query_pokedex", {}, "t")]),
      ),
    );
    mockDispatch.mockResolvedValue({ ok: true });

    await runOakWith(client, "q", [], ctx);

    expect(stream).toHaveBeenCalledTimes(MAX_ITERATIONS);
    const nudgeCount = (params: {
      messages: { role: string; content: unknown }[];
    }) =>
      params.messages.filter(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("close to the tool-call limit"),
      ).length;

    // Fires once at iteration (cap − SUBMIT_NUDGE_REMAINING): absent from the
    // request *at* that iteration, present (and last) on the very next one.
    const fireAt = MAX_ITERATIONS - SUBMIT_NUDGE_REMAINING;
    expect(nudgeCount(snapshots[fireAt])).toBe(0);
    expect(nudgeCount(snapshots[fireAt + 1])).toBe(1);
    expect(snapshots[fireAt + 1].messages.at(-1).content).toContain(
      "close to the tool-call limit",
    );
    // Never duplicated, even though several iterations remain after it fires.
    expect(nudgeCount(snapshots.at(-1))).toBe(1);
  });

  it("nudges back to submit_answer when a turn ends with no tool call, then accepts the submit", async () => {
    const { client, stream, snapshots } = scriptedClient([
      message([textBlock("here is some prose")], "end_turn"),
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);

    const result = await runOakWith(client, "q", [], ctx);

    expect(result).toEqual(validAnswer);
    expect(stream).toHaveBeenCalledTimes(2);
    // The retry transcript ends with the corrective nudge as a user message.
    const tail = snapshots[1].messages.at(-1);
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("without calling submit_answer");
  });

  it("surfaces the model's prose once the empty-turn nudge budget is spent", async () => {
    const proseTurn = (text: string) => ({
      message: message([textBlock(text)], "end_turn"),
      events: textEvents(text),
    });
    const { client, stream } = scriptedClient(
      // budget + 1 empty turns: the last one's prose is what we surface.
      Array.from({ length: MAX_EMPTY_TURN_NUDGES + 1 }, (_, i) =>
        proseTurn(i === MAX_EMPTY_TURN_NUDGES ? "final prose answer" : `draft ${i}`),
      ),
    );

    const result = await runOakWith(client, "q", [], ctx);

    expect(stream).toHaveBeenCalledTimes(MAX_EMPTY_TURN_NUDGES + 1);
    expect(result.status).toBe("answered");
    expect(result.answer_markdown).toBe("final prose answer");
    expect(result.uncertainty_flags).toContain("recovered_prose_no_submit_answer");
  });

  it("falls back to insufficient_data when the empty turns carry no prose", async () => {
    const { client, stream } = scriptedClient(
      Array.from({ length: MAX_EMPTY_TURN_NUDGES + 1 }, () =>
        message([], "end_turn"),
      ),
    );

    const result = await runOakWith(client, "q", [], ctx);

    expect(stream).toHaveBeenCalledTimes(MAX_EMPTY_TURN_NUDGES + 1);
    expect(result.status).toBe("insufficient_data");
    expect(result.uncertainty_flags).toContain(
      "model_ended_turn_without_submit_answer",
    );
  });

  it("feeds a thrown tool fault back to the model rather than crashing", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("db exploded"));
    const { client, snapshots } = scriptedClient([
      message([toolUse("query_pokedex", {}, "t1")]),
      message([toolUse("submit_answer", validAnswer, "t2")]),
    ]);

    const result = await runOakWith(client, "q", [], ctx);

    expect(result).toEqual(validAnswer);
    const lastUser = snapshots[1].messages.at(-1);
    expect(lastUser.content[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
    });
    expect(lastUser.content[0].content).toMatch(/db exploded/);
  });

  it("propagates a transport/API fault as a thrown error", async () => {
    const { client } = scriptedClient([new Error("boom 529")]);

    await expect(runOakWith(client, "q", [], ctx)).rejects.toThrow(
      "boom 529",
    );
  });
});

// --- Client abort (the Stop button) ----------------------------------------

describe("client abort (Stop)", () => {
  it("forwards ctx.signal to messages.stream so the SDK can tear down the request", async () => {
    const { client, stream } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);
    const controller = new AbortController();
    const ctxWithSignal = { ...ctx, signal: controller.signal } as AgentContext;

    await runOakWith(client, "q", [], ctxWithSignal);

    // Second arg is the request options carrying the abort signal.
    expect(stream.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("throws AbortError without calling the model when ctx.signal is already aborted", async () => {
    const { client, stream } = scriptedClient([
      message([toolUse("submit_answer", validAnswer, "t1")]),
    ]);
    const ctxAborted = { ...ctx, signal: AbortSignal.abort() } as AgentContext;

    await expect(runOakWith(client, "q", [], ctxAborted)).rejects.toThrow(
      /Aborted/,
    );
    // The loop-top guard fires before the first model call.
    expect(stream).not.toHaveBeenCalled();
  });
});

// --- Answer-markdown streaming (token-by-token) ----------------------------

describe("answer_markdown streaming", () => {
  it("fires onAnswerStart once and streams deltas equal to the final answer", async () => {
    const { client } = scriptedClient([
      {
        message: message([toolUse("submit_answer", validAnswer, "t1")]),
        events: submitAnswerEvents(validAnswer),
      },
    ]);

    const starts: number[] = [];
    const deltas: string[] = [];
    const result = await runOakWith(
      client,
      "q",
      [],
      ctx,
      undefined,
      () => starts.push(1),
      (text) => deltas.push(text),
    );

    expect(result).toEqual(validAnswer);
    expect(starts).toHaveLength(1);
    expect(deltas.join("")).toBe(validAnswer.answer_markdown);
  });

  it("does not stream answer text for non-submit tool blocks", async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true });
    const { client } = scriptedClient([
      {
        message: message([toolUse("query_pokedex", { types: ["fire"] }, "t1")]),
        events: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "t1",
              name: "query_pokedex",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"types":["fire"]}',
            },
          },
          { type: "content_block_stop", index: 0 },
        ],
      },
      message([toolUse("submit_answer", validAnswer, "t2")]),
    ]);

    const starts: number[] = [];
    const deltas: string[] = [];
    await runOakWith(
      client,
      "fire types",
      [],
      ctx,
      undefined,
      () => starts.push(1),
      (text) => deltas.push(text),
    );

    // The query_pokedex block has no answer_markdown — nothing streams from it.
    expect(starts).toHaveLength(0);
    expect(deltas.join("")).toBe("");
  });
});

// --- AnswerMarkdownExtractor (the incremental JSON string decoder) ----------

describe("AnswerMarkdownExtractor", () => {
  /** Feed `json` to a fresh extractor in `chunkSize`-char pushes; return output. */
  function extract(json: string, chunkSize: number): string {
    const ex = new AnswerMarkdownExtractor();
    let out = "";
    for (let i = 0; i < json.length; i += chunkSize) {
      out += ex.push(json.slice(i, i + chunkSize));
    }
    return out;
  }

  it("reconstructs the value across every chunk boundary", () => {
    const value = "Hello **world**\nLine two — *italics*, a \"quote\", and / slash.";
    const json = JSON.stringify({
      status: "answered",
      answer_markdown: value,
      reasoning_markdown: "why",
    });
    for (const size of [1, 2, 3, 5, 13, 1000]) {
      expect(extract(json, size)).toBe(value);
    }
  });

  it("ignores a decoy 'answer_markdown' substring inside an earlier value", () => {
    const value = "the real answer";
    const json = JSON.stringify({
      reasoning_markdown: 'mentions the "answer_markdown" key literally',
      answer_markdown: value,
    });
    for (const size of [1, 4, 1000]) {
      expect(extract(json, size)).toBe(value);
    }
  });

  it("skips nested objects/arrays that appear before the key", () => {
    const value = "after the nested stuff";
    const json = JSON.stringify({
      citations: [{ source: "x", detail: "y" }],
      candidates: { total_count: 2, shown: [{ name: "A" }, { name: "B" }] },
      answer_markdown: value,
    });
    for (const size of [1, 3, 9, 1000]) {
      expect(extract(json, size)).toBe(value);
    }
  });

  it("decodes \\uXXXX surrogate pairs without splitting them across chunks", () => {
    // Raw JSON text containing literal backslash-u escapes for 😀 (U+1F600).
    const json = '{"status":"answered","answer_markdown":"hi \\uD83D\\uDE00 end"}';
    for (const size of [1, 2, 3, 7, 1000]) {
      expect(extract(json, size)).toBe("hi 😀 end");
    }
  });

  it("stops at the closing quote and ignores trailing fields", () => {
    const json = JSON.stringify({
      answer_markdown: "only this",
      reasoning_markdown: "ignored",
      citations: [],
    });
    expect(extract(json, 1)).toBe("only this");
  });

  it("returns the empty string when there is no answer_markdown field", () => {
    const json = JSON.stringify({ status: "answered", reasoning_markdown: "x" });
    expect(extract(json, 1)).toBe("");
  });
});

describe("describeToolCall — context-rich progress labels", () => {
  it("names the subject pulled from the tool input", () => {
    expect(describeToolCall("get_pokemon", { name: "pikachu" })).toContain(
      "Pikachu",
    );
    expect(describeToolCall("get_move", { name: "will-o-wisp" })).toContain(
      "Will-O-Wisp",
    );
    expect(describeToolCall("resolve_entity", { query: "garchom" })).toContain(
      "garchom",
    );
  });

  it("summarizes the query_pokedex filters", () => {
    const label = describeToolCall("query_pokedex", {
      types: ["fire"],
      moves: ["will-o-wisp"],
      stat_filters: [{ stat: "speed", op: ">", value: 100 }],
    });
    expect(label).toContain("Fire");
    expect(label).toContain("learns Will-O-Wisp");
    expect(label).toContain("Speed > 100");
  });

  it("falls back to the generic label when args are missing or malformed", () => {
    // Empty/garbage input never throws and still yields a usable string.
    expect(describeToolCall("get_pokemon", {})).toMatch(/Pokémon/);
    expect(describeToolCall("query_pokedex", { types: [] })).toMatch(/Pokédex/);
    expect(describeToolCall("get_move", { name: 123 })).toEqual(
      expect.any(String),
    );
    expect(describeToolCall("unknown_tool", null)).toEqual(expect.any(String));
  });
});
