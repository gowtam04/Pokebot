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

import { useCallback, useEffect, useRef, useState } from "react";
import type { OakAnswer } from "@/agent/schemas";
import type {
  AnswerDeltaEvent,
  AnswerEvent,
  AnswerStartEvent,
  ChatRequestBody,
  ErrorEvent,
  SseEvent,
  SseEventName,
  ToolActivityEvent,
} from "@/lib/sse/sse-types";

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
   * The terminal `OakAnswer` for the current turn, or `null` while the
   * request is in-flight or when there is a transport error.
   *
   * Check `answer.status` for in-domain failure kinds
   * (`resolution_failed`, `clarification_needed`, `insufficient_data`).
   */
  answer: OakAnswer | null;
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
  /**
   * True only while an automatic reconnect is in progress after a
   * backgrounding-induced connection drop (phone screen turned off mid-turn).
   * The turn stays in-flight (`status === "thinking"`); the UI shows a
   * "Reconnecting…" affordance instead of a dead-end error. Cleared as soon as
   * the re-sent turn produces output again, or on a terminal answer/error.
   */
  reconnecting: boolean;
}

const INITIAL_STATE: SseClientState = {
  status: "idle",
  activities: [],
  answer: null,
  streamingMarkdown: "",
  error: null,
  reconnecting: false,
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
  /**
   * Re-send the most recent turn (same message + images). A no-op once a turn
   * has succeeded (the retained body is released on a terminal answer); used by
   * the manual "Retry" affordance shown on a surfaced transport error.
   */
  retry: () => void;
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
/**
 * Max automatic re-sends after a backgrounding-induced connection drop.
 *
 * Capped at 1 deliberately: there is a narrow server window where a turn can be
 * persisted just before the suspended client loses the answer frame, so an
 * unbounded auto-retry could double-persist / double-charge. One attempt heals
 * the dominant case (screen off during the long silent reasoning phase, which
 * aborts BEFORE persistence) while bounding that blast radius. A fully
 * idempotent fix would need a per-turn key the server dedupes on (server-side).
 */
const MAX_RETRIES = 1;

export function useSseClient(): UseSseClientReturn {
  const [state, setState] = useState<SseClientState>(INITIAL_STATE);

  // AbortController ref: lets `send` cancel the previous in-flight request
  // before starting a new one, preventing stale state updates.
  const abortRef = useRef<AbortController | null>(null);

  // ── Screen-off recovery bookkeeping (all refs so the long-lived
  // visibilitychange listener never reads stale values) ─────────────────────
  // The body of the most recent turn, retained so we can re-send it (auto on
  // resume, or via the manual Retry button). Released on a terminal answer.
  const lastBodyRef = useRef<ChatRequestBody | null>(null);
  // Set true when the page is hidden (screen locked) DURING the current
  // attempt. Gates auto-retry so only a real suspension — not any error —
  // triggers a re-send. Reset at the start of every attempt.
  const hiddenDuringTurnRef = useRef(false);
  // Auto-retries already spent on the current turn (bounded by MAX_RETRIES).
  const retryCountRef = useRef(0);
  // A recoverable failure happened while still hidden; fire the retry once the
  // page returns to the foreground (we can't re-fetch/acquire a wake lock while
  // suspended).
  const pendingRetryRef = useRef(false);
  // Indirection so the stable `runRequest` and the mounted-once visibility
  // listener always call the latest `fireRetry` without a dependency cycle.
  const fireRetryRef = useRef<() => void>(() => {});

  // One request attempt: fetch → consume the SSE stream → drive state. Stable
  // (no deps — reads only refs + the stable `setState`), so the retry path and
  // the visibility listener can call it with zero stale-closure risk. Each call
  // owns its `controller`, so the `signal.aborted` guards are correctly scoped
  // to that attempt. Connection-drop failures route to a shared retry path;
  // clean server faults (HTTP errors, in-band `error` frames) surface as before.
  const runRequest = useCallback(
    async (
      body: ChatRequestBody,
      controller: AbortController,
    ): Promise<void> => {
      // Only a FRESH hide during THIS attempt should arm a retry (prevents
      // looping on a genuine, visible failure).
      hiddenDuringTurnRef.current = false;

      // Decide whether a connection-drop failure should be auto-recovered.
      // Returns true if it took ownership (retry fired or armed); false means
      // the caller should surface the error as a normal transport fault.
      const handleRecoverableFailure = (): boolean => {
        if (
          !hiddenDuringTurnRef.current ||
          retryCountRef.current >= MAX_RETRIES
        ) {
          return false;
        }
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "visible"
        ) {
          // Already back in the foreground — re-send immediately.
          fireRetryRef.current();
        } else {
          // Still suspended — show "Reconnecting…" and fire on resume.
          pendingRetryRef.current = true;
          setState((prev) => ({
            ...prev,
            status: "thinking",
            reconnecting: true,
            activities: [],
            streamingMarkdown: "",
            error: null,
          }));
        }
        return true;
      };

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
        // An AbortError is expected when `send`/`reset` fires — ignore it.
        if (controller.signal.aborted) return;
        // A pre-stream fetch throw is a connection drop — recover if backgrounded.
        if (handleRecoverableFailure()) return;
        setState((prev) => ({
          ...prev,
          status: "error",
          reconnecting: false,
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
      // A clean server response — NEVER auto-retried (several of these, e.g.
      // model_unavailable, drive the host's model auto-revert on `status:error`).
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
        setState((prev) => ({
          ...prev,
          status: "error",
          reconnecting: false,
          error: errorEvent,
        }));
        return;
      }

      // ── Step 3: consume the SSE stream ─────────────────────────────────────
      let sawTerminal = false; // an `answer` or `error` frame landed
      try {
        for await (const event of readSseStream(
          response.body,
          controller.signal,
        )) {
          // Abort may fire mid-iteration; check before each state update.
          if (controller.signal.aborted) return;

          if (event.event === "tool_activity") {
            // Output resumed → clear any "Reconnecting…" state. Accumulate the
            // progress event for the progress UI.
            setState((prev) => ({
              ...prev,
              reconnecting: false,
              activities: [...prev.activities, event.data],
            }));
          } else if (event.event === "answer_start") {
            // A fresh submit_answer began streaming — reset the in-flight buffer
            // (drops a prior attempt that failed validation and is re-emitting).
            setState((prev) => ({
              ...prev,
              reconnecting: false,
              streamingMarkdown: "",
            }));
          } else if (event.event === "answer_delta") {
            // Append the newly-decoded answer_markdown fragment.
            setState((prev) => ({
              ...prev,
              reconnecting: false,
              streamingMarkdown: prev.streamingMarkdown + event.data.text,
            }));
          } else if (event.event === "answer") {
            // Terminal success (any answer.status — in-domain failures ride here).
            // Release the retained body (turn succeeded → no retry needed) and
            // clear the streaming buffer so the committed AnswerCard is the
            // single source of truth (no double render of the prose).
            sawTerminal = true;
            lastBodyRef.current = null;
            retryCountRef.current = 0;
            pendingRetryRef.current = false;
            setState((prev) => ({
              ...prev,
              status: "done",
              reconnecting: false,
              answer: event.data.answer,
              streamingMarkdown: "",
            }));
          } else if (event.event === "error") {
            // In-band transport fault (integration.md § Error Surface): the
            // connection was healthy enough to deliver it, so it's a real
            // model/agent fault — surface it, never auto-retry.
            sawTerminal = true;
            setState((prev) => ({
              ...prev,
              status: "error",
              reconnecting: false,
              error: event.data,
            }));
          }
        }

        // The stream ended. A conformant server always emits a terminal event;
        // its absence means the connection closed (a dropped socket can return a
        // clean EOF instead of throwing). Recover if the screen went off,
        // otherwise fall back to `done` (defensive, pre-existing behavior).
        if (controller.signal.aborted) return;
        if (!sawTerminal) {
          if (handleRecoverableFailure()) return;
          setState((prev) =>
            prev.status === "thinking"
              ? { ...prev, status: "done", reconnecting: false }
              : prev,
          );
        }
      } catch (streamError) {
        if (controller.signal.aborted) return;
        // A mid-stream read throw is a connection drop — recover if backgrounded.
        if (handleRecoverableFailure()) return;
        setState((prev) => ({
          ...prev,
          status: "error",
          reconnecting: false,
          error: {
            code: "stream_error",
            message:
              streamError instanceof Error
                ? streamError.message
                : "Stream read failed",
          },
        }));
      }
    },
    [],
  );

  // Re-send the retained body as an automatic recovery attempt. Keeps the turn
  // in-flight (status stays "thinking") and shows the reconnecting state.
  const fireRetry = useCallback((): void => {
    const body = lastBodyRef.current;
    if (!body) return;
    pendingRetryRef.current = false;
    retryCountRef.current += 1;
    const controller = new AbortController();
    abortRef.current = controller;
    setState((prev) => ({
      ...prev,
      status: "thinking",
      reconnecting: true,
      activities: [],
      streamingMarkdown: "",
      error: null,
    }));
    void runRequest(body, controller);
  }, [runRequest]);

  // Keep the ref pointing at the current `fireRetry` (stable, so this runs once)
  // so `runRequest` and the visibility listener call the live implementation.
  useEffect(() => {
    fireRetryRef.current = fireRetry;
  }, [fireRetry]);

  // Single page-visibility listener (mounted once). On hide DURING a turn, arm
  // the screen-off gate; on return to the foreground, fire any deferred retry.
  // Handles the iOS resume race either way: if `visible` fires before the frozen
  // read rejects, the later failure sees `visible` and retries immediately;
  // if the read rejects first, it arms `pendingRetryRef` and this fires it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = (): void => {
      const inFlight =
        abortRef.current !== null && !abortRef.current.signal.aborted;
      if (document.visibilityState === "hidden") {
        if (inFlight) hiddenDuringTurnRef.current = true;
      } else if (document.visibilityState === "visible") {
        if (pendingRetryRef.current) fireRetryRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const send = useCallback(
    (body: ChatRequestBody): void => {
      // Cancel the previous request if still running.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // New turn → reset recovery bookkeeping (supersedes any pending retry).
      lastBodyRef.current = body;
      hiddenDuringTurnRef.current = false;
      retryCountRef.current = 0;
      pendingRetryRef.current = false;

      // Immediately transition to "thinking" and clear previous turn state.
      setState({
        status: "thinking",
        activities: [],
        answer: null,
        streamingMarkdown: "",
        error: null,
        reconnecting: false,
      });

      void runRequest(body, controller);
    },
    [runRequest],
  );

  const reset = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Cancel any pending/auto retry and drop the retained body.
    lastBodyRef.current = null;
    hiddenDuringTurnRef.current = false;
    retryCountRef.current = 0;
    pendingRetryRef.current = false;
    setState(INITIAL_STATE);
  }, []);

  // Manual re-send of the last turn (the Retry affordance on a surfaced error).
  const retry = useCallback((): void => {
    if (lastBodyRef.current) send(lastBodyRef.current);
  }, [send]);

  return { ...state, send, reset, retry };
}
