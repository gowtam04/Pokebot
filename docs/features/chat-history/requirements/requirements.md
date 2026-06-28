# Chat History — Business Requirements

> Refines backlog item **B-3 — Chat history** (`docs/backlog.md`) into a
> buildable spec. This feature makes a signed-in user's conversations
> **durable and cross-device**: today conversation history lives only in an
> in-memory per-session store (`src/server/session-store.ts`, read/written by
> `src/app/api/chat/route.ts`) and evaporates on server restart or device
> switch. It builds directly on **B-1 — Account Creation** (BUILT — see
> `docs/features/account-creation/requirements/requirements.md`), whose accounts
> provide the identity history attaches to and whose **BR-A9** (strict
> per-account isolation) and **BR-A10** (guest conversation continuity) this
> feature extends.
>
> IDs are stable and addressable downstream (namespaced `HIST-` / `BR-H`).
> Append; never renumber.

## Overview

Oak's answers are the product's point: each carries reasoning, cited
sources, explicit inference/uncertainty flags, and the generation/format it's
based on. Today those answers are disposable — once a conversation scrolls away
or the server restarts, the work is gone, and nothing is visible across devices.

This feature gives **signed-in users** a durable, browsable record of their
conversations and the ability to **resume** them. Every conversation a
signed-in user has is saved automatically, stored with full structural fidelity
(so reopened answers render identically — reasoning, citations, flags, sprites,
tables), and available on any device they sign in on. Reopening a conversation
makes it the live thread again, and the agent remembers the earlier turns so
follow-up refinement keeps working.

**Guests are unchanged.** An anonymous visitor still chats exactly as today,
with an ephemeral in-memory thread that is never persisted server-side. Durable
history is one of the things signing in unlocks (alongside the higher rate
limit from B-1).

### Goals

- Give signed-in users a durable, cross-device record of past conversations —
  with the full reasoning/citations/flags that make Oak's answers
  meaningful, not just plain text.
- Let users resume any past conversation as a live thread, with the agent
  retaining that conversation's earlier context.
- Make saving effortless (automatic) and managing history easy (browse, search,
  rename, pin, filter by format, delete).
- Lose nothing at the guest→sign-in boundary: the conversation a guest already
  has on screen becomes their first saved conversation.
- Keep guest behavior, the agent's internals, the 11-tool contract, the SSE
  streaming contract, and the Champions-mode toggle untouched.

### Success Criteria

- A signed-in user's conversations appear in a history list with no explicit
  save step, and survive server restarts.
- A conversation created on one device is visible and openable, with identical
  rendering, after signing into the same account on a different device.
- Reopening a past conversation and asking a context-dependent follow-up
  produces an answer that reflects that conversation's earlier turns.
- No account can see or open another account's conversations.
- A guest who signs in mid-conversation finds that conversation saved in their
  new history, with its pre-sign-in turns intact.
- A guest who never signs in experiences the chat exactly as before, with no
  history surface and nothing persisted server-side.

## Users and Personas

Personas are inherited from B-1 (`account-creation/requirements.md` §Users and
Personas); this feature differentiates them by what history they get:

- **Guest (anonymous visitor).** Chats with an ephemeral in-memory thread, as
  today. Has **no** server-side history, no history list, and nothing persisted.
  The on-screen thread is preserved into an account only if they sign in
  (HIST-US-11).
- **Registered user (signed in).** Gets durable, automatically-saved,
  cross-device chat history scoped to their account. All registered users are
  peers; there is no admin or cross-account visibility.

There is **no admin/owner role** and no shared or cross-account history.

## User Stories

> Namespaced `HIST-`. IDs are stable; append, never renumber. Acceptance
> criteria are written to be objectively checkable.

### Automatic persistence & cross-device

