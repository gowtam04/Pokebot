/**
 * OpenAICompatibleProvider — the Chat Completions transport behind the
 * {@link LLMProvider} seam, serving BOTH OpenAI GPT-5.5 and xAI Grok 4.3.
 *
 * xAI's API is OpenAI-SDK-compatible, so a single adapter handles both: only the
 * api key, base URL, model id, provider kind, and `reasoning_effort` differ
 * (injected from the provider factory). Differences from the Anthropic path:
 *  - System segments are joined into ONE `{role:"system"}` message (Chat
 *    Completions has no separate system field), and there is NO `cache_control`
 *    (OpenAI/xAI cache a stable prefix automatically).
 *  - Tools are `{type:"function", function:{...}}`, NON-strict (the PokebotAnswer
 *    schema's unions/optionals don't satisfy strict structured output — the
 *    loop's Zod re-emit budget is the safety net), with `tool_choice:"auto"` and
 *    `parallel_tool_calls`.
 *  - The streamed `delta.tool_calls[].function.arguments` fragments are fed into
 *    the SAME runtime AnswerMarkdownExtractor as the Anthropic `input_json_delta`
 *    feed. (xAI streams a tool call as a single chunk, so for Grok the answer
 *    arrives in one delta — handled transparently.)
 *  - Tool results are N `{role:"tool", tool_call_id, content}` messages.
 *  - Streamed usage requires `stream_options:{include_usage:true}`.
 */

import OpenAI from "openai";

import { MAX_TOKENS } from "@/agent/providers/constants";
import type {
  FinalTurn,
  LLMProvider,
  NormalizedToolCall,
  NormalizedUsage,
  ProviderMessage,
  ProviderStream,
  ProviderStreamEvent,
  ProviderTranscript,
  ReasoningEffort,
  ToolResult,
  TurnRequest,
} from "@/agent/providers/types";
import type { ProviderKind } from "@/agent/models";
import type { ChatMessage } from "@/agent/types";

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface OpenAICompatibleProviderConfig {
  /** "openai" or "xai" — selects the tuned prompt style + labels the trace. */
  kind: ProviderKind;
  /** The concrete API model id (e.g. "gpt-5.5", "grok-4.3"). */
  apiModelId: string;
  /** API key for the upstream (already validated as present by the factory). */
  apiKey: string;
  /** Base URL override (xAI: https://api.x.ai/v1; OpenAI: SDK default). */
  baseURL?: string;
  /** Reasoning effort; mapped to `reasoning_effort`. Omit to use model default. */
  effort?: ReasoningEffort;
}

/** Minimal surface of the OpenAI client the provider uses (injectable for tests). */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(
        body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<ChatChunk>> | AsyncIterable<ChatChunk>;
    };
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly kind: ProviderKind;
  readonly apiModelId: string;
  private readonly effort?: ReasoningEffort;
  private readonly client: OpenAIClientLike;

  constructor(
    config: OpenAICompatibleProviderConfig,
    client?: OpenAIClientLike,
  ) {
    this.kind = config.kind;
    this.apiModelId = config.apiModelId;
    this.effort = config.effort;
    this.client =
      client ??
      new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  createTranscript(
    history: ChatMessage[],
    message: string,
  ): ProviderTranscript {
    // System text rides on the request, not the transcript.
    const messages: ChatMessageParam[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user" as const, content: message },
    ];
    return messages;
  }

  streamTurn(req: TurnRequest): ProviderStream {
    const systemText = req.system.map((seg) => seg.text).join("\n\n");
    const tools: ChatTool[] = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
        // NON-strict on purpose — see file header.
      },
    }));

    const messages: ChatMessageParam[] = [
      { role: "system", content: systemText },
      ...(req.transcript as ChatMessageParam[]),
    ];

    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: this.apiModelId,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_completion_tokens: MAX_TOKENS,
      stream: true,
      // Mandatory to receive a usage chunk while streaming.
      stream_options: { include_usage: true },
      ...(this.effort ? { reasoning_effort: this.effort } : {}),
    };

    const created = this.client.chat.completions.create(body, {
      signal: req.signal,
    });

    return adaptOpenAIStream(created);
  }

  buildUserMessage(text: string): ProviderMessage {
    return { role: "user", content: text } satisfies ChatMessageParam;
  }

  buildToolResultMessages(results: ToolResult[]): ProviderMessage[] {
    // OpenAI requires one {role:"tool"} message per tool_call_id in the
    // preceding assistant message before the next turn.
    return results.map(
      (r): OpenAI.Chat.Completions.ChatCompletionToolMessageParam => ({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.content,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Stream adaptation
// ---------------------------------------------------------------------------

interface AccumToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

/** Best-effort JSON parse; `undefined` on malformed args (loop re-emit handles). */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeUsage(usage: ChatChunk["usage"] | null): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Adapt the OpenAI streaming chunks into a provider-neutral
 * {@link ProviderStream}. Accumulates assistant text + tool-call fragments
 * during iteration; `final()` reads that accumulated state (the loop always
 * drains the stream before calling `final()`).
 */
function adaptOpenAIStream(
  created: Promise<AsyncIterable<ChatChunk>> | AsyncIterable<ChatChunk>,
): ProviderStream {
  const calls = new Map<number, AccumToolCall>();
  let text = "";
  let usage: ChatChunk["usage"] | null = null;

  async function* iterate(): AsyncGenerator<ProviderStreamEvent> {
    const stream = await created;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }

      // xAI surfaces reasoning summaries on `reasoning_content` (not typed).
      const reasoning = (delta as { reasoning_content?: unknown })
        .reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield { type: "thinking_delta", text: reasoning };
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index;
        let acc = calls.get(index);
        if (!acc) {
          acc = {
            index,
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            args: "",
          };
          calls.set(index, acc);
          // First fragment for this index carries id + name → start event.
          if (acc.id && acc.name) {
            yield {
              type: "tool_call_start",
              index,
              id: acc.id,
              name: acc.name,
            };
          }
        } else {
          // Late-arriving id/name (defensive; usually present on the first).
          if (!acc.id && tc.id) acc.id = tc.id;
          if (!acc.name && tc.function?.name) acc.name = tc.function.name;
        }
        const argChunk = tc.function?.arguments;
        if (typeof argChunk === "string" && argChunk.length > 0) {
          acc.args += argChunk;
          yield { type: "tool_call_args_delta", index, argChunk };
        }
      }
    }

    // No per-call stop event in Chat Completions — synthesize one per call once
    // the stream drains (the extractor self-terminates earlier; this just clears
    // the loop's submit-index bookkeeping).
    for (const index of calls.keys()) {
      yield { type: "tool_call_stop", index };
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    async final(): Promise<FinalTurn> {
      const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
      const toolCalls: NormalizedToolCall[] = ordered.map((c) => ({
        id: c.id,
        name: c.name,
        inputJson: c.args,
        input: safeJsonParse(c.args),
      }));

      const assistantContentToEcho: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =
        {
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(ordered.length > 0
            ? {
                tool_calls: ordered.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        };

      return {
        assistantContentToEcho,
        toolCalls,
        usage: normalizeUsage(usage),
      };
    },
  };
}
