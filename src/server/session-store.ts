/**
 * In-memory session store — DS-5, D9 (design.md § Component Design § Session
 * Store; agent-design/data-sources.md § DS-5).
 *
 * Holds the running ChatMessage[] for each active session keyed by session_id.
 * Entries are discarded when the server process exits (D9 — no persistence,
 * no cross-session memory). The `trim` function removes the oldest turns when
 * the estimated token count approaches the context budget, preserving the most
 * recent context so the agent always has the freshest conversation.
 *
 * Depends on nothing (design.md Component Design table).
 */

import type { ChatMessage } from "@/agent/types";

// ---------------------------------------------------------------------------
// Context-budget constants
// ---------------------------------------------------------------------------

/**
 * Conservative characters-per-token estimate. Claude / GPT-family English
 * text averages ~4 chars/token; we use 4 to over-estimate slightly (trimming
 * a bit earlier is safe).
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Default token budget allocated to the history tail.
 *
 * Sonnet 4.6 has a 200k-token context window. The stable prefix (system
 * prompt + 11 tool definitions + few-shot examples) consumes roughly 8–12k
 * tokens and is prompt-cached. The model's max output is capped at ~8k. This
 * default reserves 100k for the variable history + current message, leaving
 * comfortable headroom for the prefix and the assistant's reply.
 */
export const DEFAULT_HISTORY_TOKEN_BUDGET = 100_000;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Module-level in-memory store. One Map instance per server process (D9).
 * Exported only so tests can inspect or replace it if needed; prefer the
 * public API functions.
 */
const store = new Map<string, ChatMessage[]>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the message history for a session. Returns an empty array (not
 * `undefined`) for an unknown `sessionId` — the caller treats an empty history
 * as a fresh conversation (DS-5 failure behavior).
 *
 * The returned array is the live internal array; do not mutate it directly —
 * use `appendTurn` so future `getHistory` calls stay consistent.
 */
export function getHistory(sessionId: string): ChatMessage[] {
  return store.get(sessionId) ?? [];
}

/**
 * Appends one turn to the session history. Creates the session entry on first
 * use. Does NOT auto-trim; call `trim` before passing history to `runOak`
 * when you want to enforce the context budget.
 */
export function appendTurn(sessionId: string, message: ChatMessage): void {
  let history = store.get(sessionId);
  if (!history) {
    history = [];
    store.set(sessionId, history);
  }
  history.push(message);
}

// ---------------------------------------------------------------------------
// Context-budget helpers
// ---------------------------------------------------------------------------

/**
 * Estimates the token count for an array of messages using the
 * `CHARS_PER_TOKEN` heuristic. Includes the role string in the character
 * count to be consistent. Over-estimates slightly (safe: we trim earlier
 * rather than later).
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length + msg.role.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Pure context-budget trim: returns a copy of `messages` with the oldest turns
 * dropped from the front until the estimated token count falls at or below
 * `budgetTokens`. The input is not mutated. Shared by both the guest in-memory
 * path (via {@link trim}) and the signed-in DB path (chat-history, BR-H5) so
 * both apply identical trimming.
 *
 * - If `budgetTokens` is omitted, `DEFAULT_HISTORY_TOKEN_BUDGET` is used.
 * - Returns `messages` unchanged when empty or already within budget.
 * - When even a single message exceeds the budget, all messages are dropped
 *   (returns `[]`); the next turn starts from a clean slate.
 */
export function trimMessages(
  messages: ChatMessage[],
  budgetTokens: number = DEFAULT_HISTORY_TOKEN_BUDGET,
): ChatMessage[] {
  const result = [...messages];
  while (result.length > 0 && estimateTokens(result) > budgetTokens) {
    result.shift(); // drop the oldest turn
  }
  return result;
}

/**
 * Removes the oldest turns from the session history until the estimated token
 * count falls at or below `budgetTokens`. Individual messages are dropped one
 * at a time from the front of the array; this preserves the most-recent
 * context (the active topic, the last candidate set) and discards the oldest
 * context first — consistent with how long-context LLM conversations are
 * typically pruned.
 *
 * Delegates the budget logic to {@link trimMessages}, then splices the live
 * stored array in place so `getHistory`'s "returned array is live" contract
 * still holds.
 *
 * - If `budgetTokens` is omitted, `DEFAULT_HISTORY_TOKEN_BUDGET` is used.
 * - No-op when the session does not exist, is empty, or is already within
 *   budget.
 * - When even a single message exceeds the budget (e.g. an extremely long
 *   assistant turn + a tiny budget), all messages are removed; the next user
 *   turn starts from a clean slate.
 */
export function trim(
  sessionId: string,
  budgetTokens: number = DEFAULT_HISTORY_TOKEN_BUDGET,
): void {
  const history = store.get(sessionId);
  if (!history || history.length === 0) return;

  // trimMessages only ever drops from the front, so the number kept equals the
  // tail of `history`; splice the dropped prefix off the live array in place.
  const dropCount = history.length - trimMessages(history, budgetTokens).length;
  if (dropCount > 0) history.splice(0, dropCount);
}

// ---------------------------------------------------------------------------
// Housekeeping helpers (used by tests and the route handler)
// ---------------------------------------------------------------------------

/**
 * Removes all history for the given session. The session will be treated as
 * new (no entry in the store) until the next `appendTurn`.
 */
export function clearSession(sessionId: string): void {
  store.delete(sessionId);
}

/**
 * Returns the number of active sessions currently held in memory. Useful for
 * diagnostics and tests.
 */
export function activeSessionCount(): number {
  return store.size;
}
