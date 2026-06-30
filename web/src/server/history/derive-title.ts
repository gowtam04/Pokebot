/**
 * src/server/history/derive-title.ts — pure title derivation for chat history
 * (docs/features/chat-history § Component Design "derive-title"; BR-H7, HIST-AD-5).
 *
 * A conversation's title is derived from its first user message — no LLM call,
 * so it is instant and deterministic. The user may rename afterwards
 * (renameConversation). This module is pure (no imports, no I/O) so it is safe
 * to use from the repo, the chat route, and tests alike.
 */

/** Maximum title length before truncation (characters of visible text). */
export const TITLE_MAX_LEN = 60;

/** Fallback title when the first message is empty/whitespace-only. */
export const FALLBACK_TITLE = "New conversation";

/**
 * Derive a non-empty, human-readable title from the first user message:
 * trim, collapse internal whitespace runs to single spaces, and truncate to
 * {@link TITLE_MAX_LEN} with an ellipsis. Falls back to {@link FALLBACK_TITLE}
 * for an empty/whitespace-only message (BR-H7: every conversation has a title).
 */
export function deriveTitle(firstUserMessage: string): string {
  const collapsed = firstUserMessage.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return FALLBACK_TITLE;
  if (collapsed.length <= TITLE_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX_LEN).trimEnd()}…`;
}
