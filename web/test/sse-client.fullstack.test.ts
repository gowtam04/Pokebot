/**
 * @vitest-environment jsdom
 *
 * FULL-STACK-E2E CHECKPOINT (frontend half) — drives the REAL `useSseClient`
 * hook with a SIMULATED SSE stream framed exactly like the route
 * (`formatSseEvent`, design.md § API Design): several `tool_activity` frames then
 * one terminal `answer` frame. Asserts the hook surfaces the progress labels in
 * order and then exposes the final `OakAnswer`.
 *
 * Mirrors the backend checkpoint (test/api-chat.integration.test.ts) from the
 * client side: there the route emits frames; here the hook parses them. `fetch`
 * is stubbed to return a `Response` whose body is a `ReadableStream` of those
 * frames — no server/db/runtime is imported (those open a Postgres connection
 * which fails under jsdom). The file runs under jsdom (via the docblock above) so
 * the hook's React state can be observed with `renderHook`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import { useSseClient } from "@/lib/sse/sse-client";
import { formatSseEvent } from "@/lib/sse/sse-types";
import type { OakAnswer } from "@/components/types";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const ANSWERED: OakAnswer = {
  status: "answered",
  answer_markdown:
    "Only **Ninetales** can learn both Trick Room and Will-O-Wisp in Gen 9.",
  reasoning_markdown: "Intersection of the two Gen-9 learnsets → Ninetales.",
  citations: [
    {
      source: "learnset/will-o-wisp (gen-9)",
      detail: "learned_by includes ninetales",
    },
  ],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
  candidates: {
    total_count: 1,
    truncated: false,
    sort: null,
    shown: [{ name: "Ninetales", dex_number: 38, types: ["fire"] }],
  },
};

const RESOLUTION_FAILED: OakAnswer = {
  status: "resolution_failed",
  answer_markdown: "I couldn't find 'Garchoph'. Did you mean Garchomp?",
  reasoning_markdown: "Fuzzy match failed above threshold.",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
  suggestions: ["Garchomp"],
};

/** Build a `Response` whose body streams the given pre-framed SSE strings. */
function sseResponse(frames: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

/** Build a `Response` whose body streams `frames` then ERRORS the stream (a
 * dropped connection — the read rejects). Models a screen-off mid-turn drop. */
function erroringResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.error(new Error("network gone"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Like `erroringResponse`, but the drop is triggered on demand via `fail()` —
 * lets a test interleave visibility events around the exact moment of failure. */
function deferredErrorResponse(frames: string[]): {
  response: Response;
  fail: () => void;
} {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  return { response, fail: () => ctrl.error(new Error("network gone")) };
}

/** A non-OK HTTP response with a JSON `{ code, message }` body (e.g. 503). */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global.fetch to return `response` (and capture the request body). */
function stubFetch(response: Response): { calls: unknown[] } {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init?.body);
      return response;
    }),
  );
  return { calls };
}

/** Stub global.fetch to return one fresh `Response` per call from `factories`
 * (a `ReadableStream` body is single-use, so a retry needs a new one). A factory
 * may THROW to model a pre-stream fetch failure (`network_error`). The last
 * factory is reused if more calls arrive than provided. */
function stubFetchSequence(factories: Array<() => Response>): {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init?.body);
      const factory = factories[Math.min(i, factories.length - 1)]!;
      i += 1;
      return factory();
    }),
  );
  return { calls };
}

