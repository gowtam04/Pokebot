# Chat History — Technical Design

## Overview

Mode: PM
Budget Tier: hobby

This design makes a **signed-in user's conversations durable and cross-device**.
Today two parallel, ephemeral histories exist: the client (`src/app/page.tsx`)
holds rich `turns[]` (each assistant turn is a full `OakAnswer`), while the
server's in-memory `session-store` holds text-only `{role, content}` pairs keyed
by the client `session_id` for re-feeding the model. Both evaporate on
restart/device-switch. This feature persists conversations to Postgres, scoped
to the account established by **B-1 (Account Creation)**, while leaving the guest
experience and the agent/SSE path untouched.

The central, unifying idea: **the client `session_id` *is* the conversation id.**
It is already the stable, client-owned conversation handle carried on every chat
request, so reusing it makes resume, "new chat", and guest→sign-in continuity
fall out almost for free — and it keeps the agent, the 11-tool contract, and the
SSE contract unchanged (extends account-creation's AD-2, "identity ≠
conversation").

Key approach summary:
- **Two new tables**, `conversation` and `conversation_message` (one row per
  turn, the full `OakAnswer` stored as a JSON TEXT `answer_json` column —
  mirroring the existing `reference_cache.payload` convention). Not
  format-scoped; scoped by `account_id` (BR-H1 / BR-A9).
- **Server-authoritative persistence.** The chat route already resolves the
  account and already records the turn pair on success; for signed-in users that
  write becomes a durable DB write (full `OakAnswer`), and the model-context
  history is read back from the DB. Guests keep the in-memory store, byte-identical.
- **One client-side exception:** at the guest→sign-in moment the full-fidelity
  turns live only on the client, so a dedicated **idempotent import endpoint**
  bulk-saves the on-screen conversation into the new account (BR-H10).
- **Format is fixed per conversation (BR-H6):** a resumed conversation's `mode`
  is derived from its stored `format`, not from the request body.
- **Titles from the first message** (no LLM call), **ILIKE search**, **no
  retention cap** — all right-sized to the hobby tier.

## Requirements Reference

- Business requirements: `docs/features/chat-history/requirements/requirements.md`
  (HIST-US-1..12, BR-H1..11, AC-*).
- Refines backlog item **B-3** (`docs/backlog.md`); builds on **B-1 — Account
  Creation** (`docs/features/account-creation/`), reusing its `account` /
  `auth_session` tables, `getCurrentAccount()`, and the `@/data/db` singleton +
  repo conventions.
- **No `agent-design/` pass needed** — this feature does not touch agent
  internals, the 11-tool contract, prompts, or the `OakAnswer` output schema.
  Resuming a thread re-feeds prior turns through the **existing** `history`
  parameter of `runOak`, subject to the existing context-budget trimming, so
  the prompt-cached prefix and `MAX_ITERATIONS` behavior are unchanged (BR-H5).

## Tech Stack

Existing stack unchanged: TypeScript (strict, ESM, `@/`→`src/`), Next.js 15 App
Router, Drizzle ORM + node-postgres, Zod, pino, Vitest (node + jsdom projects).

- **No new dependencies.** Search is Postgres `ILIKE` (the codebase's existing
  case-insensitive convention). Transactions use Drizzle's `db.transaction(...)`.
  JSON serialization is `JSON.stringify`/`parse` over a TEXT column (as
  `reference_cache.payload` already does).
- **No new env vars, no new infra.** Reuses the running Postgres; one new
  migration (`drizzle/0002_*.sql`).

## Data Model

Two new tables in `src/data/schema.ts`. Like the auth tables (and unlike the
Pokédex index tables) they are **not format-scoped** — `format` is a property of
each conversation, not a partition of the whole store. Columns are snake_case;
epoch-ms timestamps are `bigint` with `mode: "number"`; booleans are `integer`
0/1 (matching the existing `is_gen9_native` convention). Foreign keys are
**logical, indexed columns — not physical FK constraints** (matching the schema's
existing convention, e.g. `auth_session.account_id`, `learnset.pokemon_id`);
referential integrity is enforced in the repo layer.

### `conversation` — one row per saved conversation

| column       | type             | notes                                                              |
|--------------|------------------|--------------------------------------------------------------------|
| `id`         | text PK          | UUID = the client `session_id` for this conversation (HIST-AD-1)   |
| `account_id` | text NOT NULL    | logical FK → `account.id`; every query filters by it (BR-H1)       |
| `title`      | text NOT NULL    | derived from the first user message; renamable (BR-H7)             |
| `format`     | text NOT NULL    | `"scarlet-violet"` \| `"champions"`; fixed for life (BR-H6)        |
| `pinned`     | integer NOT NULL | 0/1; default 0 (BR-H9 / HIST-US-9)                                  |
| `created_at` | bigint NOT NULL  | epoch ms                                                           |
| `updated_at` | bigint NOT NULL  | epoch ms; last activity — drives list ordering                     |

Indexes:
- PK on `id`.
- `conversation_account_updated_idx` on `(account_id, updated_at)` — backs the
  per-account list query (`ORDER BY pinned DESC, updated_at DESC`).

### `conversation_message` — one row per turn

| column            | type             | notes                                                                       |
|-------------------|------------------|-----------------------------------------------------------------------------|
| `id`              | text PK          | UUID = the client `ChatTurn.id` (makes import idempotent via ON CONFLICT)    |
| `conversation_id` | text NOT NULL    | logical FK → `conversation.id`                                               |
| `account_id`      | text NOT NULL    | denormalized for isolation-safe queries + delete (BR-H1)                     |
| `seq`             | integer NOT NULL | monotonic order within the conversation (0,1,2,…)                            |
| `role`            | text NOT NULL    | `"user"` \| `"assistant"`                                                    |
| `text_content`    | text NOT NULL    | human-visible text: user message, or assistant `answer_markdown` — powers search (BR-H11) + model re-feed (BR-H5) |
| `answer_json`     | text             | full `OakAnswer` JSON (assistant rows only; NULL for user) — powers full re-render (BR-H3) |
| `created_at`      | bigint NOT NULL  | epoch ms                                                                     |

Indexes:
- PK on `id`.
- `message_conversation_seq_idx` on `(conversation_id, seq)` — ordered load.
- `message_account_idx` on `(account_id)` — isolation/cleanup queries.

`text_content` is intentionally denormalized out of `answer_json` so search is a
plain `ILIKE` over a column (no JSON probing, and it never matches JSON keys) and
the model-history derivation needs no parse for the text it feeds.

### ERD sketch

```
account 1 ──── * conversation        (conversation.account_id → account.id)
conversation 1 ──── * conversation_message
                     (message.conversation_id → conversation.id;
                      message.account_id denormalized for isolation + delete)
```

There is **no physical FK or ON DELETE CASCADE** — `deleteConversation` removes
the message rows then the conversation row in one transaction (BR-H8),
consistent with the schema's logical-FK convention.

## Component Design

DB access lives in one repo (the "repos are the sole Postgres readers" rule);
like `accounts-repo.ts` / `resolve-index.ts` it reads the `@/data/db` **singleton**
directly (`server-only`, never imported by the `tsx` ingest/eval/migrate scripts).

- **`conversation-repo` (`src/data/repos/conversation-repo.ts`)** — async
  Postgres reads/writes for both tables; sole DB reader for chat history. Owns
  the transactional writes (`appendTurnPair`, `importConversation`,
  `deleteConversation`). Every method takes `accountId` and filters by it (BR-H1).
  No HTTP/business logic.
- **`derive-title` (`src/server/history/derive-title.ts`)** — pure
  `deriveTitle(firstUserMessage)`: trim, collapse whitespace, truncate to ~60
  chars with an ellipsis, fall back to `"New conversation"` when empty (BR-H7).
- **`session-store` (`src/server/session-store.ts`, modified)** — extract the
  existing trim logic into a pure `trimMessages(messages, budget?): ChatMessage[]`
  so both the guest in-memory path and the signed-in DB path share identical
  context-budget trimming (BR-H5). The existing `trim(sessionId)` is rewritten to
  call it; guest behavior is unchanged.
- **Conversation API routes (`src/app/api/conversations/*`)** — thin HTTP
  adapters over the repo; resolve the account via `getCurrentAccount()`.
- **`chat/route.ts` (modified)** — the persistence seam. For signed-in users:
  read model-history from the repo (not the in-memory store), derive `mode` from
  the stored conversation's `format`, and persist the turn pair on success.
  Guests: in-memory store, unchanged.
- **Frontend (`src/components/history/*`, `src/lib/history-client.ts`,
  `src/lib/use-conversations.ts`)** — the conversation sidebar, its row, the
  fetch helpers, and the list-state hook. `page.tsx` wires them in.

## API Design

All routes are `runtime = "nodejs"`, return plain JSON, and resolve identity via
`getCurrentAccount()`. They reuse the existing JSON-error helper style (a small
`{ code, message }` envelope; the chat route's `jsonError` / auth `_lib/http.ts`).
**Isolation rule (BR-H1):** every read/write filters by the resolved
`account.id`; a conversation that exists but belongs to another account is
indistinguishable from a missing one (**404**, never 403 — no existence leak).
Guests (`account === null`) get an **empty list** from the list route and **401
`unauthorized`** from the per-conversation and import routes.

### `GET /api/conversations`
- Query: `?q=<search>&format=<scarlet-violet|champions>` (both optional).
- Signed in → **200** `{ conversations: ConversationSummary[] }`, ordered pinned
  first then most-recently-active. `q` filters by title OR message text (BR-H11);
  `format` filters by format (HIST-US-10, HIST-US-11).
- Guest → **200** `{ conversations: [] }` (graceful, mirrors `fetchMe`).

### `GET /api/conversations/[id]`
- Signed in & owns it → **200** `{ id, title, format, pinned, turns: ChatTurn[] }`
  (turns ordered by `seq`, full fidelity — assistant rows rehydrated from
  `answer_json`) (HIST-US-4, AC-4.1, AC-4.2).
- Not found / not owner → **404** `not_found`. Guest → **401**.

### `PATCH /api/conversations/[id]`
- Body: `{ title?: string }` (rename, BR-H7) and/or `{ pinned?: boolean }`
  (HIST-US-9). Validates a non-empty, length-capped title.
- Signed in & owns it → **200** `{ ok: true }`. Not owner → **404**. Guest → **401**.

### `DELETE /api/conversations/[id]`
- Permanent, transactional delete of the conversation + its messages (BR-H8);
  idempotent (deleting an absent/again-deleted id still **200**). Not owner →
  **404** (no-op disguised as not-found). Guest → **401**. (AC-8.1.)

### `POST /api/conversations/import`
- Body: `{ session_id: string, champions_mode: boolean, turns: ChatTurn[] }` —
  the guest→sign-in bulk save (HIST-US-12, BR-H10).
- Validates each assistant turn's `answer` against `oakAnswerSchema`
  (`src/agent/schemas.ts`); malformed → **400** `invalid_turns`.
- Empty `turns` → **200** `{ id: null }`, creates nothing (AC-12.2).
- Else upserts the conversation (id = `session_id`, title from first user
  message, format from `champions_mode`) and inserts the message rows
  **idempotently** (`ON CONFLICT (id) DO NOTHING`, keyed by the stable client
  turn ids) → **200** `{ id }`. Signed in only; guest → **401**.

### `POST /api/chat` (modified)
The orchestration guardrails (input cap, tiered rate limit) and the SSE contract
are **unchanged**. Two changes, both gated on `account !== null`:

1. **History source (before opening the stream).**
   - Signed in: load the conversation (`conversation-repo.getConversation`) and
     its messages; derive `history: ChatMessage[]` from the stored turns
     (user → `text_content`; assistant → `text_content`, i.e. the prior
     `answer_markdown`), then `trimMessages(...)`. If the conversation exists,
     **override `mode` from its stored `format`** (BR-H6).
   - Guest: `trim(session_id)` + `getHistory(session_id)` exactly as today.
2. **Persist on success (after the terminal `answer`, off the SSE critical path;
   skipped when `req.signal.aborted`).**
   - Signed in: `conversation-repo.appendTurnPair(...)` — upsert the conversation
     (create with derived title + format on the first turn, else bump
     `updated_at`) and insert the user row + the assistant row (full
     `OakAnswer` in `answer_json`) in one transaction, computing the next
     `seq` (BR-H2).
   - Guest: `appendTurn` to the in-memory store, exactly as today.

An aborted/quick-stopped turn persists nothing (the existing
`if (req.signal.aborted) return;` guard runs before persistence), so an empty
"new chat" never creates a DB row (AC-1.2, AC-12.2 parity).

## File Structure

```
src/
├── data/
│   ├── schema.ts                         — MODIFY: add conversation, conversation_message tables
│   └── repos/
│       └── conversation-repo.ts          — NEW: sole reader/writer for the 2 history tables
│                                            (imports @/data/db singleton, like accounts-repo.ts;
│                                             transactional appendTurnPair/import/delete)
├── server/
│   ├── session-store.ts                  — MODIFY: extract pure trimMessages(messages, budget?)
│   └── history/
│       └── derive-title.ts               — NEW: deriveTitle(firstUserMessage) pure helper
├── app/
│   ├── api/
│   │   ├── conversations/
│   │   │   ├── route.ts                  — NEW: GET list (q, format)
│   │   │   ├── [id]/route.ts             — NEW: GET full / PATCH rename|pin / DELETE
│   │   │   └── import/route.ts           — NEW: POST guest→sign-in idempotent bulk import
│   │   └── chat/route.ts                 — MODIFY: auth-branch history source; persist on success; mode-from-format
│   └── page.tsx                          — MODIFY: sidebar, open/new/import-on-signin/refresh/delete-open
├── components/
│   └── history/
│       ├── ConversationList.tsx          — NEW: New-chat + search + format filter + pinned/recent groups + empty/no-results states
│       └── ConversationRow.tsx           — NEW: row — title, format badge, relative time, rename(inline)/pin/delete
└── lib/
    ├── history-client.ts                 — NEW: typed fetch helpers over /api/conversations/* (never throw)
    └── use-conversations.ts              — NEW: hook — list state, search/filter, rename/pin/delete, refresh

drizzle/
└── 0002_*.sql                            — NEW: generated migration for the 2 tables

Tests (co-located, existing infixes):
  src/data/repos/conversation-repo.test.ts            (oracle vs Testcontainers schema)
  src/server/history/derive-title.test.ts             (pure unit)
  src/server/session-store.test.ts                    (MODIFY: trimMessages extraction)
  src/app/api/conversations/conversations.integration.test.ts (full HTTP flow + isolation)
  src/app/api/chat/route.test.ts                      (MODIFY: signed-in persist + resume; guest unchanged)
  src/components/history/ConversationList.test.tsx     (jsdom, mocked fetch)
  src/components/history/ConversationRow.test.tsx      (jsdom)
  src/lib/use-conversations.test.ts                    (jsdom, mocked fetch)
  src/app/page.fullstack.test.tsx                      (MODIFY/NEW: open/new/import/delete-open flows)
```

## Interface Definitions

Biased to high detail at the seams (an agent team may build this and can't ask
back). All repo methods are async, take `accountId`, and filter by it. The repo
never throws in-domain (a genuine DB fault propagates as a transport error, as
elsewhere).

### `src/data/repos/conversation-repo.ts`
```ts
import type { ChatTurn } from "@/components/types";   // { UserTurn | AssistantTurn }
import type { OakAnswer } from "@/agent/schemas";
import type { AgentMode } from "@/agent/types";

export interface Conversation {
  id: string; accountId: string; title: string;
  format: string;            // "scarlet-violet" | "champions"
  pinned: boolean; createdAt: number; updatedAt: number;
}
export interface ConversationSummary {     // list view — no turns
  id: string; title: string; format: string; pinned: boolean; updatedAt: number;
}
export interface StoredTurn {
  id: string; role: "user" | "assistant"; seq: number;
  textContent: string; answerJson: string | null; createdAt: number;
}

// List, ordered pinned DESC, updated_at DESC. q → ILIKE over title OR any
// message.text_content; format → exact match. Both optional.
export function listConversations(
  accountId: string,
  opts?: { q?: string; format?: string },
): Promise<ConversationSummary[]>;

export function getConversation(accountId: string, id: string): Promise<Conversation | null>;
export function getMessages(accountId: string, conversationId: string): Promise<StoredTurn[]>;

// Upsert conversation (create with derived title+format on first turn, else bump
// updated_at) + insert the user and assistant rows; computes next seq. One tx.
export function appendTurnPair(args: {
  accountId: string; conversationId: string; format: string;
  userTurnId: string; userMessage: string;
  assistantTurnId: string; answer: OakAnswer;
  now: number;
}): Promise<void>;

// Idempotent bulk save (guest→sign-in). Upserts the conversation, inserts rows
// ON CONFLICT (id) DO NOTHING. Returns null for an empty turns[] (creates nothing).
export function importConversation(args: {
  accountId: string; id: string; format: string;
  turns: ChatTurn[]; now: number;
}): Promise<string | null>;

export function renameConversation(accountId: string, id: string, title: string): Promise<void>;
export function setPinned(accountId: string, id: string, pinned: boolean): Promise<void>;
export function deleteConversation(accountId: string, id: string): Promise<void>; // tx: messages then conversation
```
Callers pass already-resolved `accountId`. Mapping helpers (mode↔format) reuse
`src/data/formats.ts`.

### `src/server/history/derive-title.ts`
```ts
export const TITLE_MAX_LEN = 60;
// Trim, collapse internal whitespace, truncate to TITLE_MAX_LEN (+ "…"),
// fall back to "New conversation" when the message is empty/whitespace.
export function deriveTitle(firstUserMessage: string): string;
```

### `src/server/session-store.ts` (added export)
```ts
// Pure: drop oldest ChatMessages until estimateTokens(...) <= budget. The
// existing trim(sessionId) is rewritten to delegate to this; guest behavior
// (and DEFAULT_HISTORY_TOKEN_BUDGET) unchanged.
export function trimMessages(
  messages: ChatMessage[],
  budgetTokens?: number,
): ChatMessage[];
```

### `src/lib/history-client.ts`
Helpers NEVER throw — a transport failure folds into the result (mirrors
`auth-client.ts`). The session cookie is sent automatically (same-origin).
```ts
import type { ChatTurn } from "@/components/types";
export interface ConversationSummary { id: string; title: string; format: string; pinned: boolean; updatedAt: number; }
export interface ConversationDetail { id: string; title: string; format: string; pinned: boolean; turns: ChatTurn[]; }

export function listConversations(opts?: { q?: string; format?: string }): Promise<ConversationSummary[]>;
export function getConversation(id: string): Promise<ConversationDetail | null>;
export function renameConversation(id: string, title: string): Promise<boolean>;
export function setPinned(id: string, pinned: boolean): Promise<boolean>;
export function deleteConversation(id: string): Promise<boolean>;
export function importConversation(sessionId: string, championsMode: boolean, turns: ChatTurn[]): Promise<string | null>;
```

### `src/lib/use-conversations.ts`
```ts
export interface UseConversationsResult {
  conversations: ConversationSummary[];
  query: string; setQuery: (q: string) => void;          // debounced → re-list
  formatFilter: string | null; setFormatFilter: (f: string | null) => void;
  refresh: () => void;                                    // re-list (call after a completed signed-in turn)
  rename: (id: string, title: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  enabled: boolean;                                       // false for guests → list stays empty, no fetch
}
export function useConversations(enabled: boolean): UseConversationsResult;
```

### Frontend component props (`src/components/history/*`)
```ts
export interface ConversationListProps {
  conversations: ConversationSummary[];
  activeId: string | null;                 // current on-screen conversation (highlight)
  query: string; onQueryChange: (q: string) => void;
  formatFilter: string | null; onFormatFilterChange: (f: string | null) => void;
  onNewChat: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;          // component owns the confirm step (AC-8.1)
}
export interface ConversationRowProps {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void; onRename: (title: string) => void;
  onPin: (pinned: boolean) => void; onDelete: () => void;
}
```

### `page.tsx` wiring (behavioral contract)
- **New chat:** `setSessionId(makeId()); setTurns([])` — no DB row until the first
  successful turn (AC-6.1).
- **Open conversation `id`:** `getConversation(id)` → `setSessionId(id)`,
  `setTurns(detail.turns)`, set `championsMode = detail.format === "champions"`
  (AC-4.2, AC-5.4). The composer now continues that conversation.
- **On sign-in (`handleSignedIn`, extended):** keep `sessionId`/`turns`
  (BR-A10); if `turns.length > 0`, `importConversation(sessionId, championsMode,
  turns)` (BR-H10, AC-12.1); then load the list. Empty thread imports nothing
  (AC-12.2).
- **After a completed turn while signed in:** `refresh()` the list so a new
  conversation appears with its derived title / a continued one re-sorts to top.
- **On delete of the currently-open conversation:** reset to a new empty chat
  (AC-8.2).
- **On sign-out:** revert to guest; clear the list; leave `sessionId`/`turns`
  on screen (BR-A10 parity). Future turns won't persist (guest).

## Implementation Phases

Granular, build-order. Per-phase tests gate before the next phase. "Parallel"
notes call out independent work.

### Phase 1 — Data model & migration
- **Build:** add `conversation`, `conversation_message` to `src/data/schema.ts`;
  `npm run db:generate` → `drizzle/0002_*.sql`.
- **Depends on:** nothing.
- **Produces:** the two tables + Drizzle bindings; migration applies via
  `npm run db:migrate`.
- **Parallel:** with the pure helpers in Phase 2 (`derive-title`).
- **Test focus:** migration applies cleanly to a fresh Testcontainers DB; table
  shapes; PK on `id`; indexes `(account_id, updated_at)` and `(conversation_id, seq)`.
- **Requirement refs:** BR-H1, BR-H3, BR-H4, BR-H6.

### Phase 2 — Conversation repo + helpers
- **Build:** `conversation-repo.ts` (all reads/writes, transactions);
  `derive-title.ts`; extract `trimMessages` in `session-store.ts`.
- **Depends on:** Phase 1.
- **Produces:** the durable conversation API + title derivation + shared trimming.
- **Parallel:** `derive-title.ts` and the `trimMessages` extraction are
  independent of the repo and can be built alongside it.
- **Test focus (oracle vs Testcontainers):** `appendTurnPair` creates a
  conversation with the derived title + format on the first turn and computes
  `seq` monotonically on later turns; `listConversations` orders pinned-first
  then `updated_at`, and `q`/`format` filter correctly (title hit + message-text
  hit); `getConversation`/`getMessages` are **account-scoped** (another account
  gets `null`/`[]` — BR-H1); `importConversation` is idempotent (re-import =
  no-op) and returns `null` for empty turns; `deleteConversation` removes
  messages + conversation; `rename`/`setPinned` persist; `trimMessages` matches
  the old `trim` behavior.
- **Requirement refs:** BR-H1, BR-H2, BR-H5, BR-H7, BR-H8, BR-H9, BR-H11,
  HIST-US-12.

### Phase 3 — Conversation API routes
- **Build:** `conversations/route.ts` (GET list), `conversations/[id]/route.ts`
  (GET/PATCH/DELETE), `conversations/import/route.ts` (POST).
- **Depends on:** Phase 2.
- **Produces:** the public `/api/conversations/*` surface.
- **Parallel:** the list / [id] / import handlers are independent.
- **Test focus (integration):** list (q + format); get full conversation
  (turns round-trip, assistant `answer` rehydrated); rename + pin via PATCH;
  permanent delete; **isolation** — another account's id returns 404 on
  GET/PATCH/DELETE; **guest** — empty list, 401 elsewhere; import validates
  `oakAnswerSchema` (400 on malformed) and is idempotent.
- **Requirement refs:** HIST-US-2, HIST-US-3, HIST-US-7..12, AC-2.2, AC-4.1,
  AC-4.2, AC-8.1, BR-H1, BR-H3, BR-H8, BR-H10, BR-H11.

### Phase 4 — Chat route persistence
- **Build:** modify `chat/route.ts` — auth-branch the history source (DB for
  signed-in, in-memory for guest), derive `mode` from stored `format`, persist
  the turn pair on success.
- **Depends on:** Phase 2 (repo). (Independent of Phase 3 — parallel with it.)
- **Produces:** durable, account-scoped chat persistence + cross-device resume
  memory.
- **Parallel:** with Phase 3 (both consume Phase 2).
- **Test focus:** a signed-in turn creates the conversation (title from message,
  format from mode) and stores the full `OakAnswer`; a follow-up feeds the
  **DB-derived, trimmed** history to the model and continues the same
  conversation (`seq` continues); a resumed conversation's mode follows its
  stored `format` (BR-H6); the **guest path is byte-identical** (in-memory store,
  SSE contract, input cap, `session_id`); an aborted turn persists nothing.
- **Requirement refs:** HIST-US-1, HIST-US-5, AC-1.1, AC-1.2, AC-5.1, AC-5.2,
  AC-5.3, AC-5.4, BR-H2, BR-H5, BR-H6.

### Phase 5 — History client + hook
- **Build:** `history-client.ts`, `use-conversations.ts`.
- **Depends on:** Phase 3.
- **Produces:** the typed, never-throwing client surface + list-state hook.
- **Parallel:** the hook builds against the client helpers.
- **Test focus (jsdom, mocked fetch — no db/repos imports):** helpers map
  success/error/transport-failure; the hook lists, debounces search, applies the
  format filter, performs rename/pin/delete optimistically + `refresh`, and stays
  empty + makes no fetch when `enabled === false` (guest).
- **Requirement refs:** HIST-US-2, HIST-US-3, HIST-US-7..11, AC-1.3.

### Phase 6 — Conversation list UI
- **Build:** `ConversationList.tsx`, `ConversationRow.tsx`.
- **Depends on:** Phase 5.
- **Produces:** the history sidebar.
- **Parallel:** list and row can be built in parallel against the prop contract.
- **Test focus (jsdom):** renders pinned + recent groups with format badges and
  relative times; New-chat button; search input + format filter wired to
  callbacks; row rename (inline)/pin/delete with a delete confirm; empty-state
  and no-search-results state; active-row highlight.
- **Requirement refs:** HIST-US-3, HIST-US-6..11, AC-3.1, AC-3.2, AC-8.1,
  AC-10.2, AC-11.1, AC-11.2, UI/UX Vision.

### Phase 7 — Page wiring
- **Build:** modify `page.tsx` — render `ConversationList` (signed-in only),
  own `activeId`/open/new, import-on-sign-in, refresh-after-turn, delete-open
  handling, format-follows-conversation.
- **Depends on:** Phase 6, Phase 4.
- **Produces:** the end-to-end history experience.
- **Test focus (fullstack jsdom, mocked fetch/SSE):** open loads turns and
  switches the active conversation; New chat resets to an empty thread; sign-in
  imports the on-screen thread and it appears in the list; sign-out hides the
  list but keeps the thread; opening a champions conversation sets the toggle;
  deleting the open conversation resets to a new chat.
- **Requirement refs:** HIST-US-2, HIST-US-4, HIST-US-5, HIST-US-6, HIST-US-12,
  AC-4.2, AC-5.4, AC-6.1, AC-8.2, AC-12.1, AC-12.2, BR-H10.

### Phase 8 — Integration & edge cases
- **Build:** end-to-end signed-in lifecycle checks; cross-device simulation
  (a fresh client with the same session cookie loads the list/turns); docs
  reconcile (mark B-3 in `docs/backlog.md`, add an architecture pointer).
- **Depends on:** all prior.
- **Test focus (fullstack):** full lifecycle — guest chats → signs in (thread
  imported, appears in list) → continues (memory across the resume) → renames →
  pins → searches → deletes (permanent); isolation holds end-to-end; no per-turn
  persistence on the guest path.
- **Requirement refs:** HIST-US-1, HIST-US-2, HIST-US-4, HIST-US-5, HIST-US-8,
  BR-H1, BR-H2, BR-H8.

### Integration checkpoints
- **After Phase 4 — `history-backend-e2e`:** against a real Testcontainers DB —
  a signed-in chat turn persists → `GET /api/conversations/[id]` returns the
  full-fidelity turns → a follow-up re-feeds the DB-derived history → another
  account cannot read it. Verifies the persistence + resume + isolation seam
  before any UI exists.
- **After Phase 7 — `history-ui-e2e`:** browser-level — guest conversation
  imported on sign-in and visible in the list; open/continue/rename/pin/
  search/delete; format follows the opened conversation.

## Build Manifest

```yaml
commands:
  test: "npm test"                 # vitest run (node + jsdom); node project NEEDS Docker (Testcontainers)
  test_one: "npx vitest run"       # append a file path or -t <name>
  typecheck: "npm run typecheck"   # tsc --noEmit
  build: "npm run build"           # next build
phases:
  - id: p1
    name: Data model & migration
    depends_on: []
    owns: ["drizzle/0002_*.sql"]
    shared: ["src/data/schema.ts"]
    requirement_refs: [BR-H1, BR-H3, BR-H4, BR-H6]
    test_focus: "migration applies; table shapes; PK(id); idx(account_id,updated_at), idx(conversation_id,seq)"
  - id: p2
    name: Conversation repo + helpers
    depends_on: [p1]
    owns:
      - "src/data/repos/conversation-repo.ts"
      - "src/server/history/derive-title.ts"
    shared: ["src/server/session-store.ts"]
    requirement_refs: [BR-H1, BR-H2, BR-H5, BR-H7, BR-H8, BR-H9, BR-H11, HIST-US-12]
    test_focus: "append/seq; list order+filters; account isolation; import idempotency; delete; trimMessages parity"
  - id: p3
    name: Conversation API routes
    depends_on: [p2]
    owns: ["src/app/api/conversations/**"]
    shared: []
    requirement_refs: [HIST-US-2, HIST-US-3, HIST-US-7, HIST-US-8, HIST-US-9, HIST-US-10, HIST-US-11, HIST-US-12, AC-2.2, AC-4.1, AC-4.2, AC-8.1, BR-H1, BR-H8, BR-H10, BR-H11]
    test_focus: "list q+format; get round-trip; rename/pin; delete; isolation 404; guest 401/empty; import validation+idempotency"
  - id: p4
    name: Chat route persistence
    depends_on: [p2]
    owns: []
    shared: ["src/app/api/chat/route.ts"]
    requirement_refs: [HIST-US-1, HIST-US-5, AC-1.1, AC-1.2, AC-5.1, AC-5.3, AC-5.4, BR-H2, BR-H5, BR-H6]
    test_focus: "signed-in persist pair + create conv; resume feeds DB history (trimmed); mode from stored format; guest path byte-identical; abort persists nothing"
  - id: p5
    name: History client + hook
    depends_on: [p3]
    owns: ["src/lib/history-client.ts", "src/lib/use-conversations.ts"]
    shared: []
    requirement_refs: [HIST-US-2, HIST-US-3, HIST-US-7, HIST-US-8, HIST-US-9, HIST-US-10, HIST-US-11, AC-1.3]
    test_focus: "helpers map success/error/transport; hook list/search/filter/mutations/refresh; disabled for guests"
  - id: p6
    name: Conversation list UI
    depends_on: [p5]
    owns: ["src/components/history/**"]
    shared: []
    flags: [ui]
    requirement_refs: [HIST-US-3, HIST-US-6, HIST-US-7, HIST-US-8, HIST-US-9, HIST-US-10, HIST-US-11, AC-3.1, AC-3.2, AC-8.1, AC-10.2, AC-11.1, AC-11.2]
    test_focus: "pinned/recent groups; format badge; new-chat; search+filter; row rename/pin/delete+confirm; empty/no-results; active highlight"
  - id: p7
    name: Page wiring
    depends_on: [p6, p4]
    owns: []
    shared: ["src/app/page.tsx"]
    flags: [ui]
    requirement_refs: [HIST-US-2, HIST-US-4, HIST-US-5, HIST-US-6, HIST-US-12, AC-4.2, AC-5.4, AC-6.1, AC-8.2, AC-12.1, AC-12.2, BR-H10]
    test_focus: "open loads turns; new-chat resets; sign-in imports thread; sign-out hides list; format follows conv; delete-open resets"
  - id: p8
    name: Integration & edge cases
    depends_on: [p1, p2, p3, p4, p5, p6, p7]
    owns: ["src/app/api/conversations/conversations.integration.test.ts"]
    shared: ["src/app/page.tsx", "docs/backlog.md"]
    requirement_refs: [HIST-US-1, HIST-US-2, HIST-US-4, HIST-US-5, HIST-US-8, BR-H1, BR-H2, BR-H8]
    test_focus: "full lifecycle guest→signin→continue→rename/pin/search→delete; cross-device load; isolation; no guest persistence"
integration_checkpoints:
  - after: [p4]
    name: history-backend-e2e
    verifies: "signed-in turn persists → GET conversation full-fidelity → resume re-feeds DB history → cross-account isolation, against a real DB"
  - after: [p7]
    name: history-ui-e2e
    verifies: "guest thread imported on sign-in and listed; open/continue/rename/pin/search/delete; format follows opened conversation"
```

> `schema.ts` (p1), `session-store.ts` (p2), `chat/route.ts` (p4), and
> `page.tsx` (p7/p8) are the only files touched across phase boundaries —
> sequence those edits. Everything else is single-owner.

## Technical Decisions

- **HIST-AD-1 — The conversation id *is* the client `session_id`.**
  *Alternatives:* a separate server-minted `conversation_id` threaded through the
  chat body and SSE. *Chosen:* reuse `session_id` as `conversation.id`. *Why:*
  `session_id` is already the stable, client-owned conversation handle on every
  chat request; reusing it makes "new chat" (new id), "open/continue" (set id),
  and guest→sign-in import (same id) trivial, and keeps the chat body, agent
  context, and SSE contract unchanged — extending account-creation's AD-2
  ("identity ≠ conversation"). *Tradeoff:* the id is a client-generated UUID; we
  defend isolation by filtering every query on `account_id` (BR-H1), never on id
  alone.

- **HIST-AD-2 — One row per turn; full `OakAnswer` as a JSON TEXT column.**
  *Alternatives:* a single JSON blob per conversation holding all turns. *Chosen:*
  a normalized `conversation_message` table, one row per turn, with `answer_json`
  TEXT (mirroring `reference_cache.payload`). *Why:* appends never rewrite a
  growing blob and can't clobber a concurrent append; a dedicated `text_content`
  column makes search a plain `ILIKE`; full fidelity is preserved for re-render
  (BR-H3). *Tradeoff:* re-render parses JSON per assistant turn (cheap) and the
  human-visible text is stored twice (in `text_content` and inside `answer_json`)
  — a negligible cost that buys clean search + parse-free model re-feed.

- **HIST-AD-3 — Server-authoritative persistence, with a client import only for
  guest→sign-in.** *Alternatives:* the client POSTs every completed turn to a
  save endpoint. *Chosen:* the chat route persists (it already holds the
  authoritative `OakAnswer` and resolves the account, and already records the
  turn pair on success); the **one** case where the full-fidelity turns live only
  on the client — the guest→sign-in moment — is handled by an idempotent import
  endpoint. *Why:* avoids trusting client-sent answers on the hot path and keeps
  the existing route flow. *Tradeoff:* two write paths; the import path validates
  client turns against `oakAnswerSchema` before storing.

- **HIST-AD-4 — Signed-in history reads from the DB; guests keep the in-memory
  store.** *Alternatives:* keep using the in-memory store for everyone and only
  mirror to the DB. *Chosen:* for signed-in users the DB is the source of truth
  for both the model-context history and re-render; guests are unchanged. *Why:*
  cross-device resume (BR-H2, HIST-US-2) requires durable, shared state that an
  in-memory map can't provide; the resumed conversation's `mode` is derived from
  its stored `format` (BR-H6). *Tradeoff:* one extra indexed read per signed-in
  turn (negligible at this scale on the already-open pool).

- **HIST-AD-5 — Title from the first user message; ILIKE search; no retention
  cap; last-write-wins concurrency.** *Why (all hobby-tier right-sizing):* a
  derived title needs no extra Anthropic call (vs. an LLM summary) and is
  instant + deterministic (BR-H7); `ILIKE` over `title` + `text_content` needs no
  new index or dependency at personal scale (BR-H11; a trigram/FTS index is a
  later upgrade if a user accumulates thousands of conversations); retention is
  indefinite since the per-account chat rate limit already bounds growth (BR-H9);
  and simultaneous edits from two devices/tabs resolve last-write-wins, which is
  acceptable at personal scale (requirements Open Question). *Tradeoffs:* clunky
  titles on verbose first questions (mitigated by rename), `ILIKE` degrades on
  very large histories (no user hits that at this tier), and a rare cross-device
  append interleave is not specially handled.

## Deployment & Infrastructure

Budget tier: **hobby** (~$0/mo target).

Build & test commands (source of truth; mirrored in the Build Manifest):
- `test`: `npm test` (Vitest node + jsdom; **node project needs a Docker daemon**
  for Testcontainers Postgres)
- `test_one`: `npx vitest run <path>` (or `-t "<name>"`)
- `typecheck`: `npm run typecheck`
- `build`: `npm run build`
- `lint`: `npm run lint`

- **Hosting / runtime:** unchanged — the existing Next.js app. No new runtime, no
  new outbound calls.
- **Database hosting:** unchanged — the existing Postgres. One new migration
  (`drizzle/0002_*.sql`); apply with `npm run db:migrate` (or `docker:migrate`).
  **Re-ingest is NOT required** — these tables are not built by the ingest
  pipeline, unlike the Pokédex index tables.
- **Background jobs / queues:** none. No retention sweep (no cap — HIST-AD-5).
- **Object storage / caching:** none.
- **Observability:** existing pino stdout. Log history events
  (conversation created / continued / renamed / pinned / deleted / imported) with
  `request_id` and `account_id`; **never log conversation content**.
- **Secrets:** none new.
- **Environments:** just-prod + local dev, as today.

**Rough monthly cost: ~$0** — reuses infrastructure already in place; storage
growth is bounded by per-account chat volume (text + JSON answers, no media).

## Unresolved from Requirements

Resolved here (the requirements' Open Questions, pinned for this build):
- **Per-account backstop cap (BR-H9):** none — keep forever; rate limits bound
  growth (HIST-AD-5).
- **Auto-title approach (BR-H7):** derived from the first user message, ~60-char
  cap, renamable; no LLM call (HIST-AD-5).
- **Concurrent append across devices:** last-write-wins; not specially handled
  (HIST-AD-5).
- **Search mechanism (BR-H11):** Postgres `ILIKE` over title + message text; FTS
  is a future upgrade.
- **Conversation identity vs. `session_id`:** unified — id = `session_id`
  (HIST-AD-1).
- **Storage shape of `OakAnswer` (BR-H3):** full object as a JSON TEXT
  column per assistant turn (HIST-AD-2).

Still open (non-blocking for the build):
- **Schema evolution of stored answers.** Old `answer_json` must stay
  renderable as `oakAnswerSchema` evolves. Not addressed in v1 (the schema is
  additive today); if a breaking change lands, add a version tag and a lenient
  render path. Flagged for the first such change.
- **Past-turn tool-activity indicator.** Tool-activity is intentionally not
  persisted (BR-H3); whether reopened turns should show "live trace
  unavailable" is a UI nicety, deferred.
- **Pre-sign-in guest threads.** Only the on-screen conversation is captured on
  sign-in; earlier ephemeral guest threads are unrecoverable (by design,
  requirements-confirmed).
