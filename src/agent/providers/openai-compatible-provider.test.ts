/**
 * Unit tests for OpenAICompatibleProvider (GPT-5.5 + Grok 4.3) with a MOCKED
 * Chat Completions stream — deterministic, never hits the network. Asserts the
 * request shape (function tools, tool_choice auto, reasoning_effort, streamed
 * usage, NO cache_control), that streamed tool-call argument fragments feed the
 * runtime's AnswerMarkdownExtractor to reproduce answer_markdown, the normalized
 * final turn (tool calls + usage), tool-result message shape, and the xAI
 * single-chunk tool-call behavior.
 */

import { describe, expect, it, vi } from "vitest";

// Importing AnswerMarkdownExtractor from the runtime transitively pulls the tool
// layer → `@/data/db` (server-only). Neutralize it for this node unit test; we
// only use the pure extractor, never the DB.
vi.mock("server-only", () => ({}));

import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import type { OpenAIClientLike } from "./openai-compatible-provider";
import type {
  ProviderStreamEvent,
  TurnRequest,
} from "@/agent/providers/types";
import { AnswerMarkdownExtractor } from "@/agent/runtime";
import type { OakAnswer } from "@/agent/schemas";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "Garchomp is **Dragon/Ground**.\nFast & strong.",
  reasoning_markdown: "Looked it up.",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

const USAGE_CHUNK = {
  choices: [],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    completion_tokens_details: { reasoning_tokens: 4 },
  },
};

/** A submit_answer tool call streamed across `chunkSize`-char argument deltas. */
function submitChunks(input: unknown, chunkSize = 9): any[] {
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
                id: "call_1",
                type: "function",
                function: { name: "submit_answer", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  ];
  for (let i = 0; i < json.length; i += chunkSize) {
    out.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: json.slice(i, i + chunkSize) } },
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

/** Build a fake OpenAI client whose stream replays `chunks`; captures the body. */
function fakeClient(chunks: any[]) {
  const captured: { body?: any; options?: any } = {};
  const client: OpenAIClientLike = {
    chat: {
      completions: {
        create(body: any, options: any) {
          captured.body = body;
          captured.options = options;
          return (async function* () {
            for (const c of chunks) yield c as any;
          })();
        },
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
  { name: "submit_answer", description: "submit it", parameters: { type: "object" } },
  { name: "query_pokedex", description: "search", parameters: { type: "object" } },
];

function makeProvider(client: OpenAIClientLike, kind: "openai" | "xai" = "openai") {
  return new OpenAICompatibleProvider(
    {
      kind,
      apiModelId: kind === "xai" ? "grok-4.3" : "gpt-5.5",
      apiKey: "test-key",
      effort: kind === "xai" ? "high" : "medium",
    },
    client,
  );
}

async function drain(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("OpenAICompatibleProvider — request shape", () => {
  it("sends function tools, tool_choice auto, reasoning_effort, streamed usage, NO cache_control", async () => {
    const { client, captured } = fakeClient(submitChunks(ANSWER));
    const provider = makeProvider(client);
    const transcript = provider.createTranscript([], "q");

    const stream = provider.streamTurn({ system: SYSTEM, tools: TOOLS, transcript });
    await drain(stream);
    await stream.final();

    const body = captured.body;
    expect(body.model).toBe("gpt-5.5");
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    // Tools are OpenAI function tools built from the neutral JSON Schema.
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "submit_answer",
        description: "submit it",
        parameters: { type: "object" },
      },
    });
    // System is one joined message; NO cache_control anywhere in the request.
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS BODY\n\nFEW SHOT" });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("omits reasoning_effort when no effort is configured", async () => {
    const { client, captured } = fakeClient(submitChunks(ANSWER));
    const provider = new OpenAICompatibleProvider(
      { kind: "openai", apiModelId: "gpt-5.5", apiKey: "k" },
      client,
    );
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await drain(stream);
    expect("reasoning_effort" in captured.body).toBe(false);
  });
});

describe("OpenAICompatibleProvider — streaming + final turn", () => {
  it("feeds tool-call arg fragments through AnswerMarkdownExtractor to reproduce answer_markdown", async () => {
    const { client } = fakeClient(submitChunks(ANSWER, 5));
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });

    const extractor = new AnswerMarkdownExtractor();
    let answer = "";
    let starts = 0;
    let submitIndex: number | null = null;
    for await (const event of stream) {
      if (event.type === "tool_call_start" && event.name === "submit_answer") {
        submitIndex = event.index;
        starts += 1;
      } else if (
        event.type === "tool_call_args_delta" &&
        event.index === submitIndex
      ) {
        answer += extractor.push(event.argChunk);
      }
    }

    expect(starts).toBe(1);
    expect(answer).toBe(ANSWER.answer_markdown);
  });

  it("normalizes the final turn (parsed input + usage) and echoes the assistant tool_calls", async () => {
    const { client } = fakeClient(submitChunks(ANSWER));
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await drain(stream);
    const final = await stream.final();

    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls[0].name).toBe("submit_answer");
    expect(final.toolCalls[0].input).toEqual(ANSWER);
    expect(final.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      thinkingTokens: 4,
    });
    const echo = final.assistantContentToEcho as any;
    expect(echo.role).toBe("assistant");
    expect(echo.tool_calls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "submit_answer" },
    });
  });

  it("leaves input undefined on malformed argument JSON (loop re-emit handles it)", async () => {
    const { client } = fakeClient([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_x",
                  type: "function",
                  function: { name: "submit_answer", arguments: "{ not json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      USAGE_CHUNK,
    ]);
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await drain(stream);
    const final = await stream.final();
    expect(final.toolCalls[0].input).toBeUndefined();
    expect(final.toolCalls[0].inputJson).toBe("{ not json");
  });

  it("handles xAI's single-chunk tool call (whole arguments at once)", async () => {
    const json = JSON.stringify(ANSWER);
    const { client } = fakeClient([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_g",
                  type: "function",
                  function: { name: "submit_answer", arguments: json },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      USAGE_CHUNK,
    ]);
    const provider = makeProvider(client, "xai");

    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    const extractor = new AnswerMarkdownExtractor();
    const deltas: string[] = [];
    let submitIndex: number | null = null;
    for await (const event of stream) {
      if (event.type === "tool_call_start") submitIndex = event.index;
      else if (
        event.type === "tool_call_args_delta" &&
        event.index === submitIndex
      ) {
        const piece = extractor.push(event.argChunk);
        if (piece) deltas.push(piece);
      }
    }
    // One delta carrying the whole answer (single-chunk behavior), still correct.
    expect(deltas).toHaveLength(1);
    expect(deltas.join("")).toBe(ANSWER.answer_markdown);
  });
});

describe("OpenAICompatibleProvider — tool result messages", () => {
  it("builds one {role:'tool'} message per tool call", () => {
    const provider = makeProvider(fakeClient([]).client);
    const msgs = provider.buildToolResultMessages([
      { toolCallId: "call_1", content: "Answer accepted.", isError: false },
      { toolCallId: "call_2", content: '{"ok":true}', isError: false },
    ]) as any[];
    expect(msgs).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "Answer accepted." },
      { role: "tool", tool_call_id: "call_2", content: '{"ok":true}' },
    ]);
  });

  it("builds a plain user message for buildUserMessage", () => {
    const provider = makeProvider(fakeClient([]).client);
    expect(provider.buildUserMessage("nudge")).toEqual({
      role: "user",
      content: "nudge",
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
