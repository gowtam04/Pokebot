/**
 * The `LLMProvider` adapter contract — the seam the agent tool-loop programs
 * against so it can run on Claude, OpenAI GPT-5.5, or xAI Grok 4.3 without the
 * loop knowing any provider's wire format.
 *
 * The loop owns everything provider-NEUTRAL (schema validation, the re-emit
 * budget, insufficient_data synthesis, the trace, the AnswerMarkdownExtractor,
 * abort handling). A provider owns ONLY the four Anthropic-vs-OpenAI-shaped
 * concerns: building the request, opening a streaming turn, yielding NORMALIZED
 * stream events, and shaping the transcript (the running message list + the
 * next-turn tool-result messages).
 *
 * The crucial abstraction: the running transcript is OPAQUE to the loop
 * ({@link ProviderTranscript} = `unknown[]`). The loop only ever PUSHES
 * provider-produced values into it — it never reads an element. That is what
 * lets one loop serve an Anthropic content-block transcript and an OpenAI
 * `{role,content,tool_calls}` + `{role:"tool"}` transcript with identical code.
 *
 * NO SDK imports here — this is a pure type contract (only type-only imports of
 * the project's own ChatMessage + JsonSchema), so both provider adapters and the
 * prompts layer can depend on it freely.
 */

import type { ProviderKind } from "@/agent/models";
import type { JsonSchema } from "@/agent/schemas";
import type { ChatMessage } from "@/agent/types";

/**
 * Reasoning knob, normalized across providers. Anthropic uses adaptive thinking
 * and ignores this; OpenAI/xAI map it onto `reasoning_effort` (xAI tops out at
 * "high" — no "xhigh").
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/**
 * One ordered segment of the system prompt. The LAST segment flagged
 * `cacheBreakpoint` is the Anthropic ephemeral cache breakpoint; OpenAI/xAI
 * ignore the flag (their prompt caching is automatic on a stable prefix).
 */
export interface SystemSegment {
  text: string;
  cacheBreakpoint?: boolean;
}

/**
 * Provider-neutral tool definition. `parameters` is the inlined JSON Schema the
 * tool layer already produces (`ToolDef.inputSchema` via schemas.ts
 * `toJsonSchema`) — the same shape both Anthropic and OpenAI consume.
 */
export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * One opaque, provider-owned transcript element. The loop treats these as
 * unknown and never constructs or inspects one — it only pushes values the
 * provider produced (`assistantContentToEcho`, `buildToolResultMessages`).
 */
export type ProviderMessage = unknown;
export type ProviderTranscript = ProviderMessage[];

/**
 * Normalized streaming events the loop consumes. Only the `tool_call_*` events
 * drive UX today (the submit_answer arg-JSON feeds the AnswerMarkdownExtractor);
 * `text_delta`/`thinking_delta` are accepted but currently ignored by the loop.
 */
export type ProviderStreamEvent =
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args_delta"; index: number; argChunk: string }
  | { type: "tool_call_stop"; index: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string };

/** A tool call the model emitted this turn, normalized across providers. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as streamed. */
  inputJson: string;
  /** Best-effort parsed arguments; `undefined` if the JSON was invalid. */
  input: unknown;
}

/** Token usage for one turn, normalized across providers. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/** What one streamed turn yields once the stream drains. */
export interface FinalTurn {
  /**
   * Ready-to-push assistant transcript element (Anthropic: the full content
   * blocks, preserving thinking + tool_use; OpenAI: the assistant message with
   * tool_calls). Pushed OPAQUELY by the loop — never inspected.
   */
  assistantContentToEcho: ProviderMessage;
  toolCalls: NormalizedToolCall[];
  usage: NormalizedUsage;
}

/** One tool result the loop produced (provider-neutral). */
export interface ToolResult {
  toolCallId: string;
  /** `JSON.stringify(result)` | "Answer accepted." | the validation-error text. */
  content: string;
  isError: boolean;
}

/** A live streaming turn: async-iterable over events + `final()` to drain it. */
export interface ProviderStream extends AsyncIterable<ProviderStreamEvent> {
  /** Resolves after the stream drains; assembles the {@link FinalTurn}. */
  final(): Promise<FinalTurn>;
}

/** The per-turn request the loop hands the provider. */
export interface TurnRequest {
  system: SystemSegment[];
  tools: ProviderToolDef[];
  /** The provider-owned running transcript (history + prior turns). */
  transcript: ProviderTranscript;
  signal?: AbortSignal;
}

/**
 * The transport adapter for one model. Implementations: `AnthropicProvider`
 * (Claude) and `OpenAICompatibleProvider` (GPT-5.5 + Grok 4.3).
 */
export interface LLMProvider {
  /** Which upstream API this provider speaks (selects the tuned prompt style). */
  readonly kind: ProviderKind;
  /** The concrete API model id, surfaced in the per-turn trace. */
  readonly apiModelId: string;

  /** Build the initial transcript: prior in-session history, then the message. */
  createTranscript(
    history: ChatMessage[],
    message: string,
  ): ProviderTranscript;

  /** Open one streaming turn against the request signal. */
  streamTurn(req: TurnRequest): ProviderStream;

  /**
   * Build a plain user message to append to the running transcript — e.g. a
   * corrective nudge after the model ended a turn without calling submit_answer.
   * The loop pushes this OPAQUELY, so each provider returns its own user-message
   * shape (Anthropic + OpenAI: `{role:"user", content:text}`).
   */
  buildUserMessage(text: string): ProviderMessage;

  /**
   * Map this turn's tool results into transcript element(s):
   *   Anthropic → ONE user message of tool_result blocks;
   *   OpenAI    → N `{role:"tool", tool_call_id, content}` messages.
   */
  buildToolResultMessages(results: ToolResult[]): ProviderMessage[];
}