- **HIST-US-1** — As a signed-in user, I want my conversations saved
  automatically, so that I never lose a thread and never have to remember to
  save.
  - **AC-1.1** — Given I am signed in, when an answer is successfully delivered
    for a turn, then that turn (my message + the assistant's answer) is persisted
    to my account's history with no explicit save action.
  - **AC-1.2** — Given a turn ends in a transport fault or is aborted by Stop
    (client disconnect), then that turn is **not** persisted (consistent with
    the current `route.ts` behavior), and the conversation is left consistent
    for a retry.
  - **AC-1.3** — Given I am a guest (not signed in), when I chat, then nothing is
    persisted server-side, no history list is shown, and the chat behaves exactly
    as it does today (BR-H1).

- **HIST-US-2** — As a signed-in user, I want my history available on any device
  I sign in on, so that my record follows me.
  - **AC-2.1** — Given I created conversation X on device A, when I sign into the
    same account on device B, then conversation X appears in my history on device
    B and opens with the same turns and the same rendered content.
  - **AC-2.2** — Given two different accounts, when either views or searches
    history, then neither can read, open, rename, or delete the other's
    conversations (BR-H1, inherits BR-A9).

### Browse, open, and resume

- **HIST-US-3** — As a signed-in user, I want a list of my past conversations,
  so that I can find and revisit them.
  - **AC-3.1** — Given I have at least one saved conversation, when I open the
    history surface, then I see each conversation showing its title, a format
    badge, and a last-activity indication, ordered most-recently-active first
    (pinned conversations excepted — AC-9.1).
  - **AC-3.2** — Given I have no saved conversations, when I open the history
    surface, then I see a clear empty state rather than an error or blank panel.

- **HIST-US-4** — As a signed-in user, I want to reopen a past conversation and
  see its answers exactly as they were, so that the reasoning and citations are
  still there.
  - **AC-4.1** — Given a saved conversation containing a structured answer with
    reasoning, cited sources, and an inference/uncertainty flag, when I reopen it,
    then those elements render via the normal answer card tree — not a
    plain-text fallback (BR-H3).
  - **AC-4.2** — Given a saved conversation, when I reopen it, then all of its
    turns (my questions and the assistant's answers) are shown in their original
    order.

- **HIST-US-5** — As a signed-in user, I want to continue a past conversation
  and have the agent remember it, so that follow-up refinement still works.
  - **AC-5.1** — Given I reopen a past conversation, when I submit a follow-up,
    then it is appended to that **same** conversation (not a new one) and
    persisted.
  - **AC-5.2** — Given I reopen a conversation about a specific team/Pokémon,
    when I ask a context-dependent follow-up (e.g. "now make it weak to Trick
    Room instead"), then the agent's answer reflects the earlier turns of that
    conversation (BR-H5).
  - **AC-5.3** — Given a very long conversation, when I continue it, then prior
    turns are supplied to the agent within the existing context budget (oldest
    turns trimmed first, as today), and continuation never fails due to length
    (BR-H5).
  - **AC-5.4** — Given I reopen a conversation created in a given format
    (standard vs Champions), when I continue it, then it operates in that same
    format (BR-H6).

- **HIST-US-6** — As a signed-in user, I want to start a fresh conversation, so
  that a new topic doesn't get mixed into an old thread.
  - **AC-6.1** — Given I am viewing or continuing a conversation, when I choose
    "New chat", then a new empty conversation begins and the previous one remains
    saved and unchanged in my history.

### Manage

- **HIST-US-7** — As a signed-in user, I want to rename a conversation, so that I
  can find it later by a meaningful name.
  - **AC-7.1** — Given a new conversation, when its first answer is delivered,
    then it is assigned a non-empty, human-readable title automatically (BR-H7).
  - **AC-7.2** — Given a conversation, when I rename it, then the new title shows
    in the list and persists across reloads and other devices.

- **HIST-US-8** — As a signed-in user, I want to delete a conversation, so that I
  can remove things I no longer want kept.
  - **AC-8.1** — Given a conversation, when I delete it and confirm, then it is
    permanently removed from my history, no longer appears (on any device), and
    cannot be recovered — there is no trash or undo (BR-H8).
  - **AC-8.2** — Given I delete the conversation currently open, then the app
    returns to a safe state (a new empty conversation or the history list), not a
    broken/empty thread view.

- **HIST-US-9** — As a signed-in user, I want to pin important conversations, so
  that they stay easy to reach.
  - **AC-9.1** — Given a conversation, when I pin it, then it appears in a
    pinned/top group above unpinned conversations; when I unpin it, it returns to
    normal most-recent ordering.

- **HIST-US-10** — As a signed-in user, I want to search my history, so that I
  can find a specific conversation among many.
  - **AC-10.1** — Given multiple conversations, when I enter a search term, then
    the list filters to conversations whose **title or message text** matches the
    term, within my own conversations only (BR-H11).
  - **AC-10.2** — Given a search with no matches, when results are shown, then a
    clear "no results" state is presented.

- **HIST-US-11** — As a signed-in user, I want to filter my history by format, so
  that I can focus on standard or Champions conversations.
  - **AC-11.1** — Given any conversation in the list, then it displays a badge
    indicating its format (`scarlet-violet` vs `champions`).
  - **AC-11.2** — Given conversations in both formats, when I filter by a format,
    then the list shows only conversations of that format.

### Guest → sign-in continuity

- **HIST-US-12** — As a guest who signs in mid-conversation, I want the
  conversation already on screen to be saved into my new account, so that I lose
  nothing by signing in.
  - **AC-12.1** — Given I have a non-empty on-screen conversation as a guest,
    when I complete sign-in, then that conversation — including its pre-sign-in
    turns — becomes a saved conversation in my account's history and remains the
    live thread on screen (extends BR-A10, BR-H10).
  - **AC-12.2** — Given my on-screen guest thread is empty (no turns) at sign-in,
    then no empty conversation is created in my history.

## Functional Requirements

### Persistence

- For signed-in users, each successfully delivered turn is auto-persisted: the
  user message and the **full structured `OakAnswer`** for that turn
  (BR-H2, BR-H3). Turns that fail with a transport fault or are aborted are not
  persisted (AC-1.2).
- Persistence must not block or delay the streamed answer to the user — writing
  history happens around/after answer delivery, not on the critical path of the
  SSE stream.
- Guests are never persisted server-side (BR-H1). The existing in-memory session
  store continues to serve the live guest thread.

### Conversation model

- A **conversation** is a first-class, account-owned object with a stable
  identity, a title, a format, created/last-activity timestamps, an ordered list
  of turns, and a pinned flag (BR-H4).
- A signed-in user can have **many** conversations. The app supports starting a
  new conversation ("New chat") and switching between conversations
  (HIST-US-6) — replacing today's effectively single-thread-per-session model.
- Each conversation belongs to exactly one format and stays in it for its life
  (BR-H6); starting a thread in the other mode creates a separate conversation.

### Reopen & continue

- Reopening renders all stored turns with full fidelity (HIST-US-4).
- Continuing appends new turns to the same conversation and re-feeds the
  conversation's prior turns to the agent as history, subject to the existing
  context-budget trimming (BR-H5). The agent internals, prompt-cached prefix,
  `MAX_ITERATIONS`, the 11-tool contract, and the SSE contract are unchanged.

### History management

- List conversations (pinned first, then most-recently-active), with title,
  format badge, and last-activity (HIST-US-3).
- Rename a conversation (HIST-US-7); auto-title on creation (BR-H7).
- Delete a conversation permanently, with confirmation (HIST-US-8, BR-H8).
- Pin / unpin a conversation (HIST-US-9).
- Search by title and message text within the user's own conversations
  (HIST-US-10, BR-H11).
- Filter by format and show a per-conversation format badge (HIST-US-11).

### Guest → account transition

- On sign-in, a non-empty on-screen guest conversation is saved as the account's
  conversation and remains live (HIST-US-12, BR-H10) — building on the existing
  guest-continuity guarantee (BR-A10). Only the conversation currently on screen
  is captured; earlier guest threads from prior sessions are not recoverable
  (they were never persisted).

## Business Rules

> IDs stable and referenceable by architecture and tests.

- **BR-H1 — History is a signed-in, per-account feature.** Only signed-in users
  have server-side history; it is strictly scoped to the owning account with no
  cross-account read or write (inherits BR-A9). Guests have no server-side
  history; their conversation lives only in the in-memory session store and is
  never persisted.
- **BR-H2 — Auto-persist successful turns.** For a signed-in user, every turn
  that ends in a successfully delivered answer (any in-domain `status`) is
  persisted automatically — no explicit save. A turn that ends in a transport
  fault or is aborted (client disconnect / Stop) is not persisted, leaving the
  conversation clean for retry.
- **BR-H3 — Stored fidelity is the full structured answer.** Each assistant turn
  is stored as the complete `OakAnswer` payload — every field needed to
  re-render exactly as first generated (reasoning, cited sources,
  inference/uncertainty flags, generation/format tag, sprites, tables, candidate
  data). The live **tool-activity trace is not persisted** and is not replayable
  for past turns.
- **BR-H4 — Conversation is a first-class account-owned object.** A conversation
  has a stable identity distinct from authentication/session and from the
  transient client `session_id`. It carries: owning account, title, format,
  created + last-activity timestamps, ordered turns, and a pinned flag.
- **BR-H5 — Continuation has in-conversation memory.** Reopening and continuing
  a conversation re-feeds its prior turns to the agent as history, subject to the
  existing context-budget trimming (`DEFAULT_HISTORY_TOKEN_BUDGET`, oldest-first
  drop). Memory is **within a single conversation only** — the agent never draws
  on a different conversation. The prompt-cached prefix and `MAX_ITERATIONS`
  behavior are unchanged.
- **BR-H6 — Format is fixed per conversation.** A conversation belongs to the
  format it was created in (`scarlet-violet` | `champions`) and is always
  continued in that format. Mode remains server-controlled and is never an
  LLM-visible tool input. A different-mode thread is a different conversation.
- **BR-H7 — Every conversation has a title.** A non-empty, human-readable title
  is derived automatically when the conversation is created/first answered, and
  the user may rename it. Renames persist across reloads and devices.
- **BR-H8 — Deletion is permanent.** Deleting a conversation (after a
  confirmation) hard-deletes it and all its turns; there is no trash, undo, or
  recovery, and it disappears on all of the account's devices.
- **BR-H9 — Retention is indefinite.** Conversations are kept until the user
  deletes them; there is no automatic time- or count-based expiry. A generous
  per-account backstop cap MAY be enforced to bound abuse; if so, its limit and
  behavior must be defined (see Open Questions).
- **BR-H10 — Guest continuity into history.** Completing sign-in saves the
  non-empty on-screen guest conversation (including its pre-sign-in turns) as the
  account's conversation and keeps it as the live thread (extends BR-A10). An
  empty on-screen thread creates nothing.
- **BR-H11 — Search scope.** Search matches a conversation's title and its
  message text, restricted to the searching account's own conversations.

## Non-Functional Requirements

- **Responsiveness.** Listing, searching, opening, and switching conversations
  should feel responsive at personal scale. Persisting a turn must not delay the
  streamed answer the user sees (off the SSE critical path).
- **Durability.** A successfully delivered answer for a signed-in user must
  survive server restarts and be retrievable on any device for that account.
- **Isolation & privacy.** Conversation content is private to the owning account
  (BR-H1 / BR-A9); it is never shared or cross-account visible. Permanent delete
  is honored end-to-end (BR-H8). Conversation text is user-entered content and
  may contain personal data; it is stored under the account and handled
  responsibly, consistent with B-1's PII posture.
- **Consistency under concurrency.** At personal/hobby scale, eventual
  consistency across a user's own devices/tabs is acceptable; the system must
  never lose a delivered answer and never attribute a conversation to the wrong
  account. (Behavior when the same conversation is appended from two
  devices/tabs at once is an Open Question.)
- **Scale.** Bounded by per-account usage and the (generous) B-1 rate limits;
  designed for many concurrent accounts each with a modest number of
  conversations, not for very-high-volume tenants.
- **Rendering durability.** Stored answers must remain renderable as the
  `OakAnswer` schema evolves over time (see Open Questions on schema
  evolution).

## UI/UX Vision

> Product-level; visual language follows `docs/design-system/design-system.md`.
> This feature does not introduce a new look-and-feel.

- **History surface (signed-in).** A browsable list of conversations (e.g. a
  sidebar or menu) showing, per conversation: title, format badge, and
  last-activity. Pinned conversations group at the top; the rest are
  most-recently-active first. Includes a search field, a format filter, and a
  prominent **New chat** action. Non-blocking — it complements the live chat
  rather than gating it.
- **Guest state.** No history list is shown to guests; the space instead offers
  the existing non-blocking sign-in affordance (B-1). Guests still chat freely.
- **Opening a conversation.** Selecting a conversation renders its full thread
  (all turns, full answer cards) and makes the composer target that
  conversation, so the next message continues it.
- **Per-conversation actions.** Rename (inline), pin/unpin, and delete (with a
  confirm step). These should be discoverable but unobtrusive.
- **Empty & edge states.** Clear states for: no conversations yet, no search
  results, and the just-deleted/just-created transition (AC-8.2, AC-6.1).
- **Continuity on sign-in.** The on-screen conversation visibly persists across
  sign-in and appears in the newly-available history list (HIST-US-12).

## Constraints and Preferences

> Inputs for the solution architect — not decisions made here.

- **Existing stack (hard constraint).** TypeScript / Next.js (App Router)
  monolith with a Drizzle + Postgres (node-postgres) data layer. Persisted
  conversations should live in this existing data layer, scoped to the account
  (consistent with B-1's identity tables and BR-A9), unless the architect makes
  a deliberate, documented case otherwise.
- **Builds on B-1 (accounts).** Identity, sessions, and the
  signed-in-vs-guest distinction already exist
  (`docs/features/account-creation/`); this feature attaches per-account data to
  them and relies on BR-A9 isolation and BR-A10 guest continuity.
- **Replaces in-memory persistence for signed-in users.** `route.ts` currently
  records turns into the in-memory `session-store` keyed by the client
  `session_id`. For signed-in users this must become durable, account-scoped
  persistence; for guests the in-memory behavior remains. The agent internals,
  the 11-tool contract, the Champions-mode toggle, and the SSE event contract
  (`tool_activity` → `answer_start`/`answer_delta` → terminal `answer`) are
  unaffected.
- **Conversation identity vs. `session_id`.** Today `session_id` is the
  client-generated, transient conversation handle. Introducing first-class
  persisted conversations (BR-H4) means defining how a persisted conversation id
  relates to the transient `session_id` and the auth/account session — the
  mapping is the architect's call.
- **Structured-answer storage shape.** The stored unit is the full
  `OakAnswer` (BR-H3); how it is serialized/stored and how schema evolution
  is handled is the architect's call (the Zod schema in `src/agent/schemas.ts`
  is the source of truth for that shape).
- **Auto-title mechanism.** Whether the auto-title is derived from the first user
  message or generated (e.g. a short model-produced summary), and its length
  cap, is the architect's call (BR-H7).
- **Search mechanism.** Title+content search is required (BR-H11); whether that
  is a simple substring filter or Postgres full-text search, and any indexing,
  is the architect's call.
- **No data to migrate.** Conversations are in-memory only today, so there is no
  existing persisted conversation data to migrate; the first deploy starts clean.

## Open Questions

- **Per-account backstop cap (BR-H9).** Retention is indefinite, but should a
  generous cap (by conversation count and/or total size) backstop abuse, and at
  what value? What happens at the cap — refuse new, or drop oldest?
- **Auto-title approach (BR-H7).** First-user-message-derived vs. model-generated
  summary; title max length; whether the title is regenerated as the
  conversation grows or fixed at creation.
- **Concurrent append.** Desired behavior when the same conversation is continued
  from two devices/tabs simultaneously (interleave, last-write-wins, soft lock?).
- **Schema evolution of stored answers.** Policy for rendering older stored
  `OakAnswer` payloads after the schema changes (version field? lenient
  render? backfill?).
- **Past-turn tool-activity.** Tool-activity is intentionally not persisted
  (BR-H3); should reopened past turns show a subtle indication that the live
  reasoning trace isn't available for them?
- **Pre-sign-in guest threads.** Confirmed: only the on-screen conversation is
  captured on sign-in; earlier ephemeral guest threads are unrecoverable. Confirm
  this remains acceptable.

## Out of Scope

Hard boundaries for this build. A builder must not add these without them being
moved into scope above.

- **Any server-side history for guests / anonymous persistence.** Guests remain
  in-memory only (BR-H1).
- **Persisting or replaying the tool-activity trace** for past turns — only the
  structured answer is stored (BR-H3).
- **Export, download, copy-out, or sharing** of conversations, and public
  share links.
- **Trash / undo / restore** of deleted conversations, and bulk operations
  (e.g. "clear all", multi-select delete) — deletion is per-conversation and
  permanent (BR-H8).
- **Folders, tags, manual reordering, or organization** beyond pin/unpin.
- **Cross-conversation memory** — the agent never recalls content from a
  *different* conversation; memory is strictly within one conversation (BR-H5).
- **Editing or deleting individual past turns, and branching** a conversation
  from an earlier point.
- **Changing a conversation's format** after creation (BR-H6).
- **Shared, collaborative, or multi-user conversations.**
- **Time- or count-based auto-expiry / retention policies** beyond an optional
  abuse backstop (BR-H9).
- **Saving teams (B-2) and the artifact viewer / persisted artifacts (B-4)** —
  separate backlog items, even though B-4 overlaps "what's stored per
  conversation."
