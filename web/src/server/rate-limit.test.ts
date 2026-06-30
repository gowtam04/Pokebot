import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route-keying suite below mocks the agent + auth seams so `POST /api/chat`
// never opens Postgres, reads a real cookie, or hits the model — Docker-light,
// mirroring test/api-chat.integration.test.ts. `checkRateLimit` itself is left
// REAL but wrapped in a recording spy, so the route's (key, config) arguments
// can be asserted while the genuine fixed-window logic still runs (the direct
// unit suites in this file exercise that same real implementation).
const {
  mockRunOak,
  mockCreateAgentContext,
  mockGetCurrentAccount,
  mockGetConversation,
  mockGetMessages,
  mockAppendTurnPair,
} = vi.hoisted(() => ({
  mockRunOak: vi.fn(),
  mockCreateAgentContext: vi.fn(),
  mockGetCurrentAccount: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetMessages: vi.fn(),
  mockAppendTurnPair: vi.fn(),
}));
vi.mock("@/agent/runtime", () => ({ runOak: mockRunOak }));
vi.mock("@/agent/context", () => ({
  createAgentContext: mockCreateAgentContext,
}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentAccount: mockGetCurrentAccount,
}));
// Chat-history (B-3): for a SIGNED-IN turn the route reads/writes the durable DB
// via this repo (it dynamically imports it). Mock it so this Docker-light suite
// never opens Postgres; signed-in history is whatever these mocks return.
vi.mock("@/data/repos/conversation-repo", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  appendTurnPair: mockAppendTurnPair,
  newTurnId: () => "test-turn-id",
}));
vi.mock("@/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/rate-limit")>();
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

import {
  _resetStoreForTests,
  checkRateLimit,
  DEFAULT_CONFIG,
  GUEST_CONFIG,
  SIGNED_IN_CONFIG,
  type RateLimitConfig,
} from "@/server/rate-limit";
import { POST } from "@/app/api/chat/route";
import { clearSession } from "@/server/session-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHORT_MSG = "Which Pokemon learn earthquake?";
const SMALL_CONFIG: RateLimitConfig = {
  maxInputLength: 50,
  maxRequestsPerWindow: 3,
  windowMs: 10_000, // 10 s
};

