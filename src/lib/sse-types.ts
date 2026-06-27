/**
 * SSE event protocol for `POST /api/chat` (design.md § API Design).
 *
 * The route emits, in order:
 *   event: tool_activity   data: { tool, label }     (zero or more)
 *   event: answer_start    data: {}                  (zero or more; resets the
 *                                                      client's in-flight buffer
 *                                                      when a fresh submit_answer
 *                                                      begins streaming)
 *   event: answer_delta    data: { text }            (zero or more; incremental
 *                                                      chunks of answer_markdown)
 *   event: answer          data: { answer }          (exactly one, terminal,
 *                                                      authoritative)
 *   event: error           data: { code, message }   (transport faults ONLY)
 *
 * IMPORTANT: every in-domain failure (unresolved entity, clarification, PokeAPI
 * down, index missing, loop-max, invalid-after-retry) is delivered as a NORMAL
 * `answer` event carrying a PokebotAnswer with the appropriate `status`
 * (resolution_failed / clarification_needed / insufficient_data) — NEVER as an
 * `error` event. The `error` event is reserved for model/API transport faults.
 *
 * `answer_start` / `answer_delta` stream the `answer_markdown` prose token-by-
 * token while the loop runs; the single terminal `answer` event always carries
 * the full validated PokebotAnswer and is authoritative (the client replaces any
 * streamed buffer with it).
 */

import type { PokebotAnswer } from "@/agent/schemas";

/** Request body for `POST /api/chat`. */
export interface ChatRequestBody {
  session_id: string;
  message: string;
  /**
   * Champions-mode toggle (server scopes the turn to Pokémon Champions when
   * true). Optional ⇒ old clients that omit it default to standard / Gen 9.
   */
  champions_mode?: boolean;
  /**
   * Which LLM answers this turn (a model registry key — "claude" | "gpt-5.5" |
   * "grok-4.3"). Wire type is `string`; the route whitelist-validates it to a
   * known key and falls back to the default. Optional ⇒ old clients default to
   * Claude.
   */
  model?: string;
}

/** `event: tool_activity` payload — progress shown while the loop runs. */
export interface ToolActivityEvent {
  tool: string;
  label: string;
}

/**
 * `event: answer_start` payload — a reset signal sent when a fresh submit_answer
 * block begins streaming. Empty object `{}`; the client clears its in-flight
 * markdown buffer (handles the validate-and-re-emit case).
 */
export type AnswerStartEvent = Record<string, never>;

/** `event: answer_delta` payload — one newly-decoded chunk of answer_markdown. */
export interface AnswerDeltaEvent {
  text: string;
}

/** `event: answer` payload — the one terminal answer for the turn. */
export interface AnswerEvent {
  answer: PokebotAnswer;
}

/** `event: error` payload — transport/API fault only (not in-domain failures). */
export interface ErrorEvent {
  code: string;
  message: string;
}

/** The SSE event names this endpoint emits. */
export type SseEventName =
  | "tool_activity"
  | "answer_start"
  | "answer_delta"
  | "answer"
  | "error";

/** Maps each event name to its `data` payload type. */
export interface SseEventDataMap {
  tool_activity: ToolActivityEvent;
  answer_start: AnswerStartEvent;
  answer_delta: AnswerDeltaEvent;
  answer: AnswerEvent;
  error: ErrorEvent;
}

/** A fully-typed, discriminated SSE event (name + its matching data). */
export type SseEvent = {
  [K in SseEventName]: { event: K; data: SseEventDataMap[K] };
}[SseEventName];

/**
 * Serialize one SSE event into wire frame format:
 * `event: <name>\ndata: <single-line JSON>\n\n`.
 * Data is emitted as single-line JSON (no embedded newlines) per the directive.
 */
export function formatSseEvent<K extends SseEventName>(
  event: K,
  data: SseEventDataMap[K],
): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
