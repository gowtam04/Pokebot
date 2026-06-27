/**
 * SSE client hook — the frontend counterpart of `POST /api/chat`.
 *
 * Sends a chat request via `fetch POST`, then reads the response body as an
 * SSE stream using a **manual TextDecoder + ReadableStream reader** (NOT
 * EventSource — per the risk directive). Frames are split on `\n\n`.
 *
 * Wire format emitted by the route (design.md § API Design):
 *   event: tool_activity   data: { tool, label }     (zero or more; progress)
 *   event: answer_start    data: {}                  (zero or more; buffer reset)
 *   event: answer_delta    data: { text }            (zero or more; prose chunk)
 *   event: answer          data: { answer }           (exactly one; terminal)
 *   event: error           data: { code, message }    (transport faults only)
 *
 * IMPORTANT: every in-domain failure (resolution_failed, clarification_needed,
 * insufficient_data) arrives as a normal `answer` event — it is NEVER surfaced
 * as an `error` event. Check `answer.status` to distinguish success from an
 * in-domain failure.
 *
 * Exports for unit tests:
 *   parseFrame(frame)    — pure frame → SseEvent parser
 *   readSseStream(body)  — async generator over a ReadableStream<Uint8Array>
 *
 * React hook:
 *   useSseClient()       — manages fetch + stream lifecycle + React state
 */
"use client";

import { useCallback, useRef, useState } from "react";
import type { PokebotAnswer } from "@/agent/schemas";
import type {
  AnswerDeltaEvent,
  AnswerEvent,
  AnswerStartEvent,
  ChatRequestBody,
  ErrorEvent,
  SseEvent,
  SseEventName,
  ToolActivityEvent,
} from "@/lib/sse-types";

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Parse one SSE frame (the text segment between two `\n\n` separators) into a
 * typed `SseEvent`.
 *
 * Returns `null` for:
 *   - frames that have no `event:` field (comment-only / heartbeat / unknown),
 *   - frames that have no `data:` field,
 *   - frames whose `data:` is not valid JSON,
 *   - frames whose event name is not one the endpoint emits.
 *
 * The route always sends a single `event:` line and a single `data:` line per
 * frame (via `formatSseEvent`), so multi-line `data:` concatenation is not
 * required.
 */
export function parseFrame(frame: string): SseEvent | null {
  let eventName: string | null = null;
  let dataLine: string | null = null;

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // Take the first data line found (server always sends exactly one).
      if (dataLine === null) {
        dataLine = line.slice("data:".length).trim();
      }
    }
  }

  if (eventName === null || dataLine === null) return null;

  let data: unknown;
  try {
    data = JSON.parse(dataLine);
  } catch {
    return null;
  }

  // Only the event names this endpoint emits are accepted.
  switch (eventName as SseEventName) {
    case "tool_activity":
      return { event: "tool_activity", data: data as ToolActivityEvent };
    case "answer_start":
      return { event: "answer_start", data: data as AnswerStartEvent };
    case "answer_delta":
      return { event: "answer_delta", data: data as AnswerDeltaEvent };
    case "answer":
      return { event: "answer", data: data as AnswerEvent };
    case "error":
      return { event: "error", data: data as ErrorEvent };
    default:
      return null;
  }
}

/**
 * Async generator that reads a `ReadableStream<Uint8Array>` and yields parsed
 * `SseEvent` objects one at a time, splitting the byte stream on `\n\n`.
 *
 * This is the pure stream-processing layer. The React hook (`useSseClient`)
 * wraps it with state management. Exporting it separately makes it unit-
 * testable in the Node environment without React.
 *
 * @param body    The response body from a `fetch` call to `POST /api/chat`.
 * @param signal  Optional AbortSignal; iteration stops when aborted.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on the SSE frame separator. The last element after the split may
      // be an incomplete frame — keep it in the buffer until more bytes arrive.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const trimmed = frame.trim();
        if (!trimmed) continue;
        const parsed = parseFrame(trimmed);
        if (parsed !== null) yield parsed;
      }
    }

    // Flush any trailing data (server closed without a trailing \n\n — rare
    // but possible on connection drops mid-stream).
    const trailing = buffer.trim();
    if (trailing) {
      const parsed = parseFrame(trailing);
      if (parsed !== null) yield parsed;
    }
  } finally {
    // Always release the lock so the stream can be consumed again if needed.
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// React hook state types
// ---------------------------------------------------------------------------

/** Lifecycle status of the current (or most recent) SSE request. */
export type SseClientStatus = "idle" | "thinking" | "done" | "error";

export interface SseClientState {
  /** Lifecycle status of the current turn. */
  status: SseClientStatus;
  /**
   * Tool-activity progress events accumulated for the current turn (cleared on
   * each `send` call). Used by the progress UI while the agent loop runs.
   */
  activities: ToolActivityEvent[];
  /**
   * The terminal `PokebotAnswer` for the current turn, or `null` while the
   * request is in-flight or when there is a transport error.
   *
   * Check `answer.status` for in-domain failure kinds
   * (`resolution_failed`, `clarification_needed`, `insufficient_data`).
   */
  answer: PokebotAnswer | null;
  /**
   * Answer prose accumulated from `answer_delta` events for the in-flight turn.
   * Reset to "" on each `send` and on `answer_start` (a re-emitted answer), and
   * cleared when the terminal `answer` lands (the committed AnswerCard becomes
   * the single source of truth). Render this for token-by-token streaming.
   */
  streamingMarkdown: string;
  /**
   * Transport-level error (null unless `status === "error"`).
   * In-domain failures arrive in `answer`, not here.
   */
  error: ErrorEvent | null;
}

