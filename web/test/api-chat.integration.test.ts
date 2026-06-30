/**
 * BACKEND-STACK-E2E ORACLE — the `POST /api/chat` SSE route exercised end-to-end
 * by calling the exported handler directly and PARSING the streamed frames.
 *
 * This is the integration checkpoint design.md mandates after Phase 6
 * ("backend-stack-e2e: POST /api/chat streams a valid OakAnswer for G1 + G4")
 * and the Vitest RISK DIRECTIVE ("call the exported POST(new Request(...)) and
 * parse response.body frames with runOak mocked"). The runtime + agent
 * context are mocked, so no SQLite / model / network is touched: this asserts the
 * ORCHESTRATION seam (SSE framing, event ordering, in-domain-as-answer vs.
 * transport-as-error, the guardrails, and session history threading).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oakAnswerSchema, type OakAnswer } from "@/agent/schemas";

// The chat route now resolves the current account for tiered rate-limiting (it
// dynamically imports current-user → sessions → server-only + next/headers,
// none of which exist in this orchestration-only test). Mock the seam to resolve
// a guest (null) directly — this test asserts SSE framing as a guest, and keeps
// the real db/auth chain (server-only, cookies()) out of the node test entirely.
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentAccount: vi.fn(async () => null),
}));

// --- Mock the runtime + context so the route never opens SQLite / hits the model.
const { mockRunOak } = vi.hoisted(() => ({ mockRunOak: vi.fn() }));
vi.mock("@/agent/runtime", () => ({ runOak: mockRunOak }));
vi.mock("@/agent/context", () => ({
  createAgentContext: vi.fn(async () => ({
    db: {},
    requestId: "test-req",
    mode: "standard",
    logger: {
      info: () => {},
      error: () => {},
      bindings: () => ({}),
    },
  })),
}));

import { POST } from "@/app/api/chat/route";
import { createAgentContext } from "@/agent/context";
import { _resetStoreForTests } from "@/server/rate-limit";
import { clearSession } from "@/server/session-store";

// A sentinel "secret" placed in the env so we can prove the route never leaks it
// into any streamed frame (no-API-key-leak criterion).
const SECRET = "sk-ant-LEAK-SENTINEL-DO-NOT-EMIT";

// --- Canonical answers the mocked runtime "produces" ------------------------

const G1_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown:
    "Only **Ninetales** can learn both Trick Room and Will-O-Wisp in Gen 9.",
  reasoning_markdown:
    "Intersection of the two Gen-9 learnsets — Ninetales is the only Pokémon in both.",
  citations: [
    {
      source: "learnset/trick-room (gen-9)",
      detail: "learned_by includes ninetales",
    },
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

const G4_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown:
    "It depends on Farigiraf's ability — Armor Tail would block Fake Out's +3 priority.",
  reasoning_markdown: "Fake Out is +3 priority; Armor Tail negates that.",
  citations: [{ source: "move/fake-out", detail: "priority: 3" }],
  inferences: [
    {
      claim:
        "Armor Tail negates Fake Out because Fake Out has positive priority.",
      confidence: "high",
    },
  ],
  generation_basis: { generation: "gen-9", fallback: false },
};

// --- SSE helpers ------------------------------------------------------------

interface SseEvent {
  event: string;
  data: unknown;
}

/** Drain a streamed Response and parse its `event:`/`data:` SSE frames. */
async function readSse(res: Response): Promise<SseEvent[]> {
  expect(res.body, "response has a body stream").toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  buf += decoder.decode();

  const events: SseEvent[] = [];
  for (const frame of buf.split("\n\n")) {
    const trimmed = frame.replace(/\n+$/, "");
    if (trimmed.trim() === "") continue;
    let event = "";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice("data:".length).trim());
    }
    // The directive requires single-line data; assert exactly one data line and
    // that it round-trips as JSON (proves the frame is well-formed).
    expect(dataLines.length, `frame has one data line: ${trimmed}`).toBe(1);
    events.push({ event, data: JSON.parse(dataLines[0]!) });
  }
  return events;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Serialize all frames so we can scan for an accidental secret leak. */
function rawOf(events: SseEvent[]): string {
  return JSON.stringify(events);
}