// Page-visibility control: `document.hidden` / `visibilityState` are prototype
// getters in jsdom, so shadow them with configurable own-props we can drive.
let docHidden = false;
function installVisibilityControl(): void {
  docHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => docHidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (docHidden ? "hidden" : "visible"),
  });
}
function restoreVisibilityControl(): void {
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
  docHidden = false;
}
/** Flip visibility and fire the `visibilitychange` event the hook listens for. */
function setHidden(hidden: boolean): void {
  docHidden = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

const TURN = { session_id: "s-bg", message: "what is this image" };
const ANSWER_FRAME = formatSseEvent("answer", { answer: ANSWERED });
const TOOL_FRAME = formatSseEvent("tool_activity", {
  tool: "resolve_entity",
  label: "🔍 Resolving…",
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSseClient — full-stack SSE consumption", () => {
  it("surfaces tool_activity progress labels in order, then the final answer", async () => {
    const frames = [
      formatSseEvent("tool_activity", {
        tool: "resolve_entity",
        label: "🔍 Resolving entities…",
      }),
      formatSseEvent("tool_activity", {
        tool: "query_pokedex",
        label: "📊 Querying the Pokédex…",
      }),
      formatSseEvent("answer", { answer: ANSWERED }),
    ];
    const captured = stubFetch(sseResponse(frames));

    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send({
        session_id: "s-1",
        message: "trick room + will-o-wisp",
      });
    });

    // Reaches the terminal answer.
    await waitFor(() => expect(result.current.status).toBe("done"));

    // Progress labels were surfaced in the order they were streamed.
    expect(result.current.activities.map((a) => a.label)).toEqual([
      "🔍 Resolving entities…",
      "📊 Querying the Pokédex…",
    ]);
    expect(result.current.activities.map((a) => a.tool)).toEqual([
      "resolve_entity",
      "query_pokedex",
    ]);

    // The terminal OakAnswer is exposed; no transport error.
    expect(result.current.answer).toEqual(ANSWERED);
    expect(result.current.answer?.candidates?.total_count).toBe(1);
    expect(result.current.error).toBeNull();

    // The request POSTed the session id + message body.
    expect(captured.calls).toHaveLength(1);
    expect(JSON.parse(captured.calls[0] as string)).toEqual({
      session_id: "s-1",
      message: "trick room + will-o-wisp",
    });
  });

  it("accumulates answer_delta text into streamingMarkdown while in-flight", async () => {
    // No terminal `answer` frame → the streamed buffer is retained (not cleared),
    // which lets us observe the accumulation deterministically.
    stubFetch(
      sseResponse([
        formatSseEvent("answer_start", {}),
        formatSseEvent("answer_delta", { text: "Only " }),
        formatSseEvent("answer_delta", { text: "**Ninetales**" }),
      ]),
    );

    const { result } = renderHook(() => useSseClient());
    act(() => {
      result.current.send({ session_id: "s-stream", message: "..." });
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.streamingMarkdown).toBe("Only **Ninetales**");
    expect(result.current.answer).toBeNull();
  });

  it("clears streamingMarkdown when the terminal answer lands", async () => {
    stubFetch(
      sseResponse([
        formatSseEvent("answer_start", {}),
        formatSseEvent("answer_delta", { text: "Only Ninetales" }),
        formatSseEvent("answer", { answer: ANSWERED }),
      ]),
    );

    const { result } = renderHook(() => useSseClient());
    act(() => {
      result.current.send({ session_id: "s-stream2", message: "..." });
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    // The committed AnswerCard is authoritative; the in-flight buffer is cleared.
    expect(result.current.streamingMarkdown).toBe("");
  });

  it("surfaces an in-domain failure (resolution_failed) as a normal answer, not an error", async () => {
    stubFetch(
      sseResponse([formatSseEvent("answer", { answer: RESOLUTION_FAILED })]),
    );

    const { result } = renderHook(() => useSseClient());
    act(() => {
      result.current.send({ session_id: "s-2", message: "Garchoph?" });
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.error).toBeNull();
    expect(result.current.answer?.status).toBe("resolution_failed");
    expect(result.current.answer?.suggestions).toEqual(["Garchomp"]);
  });

  it("routes a transport `error` frame to the error state (never as an answer)", async () => {
    stubFetch(
      sseResponse([
        formatSseEvent("tool_activity", {
          tool: "resolve_entity",
          label: "🔍 Resolving…",
        }),
        formatSseEvent("error", {
          code: "agent_error",
          message: "Anthropic 529 overloaded",
        }),
      ]),
    );

    const { result } = renderHook(() => useSseClient());
    act(() => {
      result.current.send({ session_id: "s-3", message: "boom" });
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.answer).toBeNull();
    expect(result.current.error).toEqual({
      code: "agent_error",
      message: "Anthropic 529 overloaded",
    });
  });
});

// ---------------------------------------------------------------------------
// Screen-off recovery: the phone screen turns off mid-turn, the page suspends,
// the connection drops. The hook should auto-retry once on resume (and only for
// connection drops while backgrounded), keeping the turn in-flight rather than
// surfacing a dead-end error.
// ---------------------------------------------------------------------------

describe("useSseClient — screen-off recovery", () => {
  beforeEach(() => installVisibilityControl());
  afterEach(() => restoreVisibilityControl());

  it("auto-retries once on resume after a backgrounded mid-stream drop", async () => {
    const { calls } = stubFetchSequence([
      () => erroringResponse([TOOL_FRAME]), // 1st attempt drops mid-stream
      () => sseResponse([ANSWER_FRAME]), // retry succeeds
    ]);
    const { result } = renderHook(() => useSseClient());

    // Send, then the screen turns off (same tick) → the in-flight drop is armed.
    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });

    // The drop is detected while hidden → deferred, "Reconnecting…" shown.
    await waitFor(() => expect(result.current.reconnecting).toBe(true));
    expect(result.current.status).toBe("thinking");
    expect(result.current.error).toBeNull();

    // Screen comes back on → the deferred retry fires.
    act(() => setHidden(false));

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.error).toBeNull();

    // Exactly two POSTs, identical bodies (same message + images re-sent).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
  });

  it("recovers when resume arrives BEFORE the read rejects (iOS event-order race)", async () => {
    const first = deferredErrorResponse([TOOL_FRAME]);
    const { calls } = stubFetchSequence([
      () => first.response,
      () => sseResponse([ANSWER_FRAME]),
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    // First tool frame consumed; the read is now pending.
    await waitFor(() => expect(result.current.activities).toHaveLength(1));

    // Resume FIRST (no failure yet → nothing to fire), THEN the drop lands.
    act(() => setHidden(false));
    act(() => first.fail());

    // The failure sees we're already visible and retries immediately.
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    expect(calls).toHaveLength(2);
  });

  it("recovers a pre-stream fetch failure (network_error) while backgrounded", async () => {
    const { calls } = stubFetchSequence([
      () => {
        throw new Error("fetch failed");
      },
      () => sseResponse([ANSWER_FRAME]),
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    await waitFor(() => expect(result.current.reconnecting).toBe(true));
    act(() => setHidden(false));

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    expect(calls).toHaveLength(2);
  });

  it("recovers a clean EOF with no answer while backgrounded", async () => {
    const { calls } = stubFetchSequence([
      () => sseResponse([TOOL_FRAME]), // closes cleanly, NO terminal answer
      () => sseResponse([ANSWER_FRAME]),
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    await waitFor(() => expect(result.current.reconnecting).toBe(true));
    act(() => setHidden(false));

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    expect(calls).toHaveLength(2);
  });

  it("does NOT auto-retry a drop that happened while visible (no backgrounding)", async () => {
    const { calls } = stubFetchSequence([() => erroringResponse([TOOL_FRAME])]);
    const { result } = renderHook(() => useSseClient());

    // No setHidden — the page stays visible the whole time.
    act(() => result.current.send(TURN));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("stream_error");
    expect(calls).toHaveLength(1); // surfaced, not retried
  });

  it("does NOT auto-retry a clean HTTP error, even while backgrounded", async () => {
    const { calls } = stubFetchSequence([
      () =>
        jsonResponse(503, {
          code: "model_unavailable",
          message: "Grok is down",
        }),
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("model_unavailable");
    expect(calls).toHaveLength(1); // a clean response → never retried
  });

  it("does NOT auto-retry an in-band error frame, even while backgrounded", async () => {
    const { calls } = stubFetchSequence([
      () =>
        sseResponse([
          formatSseEvent("error", {
            code: "model_provider_error",
            message: "xAI 429",
          }),
        ]),
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("model_provider_error");
    expect(calls).toHaveLength(1);
  });

  it("retries at most once (cap), then surfaces the error", async () => {
    const { calls } = stubFetchSequence([
      () => erroringResponse([]), // attempt 1 drops
      () => erroringResponse([]), // retry also drops
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    await waitFor(() => expect(result.current.reconnecting).toBe(true));
    act(() => setHidden(false)); // fires the single retry, which also drops

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("stream_error");
    expect(calls).toHaveLength(2); // original + exactly one retry
  });

  it("a new send supersedes a pending retry (no stale re-send)", async () => {
    const bodyB = { session_id: "s-bg", message: "different question" };
    const { calls } = stubFetchSequence([
      () => erroringResponse([]), // A drops while hidden → arms a pending retry
      () => sseResponse([ANSWER_FRAME]), // B succeeds
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    await waitFor(() => expect(result.current.reconnecting).toBe(true));

    // A new turn arrives before resume — it must cancel A's pending retry.
    act(() => result.current.send(bodyB));
    await waitFor(() => expect(result.current.status).toBe("done"));

    // Resuming now must NOT fire a stale retry of A.
    act(() => setHidden(false));

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1] as string).message).toBe("different question");
  });

  it("reset() cancels a pending retry", async () => {
    const { calls } = stubFetchSequence([() => erroringResponse([])]);
    const { result } = renderHook(() => useSseClient());

    act(() => {
      result.current.send(TURN);
      setHidden(true);
    });
    await waitFor(() => expect(result.current.reconnecting).toBe(true));

    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");

    act(() => setHidden(false)); // would fire a pending retry — but it's cleared
    expect(calls).toHaveLength(1);
  });

  it("retry() manually re-sends after a surfaced (visible) error", async () => {
    const { calls } = stubFetchSequence([
      () => erroringResponse([]), // visible drop → surfaces
      () => sseResponse([ANSWER_FRAME]), // manual retry succeeds
    ]);
    const { result } = renderHook(() => useSseClient());

    act(() => result.current.send(TURN));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(calls).toHaveLength(1);

    // The body was retained on error → manual Retry reuses it.
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.answer).toEqual(ANSWERED);
    expect(calls).toHaveLength(2);
  });
});
