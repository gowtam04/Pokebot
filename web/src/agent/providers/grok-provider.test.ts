/**
 * Unit tests for GrokProvider (native xAI Responses API) with a MOCKED Responses
 * stream — deterministic, never hits the network. Asserts the request shape
 * (FLATTENED function tools, instructions, reasoning.effort high,
 * parallel_tool_calls false, store false + encrypted-reasoning include), that
 * streamed function-call argument fragments feed the runtime's
 * AnswerMarkdownExtractor to reproduce answer_markdown, the normalized final turn
 * (tool calls + usage + echoed output items), the load-bearing transcript-echo
 * FLATTENING, tool-result/user-message shapes, and transport-error mapping.
 */

import { describe, expect, it, vi } from "vitest";

// Importing AnswerMarkdownExtractor from the runtime transitively pulls the tool
// layer → `@/data/db` (server-only). Neutralize it for this node unit test; we
// only use the pure extractor, never the DB.
vi.mock("server-only", () => ({}));

import OpenAI from "openai";

import { GrokProvider } from "./grok-provider";
import type { GrokResponsesClientLike } from "./grok-provider";
import { ProviderTransportError } from "./errors";
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

const USAGE = {
  input_tokens: 11,
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 4 },
  input_tokens_details: { cached_tokens: 0 },
  total_tokens: 18,
};

/**
 * Script a submit_answer turn: function_call item added → `chunkSize`-char
 * argument deltas → arguments.done → response.completed (output + usage). When
 * `chunkSize` is 0, omit the deltas entirely (the xAI single-shot case).
 */
function submitResponseEvents(input: unknown, chunkSize = 9): any[] {
  const json = JSON.stringify(input);
  const fnCall = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "submit_answer",
    arguments: json,
    status: "completed",
  };
  const events: any[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...fnCall, arguments: "", status: "in_progress" },
    },
  ];
  if (chunkSize > 0) {
    for (let i = 0; i < json.length; i += chunkSize) {
      events.push({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_1",
        sequence_number: events.length + 1,
        delta: json.slice(i, i + chunkSize),
      });
    }
  }
  events.push({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "fc_1",
    name: "submit_answer",
    sequence_number: events.length + 1,
    arguments: json,
  });
  events.push({
    type: "response.completed",
    sequence_number: events.length + 1,
    response: { output: [fnCall], usage: USAGE },
  });
  return events;
}

