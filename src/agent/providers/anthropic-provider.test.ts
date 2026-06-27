/**
 * Unit tests for AnthropicProvider — the refactor that moved the Anthropic-shaped
 * logic behind the LLMProvider seam. Asserts the request mapping (system segments
 * → text blocks with exactly ONE ephemeral breakpoint, tools → input_schema,
 * adaptive thinking + tool_choice auto), the content_block_* → normalized event
 * adaptation, the final-turn assembly, cache-aware usage math, and the
 * one-user-message tool_result shape. A fake client (no network) injects a
 * recorded transcript.
 */

import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "./anthropic-provider";
import type { AnthropicClientLike } from "./anthropic-provider";
import type { TurnRequest } from "@/agent/providers/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeClient(message: any, events: any[] = []) {
  const captured: { params?: any; options?: any } = {};
  const client: AnthropicClientLike = {
    messages: {
      stream(params: any, options?: any) {
        captured.params = params;
        captured.options = options;
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          finalMessage: () => Promise.resolve(message),
        } as any;
      },
    },
  };
  return { client, captured };
}

const SYSTEM: TurnRequest["system"] = [
  { text: "SYS BODY" },
  { text: "FEW SHOT", cacheBreakpoint: true },
];
const TOOLS: TurnRequest["tools"] = [
  { name: "submit_answer", description: "submit", parameters: { type: "object" } },
];

function usage(extra: Record<string, unknown> = {}) {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 7,
    output_tokens_details: { thinking_tokens: 3 },
    ...extra,
  };
}

describe("AnthropicProvider — request mapping", () => {
  it("maps segments to text blocks with exactly one ephemeral breakpoint on the last", () => {
    const { client, captured } = fakeClient({ content: [], usage: usage() });
    const provider = new AnthropicProvider({ apiModelId: "claude-sonnet-4-6" }, client);
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });

    const sys = captured.params.system;
    expect(sys[0]).toEqual({ type: "text", text: "SYS BODY" });
    expect(sys[1]).toEqual({
      type: "text",
      text: "FEW SHOT",
      cache_control: { type: "ephemeral" },
    });
    expect(sys.filter((b: any) => b.cache_control)).toHaveLength(1);
  });

  it("sends adaptive thinking + tool_choice auto (never forced), and the model id", () => {
    const { client, captured } = fakeClient({ content: [], usage: usage() });
    const provider = new AnthropicProvider({ apiModelId: "claude-sonnet-4-6" }, client);
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
      signal: undefined,
    });
    expect(captured.params.thinking).toEqual({ type: "adaptive" });
    expect(captured.params.tool_choice).toEqual({ type: "auto" });
    expect(captured.params.model).toBe("claude-sonnet-4-6");
    expect(captured.params.tools[0]).toEqual({
      name: "submit_answer",
      description: "submit",
      input_schema: { type: "object" },
    });
  });

  it("builds the transcript as history then the current message", () => {
    const provider = new AnthropicProvider({}, fakeClient({ content: [], usage: usage() }).client);
    const transcript = provider.createTranscript(
      [
        { role: "user", content: "prev q" },
        { role: "assistant", content: "prev a" },
      ],
      "now",
    ) as any[];
    expect(transcript).toEqual([
      { role: "user", content: "prev q" },
      { role: "assistant", content: "prev a" },
      { role: "user", content: "now" },
    ]);
  });

  it("kind is anthropic and apiModelId defaults from env", () => {
    const provider = new AnthropicProvider({}, fakeClient({ content: [], usage: usage() }).client);
    expect(provider.kind).toBe("anthropic");
    expect(provider.apiModelId).toBe("claude-sonnet-4-6");
  });
});

describe("AnthropicProvider — stream adaptation + final turn", () => {
  it("adapts content_block_* events to normalized tool_call_* events", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "submit_answer", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      },
      { type: "content_block_stop", index: 0 },
    ];
    const message = {
      content: [{ type: "tool_use", id: "t1", name: "submit_answer", input: { a: 1 } }],
      usage: usage(),
    };
    const { client } = fakeClient(message, events);
    const provider = new AnthropicProvider({}, client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });

    const seen: string[] = [];
    for await (const e of stream) {
      if (e.type === "tool_call_start") seen.push(`start:${e.name}`);
      else if (e.type === "tool_call_args_delta") seen.push(`args:${e.argChunk}`);
      else if (e.type === "tool_call_stop") seen.push("stop");
    }
    expect(seen).toEqual(["start:submit_answer", 'args:{"a":1}', "stop"]);

    const final = await stream.final();
    expect(final.toolCalls).toEqual([
      { id: "t1", name: "submit_answer", input: { a: 1 }, inputJson: '{"a":1}' },
    ]);
    // Cache-aware usage: input + cache_read + cache_creation.
    expect(final.usage).toEqual({
      inputTokens: 10 + 7 + 2,
      outputTokens: 5,
      thinkingTokens: 3,
    });
    const echo = final.assistantContentToEcho as any;
    expect(echo).toEqual({ role: "assistant", content: message.content });
  });
});

describe("AnthropicProvider — tool result messages", () => {
  it("returns ONE user message of tool_result blocks, flagging errors", () => {
    const provider = new AnthropicProvider({}, fakeClient({ content: [], usage: usage() }).client);
    const msgs = provider.buildToolResultMessages([
      { toolCallId: "t1", content: "ok", isError: false },
      { toolCallId: "t2", content: "bad", isError: true },
    ]) as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "bad", is_error: true },
    ]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
