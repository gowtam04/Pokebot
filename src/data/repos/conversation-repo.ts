/**
 * src/data/repos/conversation-repo.ts — the SOLE Postgres reader/writer for
 * durable chat history (docs/features/chat-history § Component Design,
 * § Interface Definitions). Two tables: `conversation` and `conversation_message`.
 *
 * Boundary rules (CLAUDE.md "repos are the sole Postgres readers"; mirrors
 * accounts-repo.ts):
 *   - `import "server-only"` — never bundled to the client.
 *   - Reads the memoized `@/data/db` singleton directly (not a per-request ctx).
 *   - DB columns are snake_case (Drizzle); returned objects are camelCase. The
 *     0/1 `pinned` integer is mapped to a `boolean`. Epoch-ms timestamps are
 *     `bigint` mode "number".
 *
 * Isolation (BR-H1 / BR-A9): EVERY method takes `accountId` and filters by it.
 * The conversation `id` is a client-generated UUID (HIST-AD-1), so it is NEVER
 * trusted alone — a conversation that belongs to another account is
 * indistinguishable from a missing one (`null` / `[]`).
 *
 * Error style: not in-domain Result unions — return `null`/`[]` for a clean
 * miss and let GENUINE faults propagate (a DB error surfaces as a rejected
 * promise, handled at the route/transport seam).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, exists, ilike, or, sql } from "drizzle-orm";

import { db } from "@/data/db";
import { conversation, conversation_message } from "@/data/schema";
import { deriveTitle } from "@/server/history/derive-title";
import type { ChatTurn } from "@/components/types";
import type { PokebotAnswer } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Row shapes (camelCase — § Interface Definitions)
// ---------------------------------------------------------------------------

/** A saved conversation (id = the client session_id, HIST-AD-1). */
export interface Conversation {
  id: string;
  accountId: string;
  title: string;
  format: string; // "scarlet-violet" | "champions"
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * The conversation's active team (BR-T9); `null` = none (AC-8.1). Server-bound
   * onto the agent context like `mode`, never an LLM tool input. Round-trips on
   * append/import and via {@link setActiveTeam}.
   */
  activeTeamId: string | null;
}

/** List-view projection — no turns. */
export interface ConversationSummary {
  id: string;
  title: string;
  format: string;
  pinned: boolean;
  updatedAt: number;
}