beforeEach(() => {
  mockRunOak.mockReset();
  _resetStoreForTests();
  process.env.ANTHROPIC_API_KEY = SECRET;
});

afterEach(() => {
  clearSession("s-g1");
  clearSession("s-g4");
  clearSession("s-fail");
  clearSession("s-throw");
  clearSession("s-thread");
  clearSession("s-img");
});

// --- Happy path: streamed answer + progress --------------------------------

describe("POST /api/chat — SSE happy path", () => {
  it("streams tool_activity events then exactly one answer carrying the G1 OakAnswer", async () => {
    mockRunOak.mockImplementation(
      async (
        _message: string,
        _history: unknown,
        _ctx: unknown,
        onProgress?: (e: { tool: string; label: string }) => void,
      ) => {
        onProgress?.({ tool: "resolve_entity", label: "🔍 resolving…" });
        onProgress?.({ tool: "query_pokedex", label: "📊 querying Pokédex…" });
        return G1_ANSWER;
      },
    );

    const res = await post({
      session_id: "s-g1",
      message: "find a Pokémon that can learn both Trick Room and Will-O-Wisp",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-cache, no-transform/);
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const events = await readSse(res);
    const activity = events.filter((e) => e.event === "tool_activity");
    const answers = events.filter((e) => e.event === "answer");
    const errors = events.filter((e) => e.event === "error");

    // tool_activity* then EXACTLY ONE answer, no error.
    expect(activity.map((e) => (e.data as { tool: string }).tool)).toEqual([
      "resolve_entity",
      "query_pokedex",
    ]);
    expect(answers).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(events[events.length - 1]!.event).toBe("answer");

    const streamed = (answers[0]!.data as { answer: OakAnswer }).answer;
    expect(oakAnswerSchema.safeParse(streamed).success).toBe(true);
    expect(streamed).toEqual(G1_ANSWER);
    expect(streamed.candidates?.total_count).toBe(1);
  });

  it("emits answer_start + answer_delta frames before the terminal answer", async () => {
    mockRunOak.mockImplementation(
      async (
        _message: string,
        _history: unknown,
        _ctx: unknown,
        _onProgress: unknown,
        onAnswerStart?: () => void,
        onAnswerDelta?: (text: string) => void,
      ) => {
        onAnswerStart?.();
        onAnswerDelta?.("Only ");
        onAnswerDelta?.("Ninetales");
        return G1_ANSWER;
      },
    );

    const res = await post({ session_id: "s-g1", message: "trick room list" });
    const events = await readSse(res);
    const names = events.map((e) => e.event);

    // answer_start fires once, before any answer_delta; terminal answer is last.
    expect(names.filter((n) => n === "answer_start")).toHaveLength(1);
    expect(names.indexOf("answer_start")).toBeLessThan(
      names.indexOf("answer_delta"),
    );
    expect(names[names.length - 1]).toBe("answer");

    const streamed = events
      .filter((e) => e.event === "answer_delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(streamed).toBe("Only Ninetales");
    // The terminal answer remains authoritative (full structured payload).
    const answers = events.filter((e) => e.event === "answer");
    expect(answers).toHaveLength(1);
    expect((answers[0]!.data as { answer: OakAnswer }).answer).toEqual(
      G1_ANSWER,
    );
  });

  it("streams a G4 conditional answer with its inference intact", async () => {
    mockRunOak.mockResolvedValue(G4_ANSWER);

    const res = await post({
      session_id: "s-g4",
      message: "does Fake Out work on Farigiraf?",
    });
    const events = await readSse(res);
    const answers = events.filter((e) => e.event === "answer");
    expect(answers).toHaveLength(1);
    const streamed = (answers[0]!.data as { answer: OakAnswer }).answer;
    expect(streamed.inferences.length).toBeGreaterThanOrEqual(1);
    expect(streamed.inferences[0]!.claim).toMatch(/armor.?tail/i);
  });
});

// --- Error surface: in-domain vs transport (integration.md) -----------------

describe("POST /api/chat — error surface", () => {
  it.each([
    "insufficient_data",
    "clarification_needed",
    "resolution_failed",
  ] as const)(
    "delivers an in-domain '%s' result as an answer event, never an error event",
    async (status) => {
      const inDomain: OakAnswer = {
        status,
        answer_markdown: "I couldn't fully resolve that.",
        reasoning_markdown: "—",
        citations: [],
        inferences: [],
        generation_basis: { generation: "gen-9", fallback: false },
        suggestions: ["Will-O-Wisp"],
      };
      mockRunOak.mockResolvedValue(inDomain);

      const res = await post({ session_id: "s-fail", message: "wat" });
      const events = await readSse(res);

      expect(events.filter((e) => e.event === "error")).toHaveLength(0);
      const answers = events.filter((e) => e.event === "answer");
      expect(answers).toHaveLength(1);
      expect(
        (answers[0]!.data as { answer: OakAnswer }).answer.status,
      ).toBe(status);
    },
  );

  it("delivers a stop-and-ask clarification with question.options as one answer event, intact", async () => {
    const question: OakAnswer = {
      status: "clarification_needed",
      answer_markdown: "Singles or Doubles?",
      reasoning_markdown: "Format changes the recommendation.",
      citations: [],
      inferences: [],
      generation_basis: { generation: "gen-9", fallback: false },
      question: {
        options: [
          { label: "Singles", description: "6v6" },
          { label: "Doubles", description: "4v4" },
        ],
      },
    };
    mockRunOak.mockResolvedValue(question);

    const res = await post({ session_id: "s-ask", message: "build a TR team" });
    const events = await readSse(res);

    expect(events.filter((e) => e.event === "error")).toHaveLength(0);
    const answers = events.filter((e) => e.event === "answer");
    expect(answers).toHaveLength(1);
    const streamed = (answers[0]!.data as { answer: OakAnswer }).answer;
    // The question survives JSON round-trip + schema validation unchanged.
    expect(oakAnswerSchema.safeParse(streamed).success).toBe(true);
    expect(streamed.question?.options.map((o) => o.label)).toEqual([
      "Singles",
      "Doubles",
    ]);
  });

  it("surfaces a transport/API fault as a single error event (no answer, no key leak)", async () => {
    mockRunOak.mockRejectedValue(new Error("Anthropic 529 overloaded"));

    const res = await post({ session_id: "s-throw", message: "hello" });
    const events = await readSse(res);

    const errors = events.filter((e) => e.event === "error");
    const answers = events.filter((e) => e.event === "answer");
    expect(answers).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { code: string }).code).toBe("agent_error");
    // The route emits a STATIC message; the secret must never appear in output.
    expect(rawOf(events)).not.toContain(SECRET);
  });
});

