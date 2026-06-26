/**
 * @vitest-environment jsdom
 *
 * FULL-STACK-E2E CHECKPOINT (frontend half) — drives the REAL `useSseClient`
 * hook with a SIMULATED SSE stream framed exactly like the route
 * (`formatSseEvent`, design.md § API Design): several `tool_activity` frames then
 * one terminal `answer` frame. Asserts the hook surfaces the progress labels in
 * order and then exposes the final `PokebotAnswer`.
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

import { useSseClient } from "@/lib/sse-client";
import { formatSseEvent } from "@/lib/sse-types";
import type { PokebotAnswer } from "@/components/types";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const ANSWERED: PokebotAnswer = {
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

const RESOLUTION_FAILED: PokebotAnswer = {
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

    // The terminal PokebotAnswer is exposed; no transport error.
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
