/**
 * Unit tests for src/server/session-store.ts (DS-5, D9).
 *
 * Covers: getHistory, appendTurn, estimateTokens, trim, clearSession,
 * activeSessionCount. No external I/O — pure in-memory Map.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_TOKEN_BUDGET,
  activeSessionCount,
  appendTurn,
  clearSession,
  estimateTokens,
  getHistory,
  trim,
  trimMessages,
} from "@/server/session-store";
import type { ChatMessage } from "@/agent/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_A = "test-session-alpha";
const SESSION_B = "test-session-beta";

function msg(role: "user" | "assistant", content: string): ChatMessage {
  return { role, content };
}

// ---------------------------------------------------------------------------
// Fixtures — clean up only the sessions this file creates so tests are
// independent without coupling to implementation internals.
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearSession(SESSION_A);
  clearSession(SESSION_B);
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe("getHistory", () => {
  it("returns an empty array for an unknown session id", () => {
    expect(getHistory("does-not-exist-" + Math.random())).toEqual([]);
  });

  it("returns [] for a session that was created then cleared", () => {
    appendTurn(SESSION_A, msg("user", "hi"));
    clearSession(SESSION_A);
    expect(getHistory(SESSION_A)).toEqual([]);
  });

  it("returns the accumulated turns in insertion order", () => {
    appendTurn(SESSION_A, msg("user", "Hello"));
    appendTurn(SESSION_A, msg("assistant", "Hi there!"));
    expect(getHistory(SESSION_A)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
  });

  it("reflects subsequent appends without needing to call getHistory again", () => {
    appendTurn(SESSION_A, msg("user", "ping"));
    const snapshot = getHistory(SESSION_A);
    appendTurn(SESSION_A, msg("assistant", "pong"));
    // The returned array is the live internal array — new turns are visible.
    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]).toEqual({ role: "assistant", content: "pong" });
  });
});

// ---------------------------------------------------------------------------
// appendTurn
// ---------------------------------------------------------------------------

describe("appendTurn", () => {
  it("creates the session entry on the first call", () => {
    expect(getHistory(SESSION_A)).toEqual([]);
    appendTurn(SESSION_A, msg("user", "first turn"));
    expect(getHistory(SESSION_A)).toHaveLength(1);
  });

  it("preserves insertion order across many turns", () => {
    const turns: ChatMessage[] = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
    ];
    for (const t of turns) appendTurn(SESSION_A, t);
    expect(getHistory(SESSION_A)).toEqual(turns);
  });

  it("sessions are fully isolated from each other", () => {
    appendTurn(SESSION_A, msg("user", "from A"));
    appendTurn(SESSION_B, msg("user", "from B"));

    expect(getHistory(SESSION_A)).toHaveLength(1);
    expect(getHistory(SESSION_B)).toHaveLength(1);
    expect(getHistory(SESSION_A)[0].content).toBe("from A");
    expect(getHistory(SESSION_B)[0].content).toBe("from B");
  });

  it("appending to one session does not affect another", () => {
    appendTurn(SESSION_A, msg("user", "turn 1"));
    appendTurn(SESSION_B, msg("user", "turn 1"));
    appendTurn(SESSION_A, msg("assistant", "turn 2"));

    expect(getHistory(SESSION_A)).toHaveLength(2);
    expect(getHistory(SESSION_B)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for an empty array", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("returns a positive value for non-empty messages", () => {
    expect(estimateTokens([msg("user", "hello")])).toBeGreaterThan(0);
  });

  it("larger content produces a higher estimate", () => {
    const short = [msg("user", "x")];
    const long = [msg("user", "x".repeat(400))];
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  it("sums across all messages, not just the first", () => {
    const single = [msg("user", "hello world")];
    const doubled = [
      msg("user", "hello world"),
      msg("assistant", "hello world"),
    ];
    expect(estimateTokens(doubled)).toBeGreaterThan(estimateTokens(single));
  });

  it("includes the role string in the character count", () => {
    // "user" (4 chars) vs "assistant" (9 chars) with identical content.
    const userMsg = [msg("user", "test")]; // 4 + 4 = 8 chars
    const assistantMsg = [msg("assistant", "test")]; // 4 + 9 = 13 chars
    expect(estimateTokens(assistantMsg)).toBeGreaterThanOrEqual(
      estimateTokens(userMsg),
    );
  });

  it("matches the manual calculation: ceil((content + role) / 4)", () => {
    // "user" = 4 chars, "Hi" = 2 chars → 6 total → ceil(6/4) = 2 tokens
    expect(estimateTokens([msg("user", "Hi")])).toBe(2);
    // "assistant" = 9 chars, "pong" = 4 chars → 13 → ceil(13/4) = 4 tokens
    expect(estimateTokens([msg("assistant", "pong")])).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// trim
// ---------------------------------------------------------------------------

describe("trim", () => {
  it("is a no-op for a non-existent session (does not throw)", () => {
    expect(() => trim("no-such-session-" + Math.random(), 100)).not.toThrow();
  });

  it("is a no-op for an empty session", () => {
    // clearSession has deleted SESSION_A; append nothing; trim should not throw.
    // Ensure SESSION_A exists with length 0 (it doesn't exist at all, which is fine).
    expect(() => trim(SESSION_A, 10)).not.toThrow();
  });

  it("is a no-op when history is already within budget", () => {
    appendTurn(SESSION_A, msg("user", "short"));
    appendTurn(SESSION_A, msg("assistant", "reply"));
    const lengthBefore = getHistory(SESSION_A).length;

    trim(SESSION_A, DEFAULT_HISTORY_TOKEN_BUDGET);

    expect(getHistory(SESSION_A)).toHaveLength(lengthBefore);
  });

  it("removes oldest turns until estimateTokens is within budget", () => {
    // 10 large messages (5 user + 5 assistant), each ~400 chars ≈ 100+ tokens.
    for (let i = 0; i < 5; i++) {
      appendTurn(SESSION_A, msg("user", "x".repeat(400)));
      appendTurn(SESSION_A, msg("assistant", "y".repeat(400)));
    }
    expect(getHistory(SESSION_A)).toHaveLength(10);

    // Budget = 200 tokens → forces removal; each message is ~100+ tokens.
    trim(SESSION_A, 200);

    const after = getHistory(SESSION_A);
    expect(estimateTokens(after)).toBeLessThanOrEqual(200);
    // At least some messages were removed.
    expect(after.length).toBeLessThan(10);
  });

  it("removes from the front (oldest), preserving the most recent turns", () => {
    appendTurn(SESSION_A, msg("user", "first"));
    appendTurn(SESSION_A, msg("assistant", "second"));
    appendTurn(SESSION_A, msg("user", "third"));
    appendTurn(SESSION_A, msg("assistant", "fourth"));

    // Budget of 5 tokens:
    // "fourth" + "assistant" = 6 + 9 = 15 chars → ceil(15/4) = 4 tokens ≤ 5 → survives.
    // Earlier messages will be evicted to get the total ≤ 5.
    trim(SESSION_A, 5);

    const contents = getHistory(SESSION_A).map((m) => m.content);
    expect(contents).toContain("fourth"); // most recent survives
    expect(contents).not.toContain("first"); // oldest is gone
  });

  it("removes all messages if even a single message exceeds the budget", () => {
    // One very large message that alone exceeds the budget.
    appendTurn(SESSION_A, msg("user", "x".repeat(1000))); // ~251 tokens
    trim(SESSION_A, 10); // budget far below a single message

    expect(getHistory(SESSION_A)).toEqual([]);
    // estimateTokens of [] is 0 ≤ 10.
    expect(estimateTokens(getHistory(SESSION_A))).toBeLessThanOrEqual(10);
  });

  it("uses DEFAULT_HISTORY_TOKEN_BUDGET when called without a budget argument", () => {
    appendTurn(SESSION_A, msg("user", "a small message"));
    appendTurn(SESSION_A, msg("assistant", "a small reply"));
    expect(() => trim(SESSION_A)).not.toThrow();
    // Short messages are well within the default budget — nothing trimmed.
    expect(getHistory(SESSION_A)).toHaveLength(2);
  });

  it("does not affect other sessions when trimming one session", () => {
    for (let i = 0; i < 5; i++) {
      appendTurn(SESSION_A, msg("user", "x".repeat(400)));
      appendTurn(SESSION_A, msg("assistant", "y".repeat(400)));
    }
    appendTurn(SESSION_B, msg("user", "untouched"));

    trim(SESSION_A, 200);

    expect(getHistory(SESSION_B)).toHaveLength(1);
    expect(getHistory(SESSION_B)[0].content).toBe("untouched");
  });
});

// ---------------------------------------------------------------------------
// trimMessages (pure — shared by the guest in-memory path and the signed-in DB
// path; trim() delegates to it)
// ---------------------------------------------------------------------------

describe("trimMessages", () => {
  it("returns an empty array unchanged", () => {
    expect(trimMessages([])).toEqual([]);
  });

  it("returns all messages when already within budget", () => {
    const messages = [msg("user", "short"), msg("assistant", "reply")];
    expect(trimMessages(messages, DEFAULT_HISTORY_TOKEN_BUDGET)).toEqual(
      messages,
    );
  });

  it("does NOT mutate the input array", () => {
    const messages = [
      msg("user", "x".repeat(400)),
      msg("assistant", "y".repeat(400)),
    ];
    const copy = [...messages];
    trimMessages(messages, 5); // would drop everything
    expect(messages).toEqual(copy); // input untouched
  });

  it("drops oldest first until within budget, preserving the most recent", () => {
    const messages = [
      msg("user", "first"),
      msg("assistant", "second"),
      msg("user", "third"),
      msg("assistant", "fourth"),
    ];
    const kept = trimMessages(messages, 5);
    const contents = kept.map((m) => m.content);
    expect(contents).toContain("fourth");
    expect(contents).not.toContain("first");
    expect(estimateTokens(kept)).toBeLessThanOrEqual(5);
  });

  it("returns [] when a single message exceeds the budget", () => {
    expect(trimMessages([msg("user", "x".repeat(1000))], 10)).toEqual([]);
  });

  it("uses DEFAULT_HISTORY_TOKEN_BUDGET when no budget is given", () => {
    const messages = [msg("user", "a small message")];
    expect(trimMessages(messages)).toEqual(messages);
  });

  it("matches what trim() applies to the live store (parity)", () => {
    const built: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const u = msg("user", "x".repeat(400));
      const a = msg("assistant", "y".repeat(400));
      built.push(u, a);
      appendTurn(SESSION_A, u);
      appendTurn(SESSION_A, a);
    }
    const expected = trimMessages(built, 200);
    trim(SESSION_A, 200);
    expect(getHistory(SESSION_A)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

describe("clearSession", () => {
  it("removes all history for the cleared session", () => {
    appendTurn(SESSION_A, msg("user", "to be removed"));
    appendTurn(SESSION_A, msg("assistant", "also removed"));
    clearSession(SESSION_A);
    expect(getHistory(SESSION_A)).toEqual([]);
  });

  it("does not throw when clearing a session that does not exist", () => {
    expect(() => clearSession("nonexistent-session-xyz")).not.toThrow();
  });

  it("does not affect other sessions", () => {
    appendTurn(SESSION_A, msg("user", "stay A"));
    appendTurn(SESSION_B, msg("user", "stay B"));
    clearSession(SESSION_A);

    expect(getHistory(SESSION_A)).toEqual([]);
    expect(getHistory(SESSION_B)).toHaveLength(1);
    expect(getHistory(SESSION_B)[0].content).toBe("stay B");
  });

  it("allows new turns to be appended after clearing", () => {
    appendTurn(SESSION_A, msg("user", "old turn"));
    clearSession(SESSION_A);
    appendTurn(SESSION_A, msg("user", "fresh start"));

    expect(getHistory(SESSION_A)).toEqual([
      { role: "user", content: "fresh start" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// activeSessionCount
// ---------------------------------------------------------------------------

describe("activeSessionCount", () => {
  it("increases when a new session is created via appendTurn", () => {
    const before = activeSessionCount();
    appendTurn(SESSION_A, msg("user", "hello"));
    expect(activeSessionCount()).toBe(before + 1);
  });

  it("decreases when a session is cleared", () => {
    appendTurn(SESSION_A, msg("user", "hello"));
    const after = activeSessionCount();
    clearSession(SESSION_A);
    expect(activeSessionCount()).toBe(after - 1);
  });

  it("is not changed by trim (trim doesn't delete the session entry)", () => {
    appendTurn(SESSION_A, msg("user", "x".repeat(1000)));
    const before = activeSessionCount();
    trim(SESSION_A, 10); // trims all messages but keeps the session key
    // The store entry still exists (empty array), so count is unchanged.
    expect(activeSessionCount()).toBe(before);
  });
});