const INITIAL_STATE: SseClientState = {
  status: "idle",
  activities: [],
  answer: null,
  streamingMarkdown: "",
  error: null,
};

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseSseClientReturn extends SseClientState {
  /**
   * Send a new question to `POST /api/chat`. Any in-flight request is aborted
   * first so only one stream is ever open at a time.
   *
   * Suggestion-chip and candidate-row follow-ups are plain `send` calls with the
   * same `session_id` — there is no special protocol (ux-design.md).
   */
  send: (body: ChatRequestBody) => void;
  /** Reset to `idle` state, discarding the current answer, activities, and error. */
  reset: () => void;
}

/**
 * useSseClient
 *
 * Client hook for `POST /api/chat`. Orchestrates fetch → manual SSE stream
 * parsing → React state updates.
 *
 * Usage:
 * ```tsx
 * const { status, activities, answer, error, send, reset } = useSseClient();
 *
 * // Send a question:
 * send({ session_id: "abc", message: "Which Fire-types learn Will-O-Wisp?" });
 *
 * // While status === "thinking", render activities[] as progress items.
 * // When status === "done", render <AnswerCard answer={answer} />.
 * // When status === "error", show a retry affordance.
 * ```
 */
export function useSseClient(): UseSseClientReturn {
  const [state, setState] = useState<SseClientState>(INITIAL_STATE);

  // AbortController ref: lets `send` cancel the previous in-flight request
  // before starting a new one, preventing stale state updates.
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback((body: ChatRequestBody): void => {
    // Cancel the previous request if still running.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Immediately transition to "thinking" and clear previous turn state.
    setState({
      status: "thinking",
      activities: [],
      answer: null,
      streamingMarkdown: "",
      error: null,
    });

    // Run the async stream consumer in a detached promise. We use `void` to
    // signal intentional fire-and-forget (the hook owns the lifecycle via
    // `controller`). State updates happen via `setState` from inside.
    void (async (): Promise<void> => {
      // ── Step 1: open the connection ────────────────────────────────────────
      let response: Response;
      try {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (fetchError) {
        // An AbortError is expected when `send` is called again — ignore it.
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          status: "error",
          error: {
            code: "network_error",
            message:
              fetchError instanceof Error
                ? fetchError.message
                : "Network request failed",
          },
        }));
        return;
      }

      // ── Step 2: check HTTP-level errors (e.g. 413 / 429 / 503 pre-stream) ──
      if (!response.ok || !response.body) {
        // Prefer the server's JSON `{ code, message }` (e.g. 503
        // model_unavailable) so the UI shows a meaningful, actionable error and
        // can react to the code (e.g. auto-revert the model). Fall back to the
        // raw HTTP status for a non-JSON body.
        let errorEvent = {
          code: `http_${response.status}`,
          message: `HTTP ${response.status} ${response.statusText}`,
        } as { code: string; message: string; status?: number };
        try {
          const data = (await response.json()) as {
            code?: unknown;
            message?: unknown;
          };
          if (
            typeof data?.code === "string" &&
            typeof data?.message === "string"
          ) {
            errorEvent = {
              code: data.code,
              message: data.message,
              status: response.status,
            };
          }
        } catch {
          /* non-JSON body — keep the http_<status> fallback */
        }
        setState((prev) => ({ ...prev, status: "error", error: errorEvent }));
        return;
      }

      // ── Step 3: consume the SSE stream ─────────────────────────────────────
      try {
        for await (const event of readSseStream(
          response.body,
          controller.signal,
        )) {
          // Abort may fire mid-iteration; check before each state update.
          if (controller.signal.aborted) return;

          if (event.event === "tool_activity") {
            // Accumulate progress events for the progress UI.
            setState((prev) => ({
              ...prev,
              activities: [...prev.activities, event.data],
            }));
          } else if (event.event === "answer_start") {
            // A fresh submit_answer began streaming — reset the in-flight buffer
            // (drops a prior attempt that failed validation and is re-emitting).
            setState((prev) => ({ ...prev, streamingMarkdown: "" }));
          } else if (event.event === "answer_delta") {
            // Append the newly-decoded answer_markdown fragment.
            setState((prev) => ({
              ...prev,
              streamingMarkdown: prev.streamingMarkdown + event.data.text,
            }));
          } else if (event.event === "answer") {
            // Terminal success (any answer.status — in-domain failures ride here).
            // Clear the streaming buffer so the committed AnswerCard is the single
            // source of truth (no double render of the prose).
            setState((prev) => ({
              ...prev,
              status: "done",
              answer: event.data.answer,
              streamingMarkdown: "",
            }));
          } else if (event.event === "error") {
            // Transport fault (integration.md § Error Surface, last two rows).
            setState((prev) => ({
              ...prev,
              status: "error",
              error: event.data,
            }));
          }
        }

        // Guard: if the stream ended without emitting an answer or error event
        // (should not happen with a conformant server, but be defensive).
        setState((prev) => {
          if (prev.status === "thinking") {
            return { ...prev, status: "done" };
          }
          return prev;
        });
      } catch (streamError) {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          status: "error",
          error: {
            code: "stream_error",
            message:
              streamError instanceof Error
                ? streamError.message
                : "Stream read failed",
          },
        }));
      }
    })();
  }, []);

  const reset = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  return { ...state, send, reset };
}
