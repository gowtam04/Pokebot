/**
 * Unit tests for src/lib/sse/sse-client.ts — parseFrame and readSseStream.
 *
 * These tests run in the Vitest **node** project (src/**\/\*.test.ts pattern).
 * They cover the two pure / non-React exports:
 *   - parseFrame:     synchronous SSE frame parser
 *   - readSseStream:  async generator over a ReadableStream<Uint8Array>
 *
 * The React hook (useSseClient) wraps these two; its state-management behaviour
 * is validated by the component integration tests in Phase 7 (chat shell +
 * AnswerCard). We do not test it here because it requires jsdom + renderHook
 * which is outside the node project's scope.
 *
 * Node 20 ships `ReadableStream`, `TextEncoder`, and `TextDecoder` as globals
 * (no import needed) — the test helpers below rely on that.
 */

import { describe, expect, it } from "vitest";
import { parseFrame, readSseStream } from "@/lib/sse/sse-client";
import type { SseEvent } from "@/lib/sse/sse-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> from one or more string chunks. */
function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Drain the async generator into an array. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const ev of readSseStream(stream, signal)) {
    events.push(ev);
  }
  return events;
}

/** Canonical SSE frame format produced by formatSseEvent. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// parseFrame
// ---------------------------------------------------------------------------

describe("parseFrame", () => {
  it("parses a tool_activity frame", () => {
    const raw =
      'event: tool_activity\ndata: {"tool":"query_pokedex","label":"querying…"}';
    const result = parseFrame(raw);
    expect(result).toEqual({
      event: "tool_activity",
      data: { tool: "query_pokedex", label: "querying…" },
    });
  });

  it("parses an answer frame", () => {
    const answer = {
      status: "answered",
      answer_markdown: "Yes",
      reasoning_markdown: "Because",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    const raw = `event: answer\ndata: ${JSON.stringify({ answer })}`;
    const result = parseFrame(raw);
    expect(result).toEqual({ event: "answer", data: { answer } });
  });

  it("parses an error frame", () => {
    const raw = `event: error\ndata: ${JSON.stringify({ code: "agent_error", message: "boom" })}`;
    const result = parseFrame(raw);
    expect(result).toEqual({
      event: "error",
      data: { code: "agent_error", message: "boom" },
    });
  });

  it("parses an answer_start frame (empty payload)", () => {
    const raw = "event: answer_start\ndata: {}";
    expect(parseFrame(raw)).toEqual({ event: "answer_start", data: {} });
  });

  it("parses an answer_delta frame", () => {
    const raw = `event: answer_delta\ndata: ${JSON.stringify({ text: "Hello " })}`;
    expect(parseFrame(raw)).toEqual({
      event: "answer_delta",
      data: { text: "Hello " },
    });
  });

  it("handles extra whitespace around event name and data value", () => {
    const raw = 'event:  tool_activity \ndata:  {"tool":"x","label":"y"} ';
    const result = parseFrame(raw);
    expect(result).toEqual({
      event: "tool_activity",
      data: { tool: "x", label: "y" },
    });
  });

  it("returns null when there is no event: field", () => {
    const raw = `data: ${JSON.stringify({ tool: "x", label: "y" })}`;
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null when there is no data: field", () => {
    const raw = "event: tool_activity";
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null for invalid JSON in data", () => {
    const raw = "event: answer\ndata: {not-valid-json}";
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null for an unrecognised event name", () => {
    const raw = `event: heartbeat\ndata: ${JSON.stringify({})}`;
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null for an empty frame", () => {
    expect(parseFrame("")).toBeNull();
    expect(parseFrame("   ")).toBeNull();
  });

  it("uses the first data: line when multiple are present (single-line server)", () => {
    // The server always emits exactly one data line; we just want no crash and
    // parse the first one.
    const payload = JSON.stringify({ tool: "get_pokemon", label: "fetching…" });
    const raw = `event: tool_activity\ndata: ${payload}\ndata: EXTRA`;
    const result = parseFrame(raw);
    expect(result).not.toBeNull();
    expect((result as SseEvent).event).toBe("tool_activity");
  });
});

// ---------------------------------------------------------------------------
// readSseStream
// ---------------------------------------------------------------------------

describe("readSseStream", () => {
  it("yields a single tool_activity event from one chunk", async () => {
    const payload = { tool: "query_pokedex", label: "querying…" };
    const stream = makeStream(frame("tool_activity", payload));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "tool_activity", data: payload });
  });

  it("yields a single answer event", async () => {
    const answer = {
      status: "answered",
      answer_markdown: "42",
      reasoning_markdown: "deep thought",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    const stream = makeStream(frame("answer", { answer }));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "answer", data: { answer } });
  });

  it("yields an error event", async () => {
    const errPayload = { code: "agent_error", message: "timeout" };
    const stream = makeStream(frame("error", errPayload));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "error", data: errPayload });
  });

  it("yields multiple events in order — tool_activity* then answer", async () => {
    const act1 = { tool: "resolve_entity", label: "resolving…" };
    const act2 = { tool: "query_pokedex", label: "querying…" };
    const answer = {
      status: "answered",
      answer_markdown: "Garchomp",
      reasoning_markdown: "highest speed",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    const stream = makeStream(
      frame("tool_activity", act1),
      frame("tool_activity", act2),
      frame("answer", { answer }),
    );
    const events = await collect(stream);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ event: "tool_activity", data: act1 });
    expect(events[1]).toEqual({ event: "tool_activity", data: act2 });
    expect(events[2]).toEqual({ event: "answer", data: { answer } });
  });

  it("handles all frames arriving in a single chunk", async () => {
    const act = { tool: "get_pokemon", label: "fetching…" };
    const answer = {
      status: "answered",
      answer_markdown: "done",
      reasoning_markdown: "reasoning",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    const singleChunk =
      frame("tool_activity", act) + frame("answer", { answer });
    const stream = makeStream(singleChunk);
    const events = await collect(stream);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("tool_activity");
    expect(events[1].event).toBe("answer");
  });

  it("reassembles frames split across multiple chunks", async () => {
    // Deliberately split the frame across chunk boundaries.
    const payload = { tool: "compute_stat", label: "computing…" };
    const full = frame("tool_activity", payload);
    const mid = Math.floor(full.length / 2);
    const stream = makeStream(full.slice(0, mid), full.slice(mid));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "tool_activity", data: payload });
  });

  it("handles a frame with no trailing \\n\\n (trailing flush path)", async () => {
    // Simulate a server close without a final \n\n by omitting it.
    const payload = { tool: "get_move", label: "fetching…" };
    const raw = `event: tool_activity\ndata: ${JSON.stringify(payload)}`;
    // No trailing \n\n — tests the `trailing` flush branch.
    const stream = makeStream(raw);
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "tool_activity", data: payload });
  });

  it("skips unrecognised or data-less frames without erroring", async () => {
    const answer = {
      status: "answered",
      answer_markdown: "ok",
      reasoning_markdown: "ok",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    // An unrecognised "heartbeat" frame and a comment-only frame before the answer.
    const body =
      "event: heartbeat\ndata: {}\n\n" +
      ": this is a comment\n\n" +
      frame("answer", { answer });
    const stream = makeStream(body);
    const events = await collect(stream);
    // Only the answer event should be yielded.
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("answer");
  });

  it("yields nothing from an empty stream", async () => {
    const stream = makeStream();
    const events = await collect(stream);
    expect(events).toHaveLength(0);
  });

  it("streams answer_start + answer_delta* then the terminal answer in order", async () => {
    const answer = {
      status: "answered",
      answer_markdown: "Hi there",
      reasoning_markdown: "ok",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
    };
    const stream = makeStream(
      frame("answer_start", {}),
      frame("answer_delta", { text: "Hi " }),
      frame("answer_delta", { text: "there" }),
      frame("answer", { answer }),
    );
    const events = await collect(stream);
    expect(events.map((e) => e.event)).toEqual([
      "answer_start",
      "answer_delta",
      "answer_delta",
      "answer",
    ]);
    const deltas = events
      .filter((e) => e.event === "answer_delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(deltas).toBe("Hi there");
  });

  it("stops iteration when the AbortSignal fires", async () => {
    // Build a stream with three frames; abort after the first.
    const controller = new AbortController();
    const act1 = { tool: "resolve_entity", label: "1" };
    const act2 = { tool: "query_pokedex", label: "2" };
    const act3 = { tool: "get_pokemon", label: "3" };

    // A custom stream that pauses between frames so we can abort in-flight.
    const encoder = new TextEncoder();
    let enqueued = 0;
    const pausingStream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (enqueued === 0) {
          ctrl.enqueue(encoder.encode(frame("tool_activity", act1)));
          enqueued++;
          // Abort after the first frame is pushed; subsequent pulls won't be called.
          controller.abort();
        } else if (enqueued === 1) {
          ctrl.enqueue(encoder.encode(frame("tool_activity", act2)));
          enqueued++;
        } else if (enqueued === 2) {
          ctrl.enqueue(encoder.encode(frame("tool_activity", act3)));
          enqueued++;
        } else {
          ctrl.close();
        }
      },
    });

    const events = await collect(pausingStream, controller.signal);
    // At most one event before the abort fires (the generator checks the signal
    // at the top of each read() iteration).
    expect(events.length).toBeLessThanOrEqual(1);
    // act3 must never appear since we aborted after act1.
    expect(
      events.find(
        (e) =>
          e.event === "tool_activity" &&
          (e.data as { label: string }).label === "3",
      ),
    ).toBeUndefined();
  });

  it("surfaces an in-domain failure (resolution_failed) as an answer event, not error", async () => {
    const answer = {
      status: "resolution_failed",
      answer_markdown: "Could not find 'Garchoph'. Did you mean Garchomp?",
      reasoning_markdown: "Fuzzy match failed above threshold.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      suggestions: ["Garchomp"],
    };
    const stream = makeStream(frame("answer", { answer }));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("answer");
    // The answer event carries the in-domain status — it is NOT an error event.
    const data = (events[0] as Extract<SseEvent, { event: "answer" }>).data;
    expect(data.answer.status).toBe("resolution_failed");
    expect(data.answer.suggestions).toEqual(["Garchomp"]);
  });

  it("round-trips an answer carrying structured question.options unchanged", async () => {
    const answer = {
      status: "clarification_needed",
      answer_markdown: "Singles or Doubles?",
      reasoning_markdown: "Format changes the recommendation.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      question: {
        options: [
          { label: "Singles", description: "6v6" },
          { label: "Doubles" },
        ],
      },
    };
    const stream = makeStream(frame("answer", { answer }));
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    // The wire layer needs no changes — the question field survives untouched.
    const data = (events[0] as Extract<SseEvent, { event: "answer" }>).data;
    expect(data.answer.question).toEqual(answer.question);
  });
});