// Convenience: call checkRateLimit with SMALL_CONFIG and an injectable clock.
function check(
  sessionId: string,
  message: string,
  now: number,
  config: RateLimitConfig = SMALL_CONFIG,
) {
  return checkRateLimit(sessionId, message, config, now);
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

beforeEach(() => _resetStoreForTests());
afterEach(() => _resetStoreForTests());

// ---------------------------------------------------------------------------
// Input-length cap
// ---------------------------------------------------------------------------

describe("input-length cap", () => {
  it("allows a message exactly at the limit", () => {
    const msg = "a".repeat(SMALL_CONFIG.maxInputLength);
    const result = check("sess-1", msg, 0);
    expect(result.allowed).toBe(true);
  });

  it("rejects a message one character over the limit", () => {
    const msg = "a".repeat(SMALL_CONFIG.maxInputLength + 1);
    const result = check("sess-1", msg, 0);
    expect(result.allowed).toBe(false);
    if (!result.allowed && result.reason === "input_too_long") {
      expect(result.maxLength).toBe(SMALL_CONFIG.maxInputLength);
      expect(result.actualLength).toBe(SMALL_CONFIG.maxInputLength + 1);
    } else {
      // Force a failure if we didn't take the expected branch.
      expect(result.allowed).toBe(false);
      expect((result as { reason: string }).reason).toBe("input_too_long");
    }
  });

  it("rejects a very long message and reports correct lengths", () => {
    const msg = "x".repeat(5_000);
    const result = check("sess-1", msg, 0);
    expect(result.allowed).toBe(false);
    if (!result.allowed && result.reason === "input_too_long") {
      expect(result.actualLength).toBe(5_000);
    } else {
      expect((result as { reason: string }).reason).toBe("input_too_long");
    }
  });

  it("allows an empty message (length 0)", () => {
    const result = check("sess-1", "", 0);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-session rate window
// ---------------------------------------------------------------------------

describe("per-session fixed-window counter", () => {
  it("allows the first request", () => {
    expect(check("sess-1", SHORT_MSG, 0).allowed).toBe(true);
  });

  it("allows requests up to the limit within the window", () => {
    const limit = SMALL_CONFIG.maxRequestsPerWindow;
    for (let i = 0; i < limit; i++) {
      expect(check("sess-1", SHORT_MSG, i * 100).allowed).toBe(true);
    }
  });

  it("blocks the request immediately after hitting the limit", () => {
    const limit = SMALL_CONFIG.maxRequestsPerWindow;
    for (let i = 0; i < limit; i++) {
      check("sess-1", SHORT_MSG, i * 100);
    }
    const result = check("sess-1", SHORT_MSG, limit * 100);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("rate_limited");
    }
  });

  it("reports a positive retryAfterMs that decays toward zero", () => {
    const { maxRequestsPerWindow, windowMs } = SMALL_CONFIG;
    const windowStart = 0;

    // Fill the window.
    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-1", SHORT_MSG, windowStart + i * 100);
    }

    // Query 1 s into the window.
    const t1 = 1_000;
    const r1 = check("sess-1", SHORT_MSG, t1);
    expect(r1.allowed).toBe(false);
    if (!r1.allowed && r1.reason === "rate_limited") {
      expect(r1.retryAfterMs).toBe(windowMs - t1);
    }

    // Query 5 s into the window — retryAfterMs should be smaller.
    const t2 = 5_000;
    const r2 = check("sess-1", SHORT_MSG, t2);
    expect(r2.allowed).toBe(false);
    if (!r2.allowed && r2.reason === "rate_limited") {
      expect(r2.retryAfterMs).toBe(windowMs - t2);
    }

    // retryAfterMs at t2 is less than at t1.
    if (
      !r1.allowed &&
      r1.reason === "rate_limited" &&
      !r2.allowed &&
      r2.reason === "rate_limited"
    ) {
      expect(r2.retryAfterMs).toBeLessThan(r1.retryAfterMs);
    }
  });

  it("resets the counter after the window expires", () => {
    const { maxRequestsPerWindow, windowMs } = SMALL_CONFIG;

    // Fill window starting at t=0.
    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-1", SHORT_MSG, i * 100);
    }
    expect(check("sess-1", SHORT_MSG, 500).allowed).toBe(false);

    // Advance past the window boundary.
    const afterWindow = windowMs + 1;
    expect(check("sess-1", SHORT_MSG, afterWindow).allowed).toBe(true);

    // The fresh window allows up to the limit again.
    for (let i = 1; i < maxRequestsPerWindow; i++) {
      expect(check("sess-1", SHORT_MSG, afterWindow + i * 100).allowed).toBe(
        true,
      );
    }
    // One beyond the new limit is blocked.
    expect(
      check("sess-1", SHORT_MSG, afterWindow + maxRequestsPerWindow * 100)
        .allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  it("tracks separate counters for different session IDs", () => {
    const { maxRequestsPerWindow } = SMALL_CONFIG;

    // Fill session A.
    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-A", SHORT_MSG, i * 100);
    }
    // Session A is now rate-limited.
    expect(check("sess-A", SHORT_MSG, maxRequestsPerWindow * 100).allowed).toBe(
      false,
    );
    // Session B is unaffected.
    expect(check("sess-B", SHORT_MSG, maxRequestsPerWindow * 100).allowed).toBe(
      true,
    );
  });

  it("two sessions can both exhaust their own limits independently", () => {
    const { maxRequestsPerWindow } = SMALL_CONFIG;

    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-X", SHORT_MSG, i * 10);
      check("sess-Y", SHORT_MSG, i * 10);
    }
    expect(check("sess-X", SHORT_MSG, maxRequestsPerWindow * 10).allowed).toBe(
      false,
    );
    expect(check("sess-Y", SHORT_MSG, maxRequestsPerWindow * 10).allowed).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG sanity
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG", () => {
  it("has sensible values (length ≥ 500, rate ≥ 5, window ≥ 10 s)", () => {
    expect(DEFAULT_CONFIG.maxInputLength).toBeGreaterThanOrEqual(500);
    expect(DEFAULT_CONFIG.maxRequestsPerWindow).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_CONFIG.windowMs).toBeGreaterThanOrEqual(10_000);
  });

  it("allows a typical short Pokémon question with the default config", () => {
    const result = checkRateLimit(
      "sess-default",
      "What are all the Water-type Pokemon with speed above 100?",
    );
    expect(result.allowed).toBe(true);
    _resetStoreForTests();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("retryAfterMs is clamped to 0 when called at the exact window boundary", () => {
    const { maxRequestsPerWindow, windowMs } = SMALL_CONFIG;

    // Fill the window starting at t=0.
    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-edge", SHORT_MSG, 0);
    }

    // Call exactly at the window end — should start a new window.
    const atBoundary = windowMs;
    const result = check("sess-edge", SHORT_MSG, atBoundary);
    // The window has expired (now - windowStart === windowMs), so a new
    // window starts and the request is allowed.
    expect(result.allowed).toBe(true);
  });

  it("input-length check precedes the rate-limit check", () => {
    // Exhaust the rate limit first.
    const { maxRequestsPerWindow } = SMALL_CONFIG;
    for (let i = 0; i < maxRequestsPerWindow; i++) {
      check("sess-order", SHORT_MSG, i * 10);
    }

    // Now send an oversized message — should fail on length, not rate limit.
    const oversized = "z".repeat(SMALL_CONFIG.maxInputLength + 100);
    const result = check("sess-order", oversized, maxRequestsPerWindow * 10);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("input_too_long");
    }
  });
});

// ===========================================================================
// Tiered chat configs (account-creation Phase 5; BR-A8 / AUTH-US-7)
// ===========================================================================

describe("tiered chat configs", () => {
  it("GUEST_CONFIG is 20 / 60 s with the 2000-char cap (AC-1.3, BR-A8)", () => {
    expect(GUEST_CONFIG.maxRequestsPerWindow).toBe(20);
    expect(GUEST_CONFIG.windowMs).toBe(60_000);
    expect(GUEST_CONFIG.maxInputLength).toBe(2_000);
  });

  it("SIGNED_IN_CONFIG is 60 / 60 s with the 2000-char cap (AC-7.1, BR-A8)", () => {
    expect(SIGNED_IN_CONFIG.maxRequestsPerWindow).toBe(60);
    expect(SIGNED_IN_CONFIG.windowMs).toBe(60_000);
    expect(SIGNED_IN_CONFIG.maxInputLength).toBe(2_000);
  });

  it("the signed-in allowance is strictly higher than the guest allowance (AUTH-US-7)", () => {
    expect(SIGNED_IN_CONFIG.maxRequestsPerWindow).toBeGreaterThan(
      GUEST_CONFIG.maxRequestsPerWindow,
    );
    // Both keep the input cap unchanged (BR-A11): only the request allowance differs.
    expect(SIGNED_IN_CONFIG.maxInputLength).toBe(GUEST_CONFIG.maxInputLength);
  });
});

// ===========================================================================
// Independent per-key counters across tiers (BR-A8 / AC-7.3)
//
// The point of BR-A8: the guest pool (keyed `ip:<addr>`) and the account pool
// (keyed `acct:<id>`) never share a Map entry, so a guest can never pool into,
// or drain, the account tier — and each guest IP is independently capped, so a
// single user cannot exceed the guest tier by spawning guest sessions (AC-7.3).
// ===========================================================================

describe("independent per-key counters across tiers", () => {
  const MSG = "Which Pokemon learn earthquake?"; // well under either input cap

  it("enforces the guest cap exactly: 20 allowed, then blocked (AC-1.3)", () => {
    for (let i = 0; i < GUEST_CONFIG.maxRequestsPerWindow; i++) {
      expect(checkRateLimit("ip:1.1.1.1", MSG, GUEST_CONFIG, i).allowed).toBe(
        true,
      );
    }
    const blocked = checkRateLimit("ip:1.1.1.1", MSG, GUEST_CONFIG, 500);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe("rate_limited");
  });

  it("enforces the higher signed-in cap exactly: 60 allowed, then blocked (AC-7.1)", () => {
    for (let i = 0; i < SIGNED_IN_CONFIG.maxRequestsPerWindow; i++) {
      expect(
        checkRateLimit("acct:a1", MSG, SIGNED_IN_CONFIG, i).allowed,
      ).toBe(true);
    }
    const blocked = checkRateLimit("acct:a1", MSG, SIGNED_IN_CONFIG, 9_999);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe("rate_limited");
  });

  it("a guest bucket cannot pool into the account tier — exhausting ip:<x> leaves acct:<y> fully available (AC-7.3, BR-A8)", () => {
    // Exhaust the guest IP bucket completely.
    for (let i = 0; i < GUEST_CONFIG.maxRequestsPerWindow; i++) {
      checkRateLimit("ip:9.9.9.9", MSG, GUEST_CONFIG, i);
    }
    const guestBlocked = checkRateLimit("ip:9.9.9.9", MSG, GUEST_CONFIG, 500);
    expect(guestBlocked.allowed).toBe(false);
    if (!guestBlocked.allowed) expect(guestBlocked.reason).toBe("rate_limited");

    // The account key is a SEPARATE bucket: untouched by the guest activity and
    // still good for its full, higher allowance.
    for (let i = 0; i < SIGNED_IN_CONFIG.maxRequestsPerWindow; i++) {
      expect(
        checkRateLimit("acct:owner", MSG, SIGNED_IN_CONFIG, 600 + i).allowed,
      ).toBe(true);
    }
    const acctBlocked = checkRateLimit(
      "acct:owner",
      MSG,
      SIGNED_IN_CONFIG,
      30_000,
    );
    expect(acctBlocked.allowed).toBe(false);
    if (!acctBlocked.allowed) expect(acctBlocked.reason).toBe("rate_limited");
  });

  it("two distinct guest IPs are limited independently — spawning guest sessions does not borrow allowance (AC-7.3)", () => {
    for (let i = 0; i < GUEST_CONFIG.maxRequestsPerWindow; i++) {
      checkRateLimit("ip:2.2.2.2", MSG, GUEST_CONFIG, i);
    }
    // ip:2.2.2.2 is exhausted...
    const exhausted = checkRateLimit("ip:2.2.2.2", MSG, GUEST_CONFIG, 500);
    expect(exhausted.allowed).toBe(false);
    if (!exhausted.allowed) expect(exhausted.reason).toBe("rate_limited");
    // ...but a different guest IP starts fresh (independent counter).
    expect(checkRateLimit("ip:3.3.3.3", MSG, GUEST_CONFIG, 500).allowed).toBe(
      true,
    );
  });
});

// ===========================================================================
// POST /api/chat — tiered rate-limit keying (account-creation Phase 5)
//
// Asserts the ROUTE wiring: getCurrentAccount() resolves BEFORE the gate, then
// the route keys + configures by auth tier and passes them to checkRateLimit.
// The agent loop, context, and auth seam are mocked (Docker-light). The real
// fixed-window logic still runs through the spy, so the 429 / input-cap
// branches below are genuine end-to-end rejections.
// ===========================================================================

/** Drain a streamed SSE Response to completion (so the detached task settles). */
async function drain(res: Response): Promise<string> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  buf += decoder.decode();
  return buf;
}

/** Parse the `event:` names out of raw SSE frames. */
function sseEventNames(raw: string): string[] {
  const names: string[] = [];
  for (const frame of raw.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) names.push(line.slice("event:".length).trim());
    }
  }
  return names;
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const ROUTE_ANSWER = {
  status: "answered" as const,
  answer_markdown: "Pikachu is an Electric-type.",
};

const ACCOUNT = { id: "acct-42", email: "ash@pallet.town", createdAt: 0 };

describe("POST /api/chat — tiered rate-limit keying", () => {
  beforeEach(() => {
    mockRunOak.mockReset();
    mockRunOak.mockResolvedValue(ROUTE_ANSWER);
    mockCreateAgentContext.mockReset();
    mockCreateAgentContext.mockResolvedValue({});
    mockGetCurrentAccount.mockReset();
    mockGetCurrentAccount.mockResolvedValue(null); // guest unless overridden
    // Default: a signed-in conversation does not exist yet (new), so signed-in
    // history is empty unless a test seeds the DB-mock for a resume.
    mockGetConversation.mockReset();
    mockGetConversation.mockResolvedValue(null);
    mockGetMessages.mockReset();
    mockGetMessages.mockResolvedValue([]);
    mockAppendTurnPair.mockReset();
    mockAppendTurnPair.mockResolvedValue(undefined);
    vi.mocked(checkRateLimit).mockClear();
  });

  afterEach(() => {
    for (const id of ["s-guest", "s-signed", "s-cap", "s-thread", "s-champ"]) {
      clearSession(id);
    }
  });

  it("keys a guest by ip:<first X-Forwarded-For hop> with GUEST_CONFIG (AC-1.1, AC-1.3, BR-A8)", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const res = await post(
      { session_id: "s-guest", message: "hi" },
      { "X-Forwarded-For": "203.0.113.7, 70.41.3.18, 150.172.238.178" },
    );
    expect(res.status).toBe(200); // chat works for guests without auth (AC-1.1)
    await drain(res);

    const calls = vi.mocked(checkRateLimit).mock.calls;
    expect(calls).toHaveLength(1);
    const [key, msg, config] = calls[0]!;
    expect(key).toBe("ip:203.0.113.7"); // FIRST hop only, not the whole chain
    expect(msg).toBe("hi");
    expect(config).toBe(GUEST_CONFIG);
    // Identity != conversation: the rate-limit key is NEVER the session_id.
    expect(key).not.toBe("s-guest");
  });

  it("keys a signed-in user by acct:<id> with SIGNED_IN_CONFIG, ignoring the IP (AC-7.1, BR-A8)", async () => {
    mockGetCurrentAccount.mockResolvedValue(ACCOUNT);
    const res = await post(
      { session_id: "s-signed", message: "hi" },
      { "X-Forwarded-For": "203.0.113.7" }, // present but irrelevant once signed in
    );
    expect(res.status).toBe(200);
    await drain(res);

    const calls = vi.mocked(checkRateLimit).mock.calls;
    expect(calls).toHaveLength(1);
    const [key, , config] = calls[0]!;
    expect(key).toBe("acct:acct-42");
    expect(config).toBe(SIGNED_IN_CONFIG);
    expect(key).not.toMatch(/^ip:/); // an authed user is never keyed by IP
  });

  it("falls back to ip:unknown for a guest with no forwarding headers (still GUEST_CONFIG)", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const res = await post({ session_id: "s-guest", message: "hi" });
    await drain(res);
    const [key, , config] = vi.mocked(checkRateLimit).mock.calls[0]!;
    expect(key).toBe("ip:unknown");
    expect(config).toBe(GUEST_CONFIG);
  });

  it("prefers X-Real-IP when X-Forwarded-For is absent", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const res = await post(
      { session_id: "s-guest", message: "hi" },
      { "X-Real-IP": "198.51.100.9" },
    );
    await drain(res);
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toBe("ip:198.51.100.9");
  });

  it("degrades to the GUEST tier when account resolution throws — never a 500 (BR-A11)", async () => {
    mockGetCurrentAccount.mockRejectedValue(
      new Error("cookies() called outside a request scope"),
    );
    const res = await post(
      { session_id: "s-guest", message: "hi" },
      { "X-Forwarded-For": "8.8.8.8" },
    );
    expect(res.status).toBe(200); // a session-resolution fault must not block chat
    await drain(res);
    const [key, , config] = vi.mocked(checkRateLimit).mock.calls[0]!;
    expect(key).toBe("ip:8.8.8.8");
    expect(config).toBe(GUEST_CONFIG);
  });

  it("keeps the 2000-char input cap for a GUEST → 413, runtime never invoked (BR-A11)", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const res = await post({ session_id: "s-cap", message: "x".repeat(2_001) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("input_too_long");
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("keeps the 2000-char input cap for a SIGNED-IN user → 413 (BR-A11)", async () => {
    mockGetCurrentAccount.mockResolvedValue(ACCOUNT);
    const res = await post({ session_id: "s-signed", message: "y".repeat(2_001) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("input_too_long");
    expect(mockRunOak).not.toHaveBeenCalled();
  });

  it("enforces the guest cap at the route (20/60s) → 429 + Retry-After, while the account pool stays independent (AC-1.3, AC-7.3, BR-A8)", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const ipHeader = { "X-Forwarded-For": "9.9.9.9" };
    for (let i = 0; i < GUEST_CONFIG.maxRequestsPerWindow; i++) {
      const ok = await post({ session_id: "s-guest", message: `q${i}` }, ipHeader);
      expect(ok.status).toBe(200);
      await drain(ok);
    }
    // The 21st guest request from that IP is rejected before the stream opens.
    const limited = await post(
      { session_id: "s-guest", message: "one too many" },
      ipHeader,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const limitedBody = (await limited.json()) as { code: string };
    expect(limitedBody.code).toBe("rate_limited");
    // Runtime ran for the 20 allowed posts only — never for the blocked one.
    expect(mockRunOak).toHaveBeenCalledTimes(
      GUEST_CONFIG.maxRequestsPerWindow,
    );

    // A signed-in user (separate `acct:` pool) is unaffected by the exhausted
    // guest bucket — guests cannot drain the account tier (AC-7.3).
    mockGetCurrentAccount.mockResolvedValue(ACCOUNT);
    const signed = await post(
      { session_id: "s-signed", message: "as a user" },
      ipHeader,
    );
    expect(signed.status).toBe(200);
    await drain(signed);
  });

  it("leaves the conversation session_id + SSE contract unchanged across sign-in (BR-A10, AC-6.2)", async () => {
    mockRunOak.mockReset();
    mockRunOak.mockResolvedValueOnce({
      ...ROUTE_ANSWER,
      answer_markdown: "first answer",
    });
    mockRunOak.mockResolvedValueOnce(ROUTE_ANSWER);

    // Turn 1 — as a guest (keyed ip:5.5.5.5).
    mockGetCurrentAccount.mockResolvedValueOnce(null);
    const t1 = await post(
      { session_id: "s-thread", message: "first question" },
      { "X-Forwarded-For": "5.5.5.5" },
    );
    const raw1 = await drain(t1);
    expect(sseEventNames(raw1)).toContain("answer"); // SSE contract unchanged

    // Turn 2 — now signed in (keyed acct:acct-42), SAME conversation session_id.
    // Under chat-history (B-3) a signed-in turn reads its prior turns from the
    // DURABLE DB (the client imported the on-screen thread on sign-in, BR-H10),
    // not the in-memory guest store. Simulate that imported conversation here.
    mockGetCurrentAccount.mockResolvedValueOnce(ACCOUNT);
    mockGetConversation.mockResolvedValueOnce({
      id: "s-thread",
      accountId: ACCOUNT.id,
      title: "first question",
      format: "scarlet-violet",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    });
    mockGetMessages.mockResolvedValueOnce([
      { id: "m0", role: "user", seq: 0, textContent: "first question", answerJson: null, createdAt: 1 },
      { id: "m1", role: "assistant", seq: 1, textContent: "first answer", answerJson: "{}", createdAt: 1 },
    ]);
    const t2 = await post({ session_id: "s-thread", message: "follow up" });
    await drain(t2);

    // The conversation is keyed by session_id, NOT auth tier: the prior turn
    // pair threads into turn 2 (now DB-sourced) even though the rate-limit key
    // changed ip→acct.
    const secondCall = mockRunOak.mock.calls[1]! as [
      string,
      { role: string; content: string }[],
    ];
    expect(secondCall[0]).toBe("follow up");
    expect(secondCall[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);

    // ...and the two turns used DIFFERENT rate-limit keys (guest vs account).
    const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
    expect(keys).toEqual(["ip:5.5.5.5", "acct:acct-42"]);
  });

  it("leaves Champions mode untouched — champions_mode still flows to the agent context (BR-A11)", async () => {
    mockGetCurrentAccount.mockResolvedValue(null);
    const champ = await post({
      session_id: "s-champ",
      message: "hi",
      champions_mode: true,
    });
    await drain(champ);
    expect(mockCreateAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-champ", mode: "champions" }),
    );

    mockCreateAgentContext.mockClear();
    const std = await post({ session_id: "s-champ", message: "hi again" });
    await drain(std);
    expect(mockCreateAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "standard" }),
    );
  });
});