/** One stored turn. `answerJson` is the full PokebotAnswer JSON on assistant rows. */
export interface StoredTurn {
  id: string;
  role: "user" | "assistant";
  seq: number;
  textContent: string;
  answerJson: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape LIKE/ILIKE metacharacters so a user-typed `%` or `_` matches literally
 * (Postgres ILIKE's default ESCAPE is backslash). Keeps search a plain substring
 * filter (BR-H11) rather than a wildcard surface.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List an account's conversations, pinned first then most-recently-active
 * (HIST-US-3). `q` filters by title OR any message text (BR-H11); `format`
 * filters by exact format (HIST-US-11). Both optional. Scoped to `accountId`.
 */
export async function listConversations(
  accountId: string,
  opts?: { q?: string; format?: string },
): Promise<ConversationSummary[]> {
  const conditions = [eq(conversation.account_id, accountId)];

  const format = opts?.format?.trim();
  if (format) conditions.push(eq(conversation.format, format));

  const q = opts?.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    // Title hit OR a message-text hit (correlated EXISTS over this
    // conversation's own messages, also account-scoped for isolation).
    const messageHit = exists(
      db
        .select({ one: sql`1` })
        .from(conversation_message)
        .where(
          and(
            eq(conversation_message.conversation_id, conversation.id),
            eq(conversation_message.account_id, accountId),
            ilike(conversation_message.text_content, pattern),
          ),
        ),
    );
    conditions.push(or(ilike(conversation.title, pattern), messageHit)!);
  }

  const rows = await db
    .select({
      id: conversation.id,
      title: conversation.title,
      format: conversation.format,
      pinned: conversation.pinned,
      updatedAt: conversation.updated_at,
    })
    .from(conversation)
    .where(and(...conditions))
    .orderBy(desc(conversation.pinned), desc(conversation.updated_at));

  return rows.map((r) => ({ ...r, pinned: r.pinned === 1 }));
}

/** Get a conversation's metadata, or `null` if missing / not this account's. */
export async function getConversation(
  accountId: string,
  id: string,
): Promise<Conversation | null> {
  const rows = await db
    .select({
      id: conversation.id,
      accountId: conversation.account_id,
      title: conversation.title,
      format: conversation.format,
      pinned: conversation.pinned,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      activeTeamId: conversation.active_team_id,
    })
    .from(conversation)
    .where(and(eq(conversation.account_id, accountId), eq(conversation.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, pinned: row.pinned === 1 } : null;
}

/** Get a conversation's turns in `seq` order, or `[]` if missing / not owned. */
export async function getMessages(
  accountId: string,
  conversationId: string,
): Promise<StoredTurn[]> {
  const rows = await db
    .select({
      id: conversation_message.id,
      role: conversation_message.role,
      seq: conversation_message.seq,
      textContent: conversation_message.text_content,
      answerJson: conversation_message.answer_json,
      createdAt: conversation_message.created_at,
    })
    .from(conversation_message)
    .where(
      and(
        eq(conversation_message.account_id, accountId),
        eq(conversation_message.conversation_id, conversationId),
      ),
    )
    .orderBy(asc(conversation_message.seq));
  return rows.map((r) => ({ ...r, role: r.role as "user" | "assistant" }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Persist one user+assistant turn pair (BR-H2), server-authoritative path.
 *
 * In ONE transaction: lock/create the conversation (create with the derived
 * title + format on the first turn, else bump `updated_at`), compute the next
 * `seq` as `COALESCE(MAX(seq), -1) + 1`, then insert the user row and the
 * assistant row (full `PokebotAnswer` in `answer_json`).
 *
 * NOT idempotent (unlike {@link importConversation}): the chat request carries
 * no client turn ids, so the route mints fresh `userTurnId`/`assistantTurnId`
 * UUIDs. The `SELECT … FOR UPDATE` on the conversation row serializes concurrent
 * appends to the same conversation so `seq` stays monotonic; the UNIQUE
 * (conversation_id, seq) index is the backstop.
 */
export async function appendTurnPair(args: {
  accountId: string;
  conversationId: string;
  format: string;
  userTurnId: string;
  userMessage: string;
  assistantTurnId: string;
  answer: PokebotAnswer;
  now: number;
  /**
   * The active team selected for this turn (BR-T9). `null` = none. When omitted
   * (`undefined`) the stored value is left untouched on a continuation (and
   * defaults to `null` on first-turn creation); when provided it is persisted
   * last-selected-wins (TEAM-US-8).
   */
  activeTeamId?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock this account's conversation row if it exists (serializes appends).
    const existing = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(
        and(
          eq(conversation.account_id, args.accountId),
          eq(conversation.id, args.conversationId),
        ),
      )
      .for("update")
      .limit(1);

    if (existing.length === 0) {
      // First turn → create the conversation. A PK conflict here means the id
      // belongs to another account (astronomically unlikely UUID collision);
      // the transaction aborts rather than touching that row (BR-H1).
      await tx.insert(conversation).values({
        id: args.conversationId,
        account_id: args.accountId,
        title: deriveTitle(args.userMessage),
        format: args.format,
        pinned: 0,
        created_at: args.now,
        updated_at: args.now,
        active_team_id: args.activeTeamId ?? null,
      });
    } else {
      // Continuation → bump last activity (drives list ordering) and, when the
      // turn carried an active-team selection, persist it last-selected-wins.
      const set: { updated_at: number; active_team_id?: string | null } = {
        updated_at: args.now,
      };
      if (args.activeTeamId !== undefined) set.active_team_id = args.activeTeamId;
      await tx
        .update(conversation)
        .set(set)
        .where(
          and(
            eq(conversation.account_id, args.accountId),
            eq(conversation.id, args.conversationId),
          ),
        );
    }

    const seqRows = await tx
      .select({
        next: sql<number>`COALESCE(MAX(${conversation_message.seq}), -1) + 1`.mapWith(
          Number,
        ),
      })
      .from(conversation_message)
      .where(
        and(
          eq(conversation_message.conversation_id, args.conversationId),
          eq(conversation_message.account_id, args.accountId),
        ),
      );
    const baseSeq = seqRows[0]?.next ?? 0;

    await tx.insert(conversation_message).values([
      {
        id: args.userTurnId,
        conversation_id: args.conversationId,
        account_id: args.accountId,
        seq: baseSeq,
        role: "user",
        text_content: args.userMessage,
        answer_json: null,
        created_at: args.now,
      },
      {
        id: args.assistantTurnId,
        conversation_id: args.conversationId,
        account_id: args.accountId,
        seq: baseSeq + 1,
        role: "assistant",
        text_content: args.answer.answer_markdown,
        answer_json: JSON.stringify(args.answer),
        created_at: args.now,
      },
    ]);
  });
}

/**
 * Idempotent bulk save of an on-screen guest conversation at sign-in (HIST-US-12,
 * BR-H10). Upserts the conversation (id = session_id) and inserts the message
 * rows `ON CONFLICT (id) DO NOTHING`, keyed by the stable client turn ids — so a
 * re-import is a no-op. Returns `null` for empty `turns` (creates nothing,
 * AC-12.2); returns the conversation id otherwise. Refuses (returns `null`) if
 * the id already exists under a different account (BR-H1).
 */
export async function importConversation(args: {
  accountId: string;
  id: string;
  format: string;
  turns: ChatTurn[];
  now: number;
  /** The active team selected on-screen at sign-in (BR-T9); `null`/omitted = none. */
  activeTeamId?: string | null;
}): Promise<string | null> {
  if (args.turns.length === 0) return null;

  const firstUser = args.turns.find((t) => t.role === "user");
  const title = deriveTitle(
    firstUser && firstUser.role === "user" ? firstUser.content : "",
  );

  let refused = false;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ accountId: conversation.account_id })
      .from(conversation)
      .where(eq(conversation.id, args.id))
      .for("update")
      .limit(1);
    if (existing[0] && existing[0].accountId !== args.accountId) {
      refused = true; // someone else's conversation — never write into it.
      return;
    }

    await tx
      .insert(conversation)
      .values({
        id: args.id,
        account_id: args.accountId,
        title,
        format: args.format,
        pinned: 0,
        created_at: args.now,
        updated_at: args.now,
        active_team_id: args.activeTeamId ?? null,
      })
      .onConflictDoNothing({ target: conversation.id });

    const rows = args.turns.map((t, i) => ({
      id: t.id,
      conversation_id: args.id,
      account_id: args.accountId,
      seq: i,
      role: t.role,
      text_content:
        t.role === "user" ? t.content : t.answer.answer_markdown,
      answer_json: t.role === "assistant" ? JSON.stringify(t.answer) : null,
      created_at: args.now,
    }));
    await tx
      .insert(conversation_message)
      .values(rows)
      .onConflictDoNothing({ target: conversation_message.id });
  });

  return refused ? null : args.id;
}

/** Rename a conversation (BR-H7). No-op if not this account's (route → 404). */
export async function renameConversation(
  accountId: string,
  id: string,
  title: string,
): Promise<void> {
  await db
    .update(conversation)
    .set({ title })
    .where(and(eq(conversation.account_id, accountId), eq(conversation.id, id)));
}

/**
 * Set (or clear, with `null`) a conversation's active team (TEAM-US-8, AC-8.2) —
 * the PATCH path that sets an active team on an existing conversation without
 * chatting. Account-scoped: a no-op if the conversation is missing / not owned.
 * The caller is responsible for verifying the team is account-owned and
 * format-matching before passing a non-null id (route-side, AC-8.3).
 */
export async function setActiveTeam(
  accountId: string,
  conversationId: string,
  teamId: string | null,
): Promise<void> {
  await db
    .update(conversation)
    .set({ active_team_id: teamId })
    .where(
      and(
        eq(conversation.account_id, accountId),
        eq(conversation.id, conversationId),
      ),
    );
}

/** Pin / unpin a conversation (HIST-US-9). No-op if not this account's. */
export async function setPinned(
  accountId: string,
  id: string,
  pinned: boolean,
): Promise<void> {
  await db
    .update(conversation)
    .set({ pinned: pinned ? 1 : 0 })
    .where(and(eq(conversation.account_id, accountId), eq(conversation.id, id)));
}

/**
 * Permanently delete a conversation and all its messages (BR-H8). Idempotent —
 * deleting an absent / not-owned id is a no-op. Messages then the conversation,
 * in one transaction (no physical FK cascade).
 */
export async function deleteConversation(
  accountId: string,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(conversation_message)
      .where(
        and(
          eq(conversation_message.account_id, accountId),
          eq(conversation_message.conversation_id, id),
        ),
      );
    await tx
      .delete(conversation)
      .where(
        and(eq(conversation.account_id, accountId), eq(conversation.id, id)),
      );
  });
}

/** A fresh server-minted turn id for the append path (not a client turn id). */
export function newTurnId(): string {
  return randomUUID();
}