// --- Guardrails (pre-stream HTTP rejections) --------------------------------

describe("POST /api/chat — guardrails", () => {
  it("rejects an oversized message with 413 before any streaming", async () => {
    const res = await post({
      session_id: "s-g1",
      message: "x".repeat(2_001), // default cap is 2000
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("input_too_long");
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post({ session_id: "s-g1" }); // missing message
    expect(res.status).toBe(400);
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("rate-limits a session after the per-window cap with 429 + Retry-After", async () => {
    mockRunOak.mockResolvedValue(G1_ANSWER);
    // Default window cap is 20 requests; drain each stream so the task settles.
    for (let i = 0; i < 20; i++) {
      const ok = await post({ session_id: "s-g1", message: `q${i}` });
      expect(ok.status).toBe(200);
      await readSse(ok);
    }
    const limited = await post({ session_id: "s-g1", message: "one too many" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const body = (await limited.json()) as { code: string };
    expect(body.code).toBe("rate_limited");
  });
});

// --- Multi-turn: history threading across turns in one session --------------

describe("POST /api/chat — session history", () => {
  it("threads the prior user+assistant turn into the next call's history", async () => {
    mockRunOak.mockImplementation(async () => ({
      ...G1_ANSWER,
      answer_markdown: "first answer",
    }));

    const first = await post({
      session_id: "s-thread",
      message: "first question",
    });
    await readSse(first); // ensure the turn pair is committed before turn 2

    mockRunOak.mockResolvedValue(G1_ANSWER);
    const second = await post({
      session_id: "s-thread",
      message: "now only the Fire types",
    });
    await readSse(second);

    // The SECOND runOak call receives the prior turn pair as history, and the
    // current message is passed separately (never inside history).
    const secondCall = mockRunOak.mock.calls[1]!;
    const [message, history] = secondCall as [
      string,
      { role: string; content: string }[],
    ];
    expect(message).toBe("now only the Fire types");
    expect(history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});

// --- Image attachments (vision input) --------------------------------------

/** A minimal valid PNG payload (8-byte signature + filler), base64-encoded. */
const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]).toString("base64");

describe("POST /api/chat — image attachments", () => {
  it("accepts an image-only message (empty text) and binds the image onto the context", async () => {
    mockRunOak.mockResolvedValue(G1_ANSWER);
    vi.mocked(createAgentContext).mockClear();

    const res = await post({
      session_id: "s-img",
      message: "",
      images: [{ mimeType: "image/png", data: PNG_B64 }],
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.filter((e) => e.event === "answer")).toHaveLength(1);
    expect(mockRunOak).toHaveBeenCalledTimes(1);

    // The validated, mime-sniffed image is bound onto ctx.images (consume-on-turn).
    const opts = vi.mocked(createAgentContext).mock.calls[0]![0] as {
      images?: { mimeType: string; data: string }[];
    };
    expect(opts.images).toHaveLength(1);
    expect(opts.images![0]!.mimeType).toBe("image/png");
  });

  it("rejects more than 4 images with 400 before streaming", async () => {
    mockRunOak.mockResolvedValue(G1_ANSWER);
    const one = { mimeType: "image/png", data: PNG_B64 };
    const res = await post({
      session_id: "s-img",
      message: "compare these",
      images: [one, one, one, one, one],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("too_many_images");
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("rejects a non-image attachment with 400 invalid_image", async () => {
    mockRunOak.mockResolvedValue(G1_ANSWER);
    const res = await post({
      session_id: "s-img",
      message: "what is this?",
      images: [
        { mimeType: "image/png", data: Buffer.from("not an image").toString("base64") },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_image");
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("still rejects an empty message with NO images (400)", async () => {
    const res = await post({ session_id: "s-img", message: "" });
    expect(res.status).toBe(400);
    expect(mockRunOak).not.toHaveBeenCalled();
  });
});

// --- SSE robustness: long/slow turns (image turns especially) -----------------

describe("POST /api/chat — SSE lifecycle robustness", () => {
  /** Spin the event loop until `cond()` holds (or a bounded number of ticks). */
  async function until(cond: () => boolean, ticks = 100): Promise<void> {
    for (let i = 0; i < ticks && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("does not crash (enqueue-after-close) when the client disconnects mid-turn", async () => {
    // A turn whose answer we resolve manually, AFTER the client has gone away.
    let resolveRun: (a: OakAnswer) => void = () => {};
    mockRunOak.mockImplementation(
      () =>
        new Promise<OakAnswer>((res) => {
          resolveRun = res;
        }),
    );

    const res = await post({ session_id: "s-img", message: "slow image turn" });
    expect(res.status).toBe(200);

    // Wait until the detached task is parked inside runOak…
    await until(() => mockRunOak.mock.calls.length > 0);
    // …then the client disconnects (cancels the response stream → the route's
    // ReadableStream cancel() fires).
    await res.body!.cancel();

    // The turn finishes on the server. The post-answer send()/close() now run
    // against a dead controller — they MUST be no-ops, not an unhandled
    // "Invalid state: Controller is already closed" rejection (which would fail
    // this test). No assertion needed beyond completing cleanly.
    resolveRun(G1_ANSWER);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockRunOak).toHaveBeenCalledTimes(1);
  });

  it("emits keep-alive heartbeats while a turn is in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveRun: (a: OakAnswer) => void = () => {};
      mockRunOak.mockImplementation(
        () =>
          new Promise<OakAnswer>((res) => {
            resolveRun = res;
          }),
      );

      const res = await post({ session_id: "s-img", message: "quiet turn" });
      // Advance past one 15s heartbeat tick (the route emits an SSE comment).
      await vi.advanceTimersByTimeAsync(15_100);

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain(": keep-alive");

      // Let the turn finish so the detached task settles before teardown.
      resolveRun(G1_ANSWER);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