/** Build a fake client whose Responses stream replays `events`; captures the body. */
function fakeGrokClient(events: any[]) {
  const captured: { body?: any; options?: any } = {};
  const client: GrokResponsesClientLike = {
    responses: {
      create(body: any, options: any) {
        captured.body = body;
        captured.options = options;
        return (async function* () {
          for (const e of events) yield e as any;
        })();
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

function makeProvider(
  client: GrokResponsesClientLike,
  overrides: Partial<ConstructorParameters<typeof GrokProvider>[0]> = {},
) {
  return new GrokProvider(
    {
      apiModelId: "grok-4.3",
      apiKey: "test-key",
      effort: "high",
      temperature: 0.2,
      maxOutputTokens: 32000,
      parallelToolCalls: false,
      ...overrides,
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

describe("GrokProvider — request shape", () => {
  it("sends FLATTENED function tools, instructions, reasoning.effort high, store false + encrypted reasoning", () => {
    const { client, captured } = fakeGrokClient(submitResponseEvents(ANSWER));
    const provider = makeProvider(client);
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });

    const body = captured.body;
    expect(body.model).toBe("grok-4.3");
    expect(body.instructions).toBe("SYS BODY\n\nFEW SHOT");
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBe(32000);
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.2);
    // Responses flattened function tool — NOT the Chat shim's nested {function:{}}.
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "submit_answer",
      description: "submit it",
      parameters: { type: "object" },
      strict: false,
    });
    expect(body.tools[0].function).toBeUndefined();
    // System rides on `instructions`, never the input transcript.
    expect(body.input).toEqual([{ role: "user", content: "q" }]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("omits temperature when none is configured", () => {
    const { client, captured } = fakeGrokClient(submitResponseEvents(ANSWER));
    const provider = makeProvider(client, { temperature: undefined });
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    expect("temperature" in captured.body).toBe(false);
  });
});

describe("GrokProvider — streaming + final turn", () => {
  it("feeds function-call arg fragments through AnswerMarkdownExtractor to reproduce answer_markdown", async () => {
    const { client } = fakeGrokClient(submitResponseEvents(ANSWER, 5));
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

  it("handles xAI's single-chunk tool call (whole arguments via the ...done fallback)", async () => {
    const { client } = fakeGrokClient(submitResponseEvents(ANSWER, 0));
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });

    const extractor = new AnswerMarkdownExtractor();
    const deltas: string[] = [];
    let stops = 0;
    let submitIndex: number | null = null;
    for await (const event of stream) {
      if (event.type === "tool_call_start") submitIndex = event.index;
      else if (
        event.type === "tool_call_args_delta" &&
        event.index === submitIndex
      ) {
        const piece = extractor.push(event.argChunk);
        if (piece) deltas.push(piece);
      } else if (event.type === "tool_call_stop") stops += 1;
    }
    // Exactly one synthesized delta carrying the whole answer, plus one stop.
    expect(deltas).toHaveLength(1);
    expect(deltas.join("")).toBe(ANSWER.answer_markdown);
    expect(stops).toBe(1);
  });

  it("normalizes the final turn (parsed input + usage) and echoes the whole output[]", async () => {
    const events = submitResponseEvents(ANSWER);
    const { client } = fakeGrokClient(events);
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await drain(stream);
    const final = await stream.final();

    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls[0]).toMatchObject({
      id: "call_1",
      name: "submit_answer",
      inputJson: JSON.stringify(ANSWER),
    });
    expect(final.toolCalls[0].input).toEqual(ANSWER);
    expect(final.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      thinkingTokens: 4,
    });
    // assistantContentToEcho is the WHOLE output[] array (echoed verbatim).
    const completed = events[events.length - 1].response;
    expect(final.assistantContentToEcho).toEqual(completed.output);
  });

  it("leaves input undefined on malformed argument JSON (loop re-emit handles it)", async () => {
    const events = submitResponseEvents(ANSWER, 0);
    // Corrupt the arguments on both the done event and the completed output item.
    const done = events.find(
      (e) => e.type === "response.function_call_arguments.done",
    )!;
    done.arguments = "{ not json";
    events[events.length - 1].response.output[0].arguments = "{ not json";

    const { client } = fakeGrokClient(events);
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
});

describe("GrokProvider — transcript echo flattening (load-bearing)", () => {
  const reasoningItem = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "enc",
    summary: [],
  };
  const fnCallItem = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "get_pokemon",
    arguments: "{}",
  };

  function transcriptWithEchoedTurn(provider: GrokProvider) {
    const transcript = provider.createTranscript([], "q");
    // The loop pushes assistantContentToEcho (the whole output[]) as ONE element...
    transcript.push([reasoningItem, fnCallItem] as any);
    // ...then pushes each tool-result message individually.
    for (const m of provider.buildToolResultMessages([
      { toolCallId: "call_1", content: '{"ok":true}', isError: false },
    ])) {
      transcript.push(m);
    }
    return transcript;
  }

  it("flattens the nested echoed turn into a flat, correctly-ordered input array", () => {
    const { client, captured } = fakeGrokClient([]);
    const provider = makeProvider(client);
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: transcriptWithEchoedTurn(provider),
    });
    // function_call precedes its function_call_output; reasoning preserved.
    expect(captured.body.input).toEqual([
      { role: "user", content: "q" },
      reasoningItem,
      fnCallItem,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
  });

  it("drops reasoning items from input when echoReasoning is false", () => {
    const { client, captured } = fakeGrokClient([]);
    const provider = makeProvider(client, { echoReasoning: false });
    provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: transcriptWithEchoedTurn(provider),
    });
    expect(captured.body.input).toEqual([
      { role: "user", content: "q" },
      fnCallItem,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
  });
});

describe("GrokProvider — transcript + result message shapes", () => {
  it("builds one function_call_output per tool call", () => {
    const provider = makeProvider(fakeGrokClient([]).client);
    const msgs = provider.buildToolResultMessages([
      { toolCallId: "call_1", content: "Answer accepted.", isError: false },
      { toolCallId: "call_2", content: '{"ok":true}', isError: false },
    ]) as any[];
    expect(msgs).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "Answer accepted." },
      { type: "function_call_output", call_id: "call_2", output: '{"ok":true}' },
    ]);
  });

  it("builds a plain user message for buildUserMessage", () => {
    const provider = makeProvider(fakeGrokClient([]).client);
    expect(provider.buildUserMessage("nudge")).toEqual({
      role: "user",
      content: "nudge",
    });
  });
});

describe("GrokProvider — image attachments", () => {
  it("a text-only turn keeps content a plain string (byte-identical)", () => {
    const provider = makeProvider(fakeGrokClient([]).client);
    const t = provider.createTranscript([], "q") as any[];
    expect(t[t.length - 1]).toEqual({ role: "user", content: "q" });
  });

  it("attaches input_image data-URL parts after the input_text part", () => {
    const provider = makeProvider(fakeGrokClient([]).client);
    const t = provider.createTranscript([], "what is this?", [
      { mimeType: "image/png", data: "AAAA" },
      { mimeType: "image/jpeg", data: "BBBB" },
    ]) as any[];
    expect(t[t.length - 1]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/png;base64,AAAA",
        },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/jpeg;base64,BBBB",
        },
      ],
    });
  });

  it("an image-only turn (empty text) emits input_image parts with no text part", () => {
    const provider = makeProvider(fakeGrokClient([]).client);
    const t = provider.createTranscript([], "", [
      { mimeType: "image/webp", data: "CCCC" },
    ]) as any[];
    expect(t[t.length - 1]).toEqual({
      role: "user",
      content: [
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/webp;base64,CCCC",
        },
      ],
    });
  });
});

describe("GrokProvider — transport error mapping", () => {
  it("maps an xAI APIError to ProviderTransportError with its status", async () => {
    const apiError = new OpenAI.APIError(401, undefined, "unauthorized", undefined);
    const client: GrokResponsesClientLike = {
      responses: {
        create() {
          return Promise.reject(apiError);
        },
      },
    };
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await expect(drain(stream)).rejects.toBeInstanceOf(ProviderTransportError);
    await expect(drain(provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    }))).rejects.toMatchObject({ status: 401 });
  });

  it("propagates a non-API error unchanged", async () => {
    const boom = new Error("boom");
    const client: GrokResponsesClientLike = {
      responses: {
        create() {
          return Promise.reject(boom);
        },
      },
    };
    const provider = makeProvider(client);
    const stream = provider.streamTurn({
      system: SYSTEM,
      tools: TOOLS,
      transcript: provider.createTranscript([], "q"),
    });
    await expect(drain(stream)).rejects.toBe(boom);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
