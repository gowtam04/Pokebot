# Admin Panel — Business Requirements

> IDs in this document are namespaced with `ADMIN-` to stay distinct from the
> main app's `US-*`/`BR-*`/`AC-*`. IDs are stable: append new ones, never
> renumber.

## Overview

Oak today is a multi-tenant Pokémon AI chat agent with passwordless email-OTP
accounts plus an anonymous guest mode. It has **no operator-facing surface**:
the owner has no way to see how the live app is being used, what it costs, where
it's failing, who has signed up, or what people are actually asking it. The only
observability is structured logs streamed to Fly's stdout; almost nothing about
usage is stored anywhere queryable.

This feature adds an **admin panel**: a private, **read-only dashboard for the
single owner-operator** that gives a window into the running app. It is an
*observation and inspection* tool, not a control panel — it never changes user
data, content, accounts, or operational configuration. It covers three areas:

1. **Observability & analytics** — usage & growth, cost & tokens, errors &
   failures, and per-turn drill-down, available both **live** and over
   **persisted history**.
2. **User & account management** — view and search accounts and their activity
   (read-only).
3. **Content moderation & inspection** — browse and search users' conversations
   and saved teams, and surface misuse / heavy usage (read-only).

Because the owner wants historical trends and nothing usage-related is persisted
today, a **cross-cutting enabler** is required: Oak must begin **recording each
chat turn and auth event into durable storage**. This recording is the data
source for the analytics and drill-down views.

### Goals

- Give the owner a single place to understand how Oak is being used, what it's
  costing, and where it's breaking.
- Make it possible to inspect any individual turn end-to-end for debugging bad
  answers.
- Let the owner read and search what users (and guests) are actually asking, to
  catch misuse and protect the API budget.
- Do all of the above without adding any risk to user data or the chat path.

### Success Criteria

- The owner can answer, from the panel alone: "How many chats happened this
  week? How many were guests vs. signed-in? How many people signed up? What did
  Grok/Claude cost me? What's failing most often? Who are my heaviest users?
  What did this specific bad turn actually do?"
- Analytics numbers reconcile with the underlying recorded turns.
- Turning on usage recording demonstrably never fails or slows a user's chat
  turn.
- Only allowlisted admin email(s) can reach the panel or any admin data; no
  normal user or guest can.

### Priority Notes (for the architect)

The owner has **no phasing preference** — the read-only dashboard is small enough
to treat as one deliverable. The one inherent ordering constraint: the
**usage-recording enabler (ADMIN-US-6)** is the data source for the historical
analytics and drill-down views, so it must land before (or with) those views.
Live views and the conversation/account browsers can read existing data and do
not depend on it.

## Users and Personas

- **The Owner / Operator (you, gowtam).** The sole admin. Technically
  comfortable, runs and pays for the deployment. Wants visibility into the live
  app — usage, cost, failures, and what people ask — without SSHing into Fly or
  grepping logs. Single user; **no role hierarchy inside the panel** (everyone
  who reaches it has full read access).

Non-admin users (registered accounts, guests) are **subjects** of the data shown
in the panel but never users *of* the panel.

## User Stories

### Admin Access

- **ADMIN-US-1** — As the owner, I want to sign into the admin panel using my
  existing Oak email-OTP login, gated to an admin allowlist, so that only I can
  reach it.
  - **ADMIN-AC-1.1** — Given an email that is on the admin allowlist completes
    the existing OTP flow, when it requests the admin panel or any admin API,
    then access is granted.
  - **ADMIN-AC-1.2** — Given a valid Oak user whose email is **not** on the
    allowlist, when it requests the admin panel or any admin API, then the
    request is rejected (forbidden) and **no admin data is returned** in any
    form.
  - **ADMIN-AC-1.3** — Given an unauthenticated request to any admin route or
    API, then it is rejected (unauthorized) with no data leaked.
  - **ADMIN-AC-1.4** — Admin authorization is enforced **server-side on every
    admin request**, not merely by hiding client-side routes.

### Observability & Analytics

- **ADMIN-US-2** — As the owner, I want a usage & growth dashboard, so that I can
  see how Oak is doing over time.
  - **ADMIN-AC-2.1** — For a selectable date range, the panel shows: total chat
    turns, active signed-in accounts, active guest sessions, new signups, and
    the guest-vs-signed-in split.
  - **ADMIN-AC-2.2** — These metrics are shown as trends over time (e.g. per-day
    series across the selected range), not just single totals.
  - **ADMIN-AC-2.3** — The displayed numbers reconcile with the recorded turn
    data for the same range.

- **ADMIN-US-3** — As the owner, I want a cost & token view, so that I can watch
  what the models are costing me.
  - **ADMIN-AC-3.1** — For a selectable date range, the panel shows input,
    output, and thinking token totals, broken down by model
    (`grok-4.3` / `claude` / `gpt-5.5`).
  - **ADMIN-AC-3.2** — The panel shows an **estimated dollar cost** computed from
    a configurable per-model token price (see ADMIN-BR-5), with cost trend over
    time, and labels it clearly as an estimate — not authoritative provider
    billing.

- **ADMIN-US-4** — As the owner, I want an errors & failures view, so that I can
  see where Oak is breaking or falling short.
  - **ADMIN-AC-4.1** — For a selectable date range, the panel shows counts and
    rates of: non-`answered` turn outcomes (`resolution_failed`,
    `clarification_needed`, `insufficient_data`), tool errors, OTP delivery
    failures, and rate-limit rejections.
  - **ADMIN-AC-4.2** — Given any failure category, when the owner selects it,
    then they can view the underlying individual turns/events that make it up
    (links into the drill-down, ADMIN-US-5).

- **ADMIN-US-5** — As the owner, I want to drill into an individual turn, so that
  I can debug a specific answer end-to-end.
  - **ADMIN-AC-5.1** — The panel provides a searchable, filterable list of
    recorded turns (filters: date range, model, format/mode, status,
    guest-vs-signed-in, and a specific account or session).
  - **ADMIN-AC-5.2** — Selecting a turn shows: request id, timestamp,
    session id (and account, if signed in), model, format/mode, the user's
    prompt text, each tool call with its name, latency, cache-hit, and any
    error, token counts (input/output/thinking), citation count, the final
    status, and the answer produced.

- **ADMIN-US-6** — As the owner, I want Oak to record each chat turn and auth
  event durably, so that the historical analytics and drill-down views have data
  to read. *(Cross-cutting enabler — not a screen.)*
  - **ADMIN-AC-6.1** — Every chat turn (guest **and** signed-in) is recorded with
    at least the fields listed in ADMIN-AC-5.2.
  - **ADMIN-AC-6.2** — Auth events are recorded: code requested
    (`otp_requested`), code verified (`otp_verified`, including the new-signup
    flag), and delivery failure (`otp_email_failed`).
  - **ADMIN-AC-6.3** — Recording is **best-effort and non-blocking**: a failure
    or slowness in recording never causes a user's chat turn to fail, error, or
    slow down noticeably. A gap in recorded data is acceptable; a broken chat is
    not. *(See ADMIN-BR-3.)*

- **ADMIN-US-7** — As the owner, I want a live view of current activity, so that
  I can see what's happening right now.
  - **ADMIN-AC-7.1** — The panel shows recent activity (e.g. the most recent
    turns and current-window counts) that refreshes automatically on a short
    interval without a manual reload.

### User & Account Management (read-only)

- **ADMIN-US-8** — As the owner, I want to view and search accounts and their
  activity, so that I can see who has signed up and how active they are.
  - **ADMIN-AC-8.1** — The panel lists accounts and supports search by email,
    showing each account's id, email, and signup date.
  - **ADMIN-AC-8.2** — Selecting an account shows derived activity: total turns,
    last-active time, total tokens and estimated cost attributable to it,
    number of saved conversations, and number of saved teams.
  - **ADMIN-AC-8.3** — Selecting an account shows its active sessions (count,
    created time, expiry).
  - **ADMIN-AC-8.4** — No control on these screens mutates an account, its
    sessions, its content, or its limits. All actions are read/navigate only.
    *(See ADMIN-BR-2.)*

### Content Moderation & Inspection (read-only)

- **ADMIN-US-9** — As the owner, I want to browse and search users' saved
  conversations, so that I can see what people are actually asking Oak.
  - **ADMIN-AC-9.1** — The panel can browse and full-text search persisted
    conversations and their messages across **all** accounts.
  - **ADMIN-AC-9.2** — Selecting a conversation shows the full thread (user and
    assistant turns) for reading.
  - **ADMIN-AC-9.3** — The view is read-only: no deletion, editing, redaction, or
    flagging of conversations or messages.

- **ADMIN-US-10** — As the owner, I want to browse and search saved teams across
  accounts, so that I can inspect team-builder usage.
  - **ADMIN-AC-10.1** — The panel can browse/search saved teams across all
    accounts and view a team's members; read-only.

- **ADMIN-US-11** — As the owner, I want to surface misuse and heavy users, so
  that I can catch abuse of my API budget.
  - **ADMIN-AC-11.1** — For a selectable date range, the panel can rank/surface
    accounts and guest sessions by volume (turns, tokens, estimated cost) and by
    frequency of rate-limit hits and failed-status turns.
  - **ADMIN-AC-11.2** — From a surfaced heavy/anomalous user, the owner can click
    through to the underlying turns (ADMIN-US-5) to inspect the actual usage.

## Functional Requirements

### Admin Access & Authentication

- Reuses Oak's existing passwordless email-OTP authentication and session model
  (cookie and/or Bearer token) — no new credential system.
- Authorization is layered on top: an **admin allowlist** of one or more
  email addresses. An authenticated session whose account email is on the
  allowlist is treated as admin; all others are non-admin.
- Every admin route and admin API endpoint verifies admin status server-side
  before returning any data.
- The admin panel ships **no LLM API keys and no direct database access on the
  client**; it talks to Oak's server API, consistent with the rest of the app.

### Usage & Event Recording (enabler)

- Oak begins recording, into durable storage, **one record per chat turn**
  containing the turn's metadata, the user prompt, the tool trace, token counts,
  status, citation count, model, format/mode, timestamp, and a
  session/account reference. This is effectively a persisted form of the
  existing in-memory `oak_turn` trace.
- Oak begins recording **auth events** (code requested, code verified with the
  new-vs-returning flag, delivery failure) durably.
- Recording is additive and decoupled from the chat path: it must not change the
  user-facing answer, and it must not block or fail the turn (ADMIN-BR-3).
- The recorded data is the source of truth for the analytics, drill-down,
  cost, error, and heavy-user views. The existing `conversation` /
  `conversation_message` / `team` tables remain the source for browsing
  signed-in users' saved threads and teams.

### Analytics & Reporting

- All analytics views are scoped by a **selectable date range** and show trends
  over time, not just point-in-time totals (ADMIN-BR-8).
- Cost is computed from a **configurable per-model token price table** and
  always presented as an estimate (ADMIN-BR-5).
- The panel can filter and search the turn records along the dimensions in
  ADMIN-AC-5.1 and pivot from any aggregate metric to the underlying turns.

### Account & Content Inspection

- Account list/detail is **read-only** and shows identity, signup, derived
  activity, and sessions.
- Conversation and team browsers are **read-only** and span all accounts, with
  full-text search over conversation content.
- Guest activity is visible through the turn records (metadata + prompt +
  answer). Guests never get a real saved `conversation` row, but the
  Conversations browser also synthesizes a pseudo-conversation per guest
  session by grouping that session's turn records — so guest threads are
  browsable and readable there too, not only via the turns explorer.

### Live View

- A near-real-time activity view refreshes on a short interval (polling is
  acceptable; true streaming is not required — ADMIN-BR-10).

## Business Rules

> IDs are stable and referenceable by the architecture and tests.

- **ADMIN-BR-1 — Allowlist gating.** Admin access is granted only to sessions
  whose account email is on the admin allowlist, enforced server-side on every
  admin request. Non-allowlisted users and guests receive no admin data.
- **ADMIN-BR-2 — Read-only.** No function in the admin panel mutates user data,
  accounts, sessions, conversations, teams, rate-limit state, secrets, or any
  operational configuration. The panel only reads and navigates.
- **ADMIN-BR-3 — Recording is non-blocking and best-effort.** Recording a turn
  or event must never fail, error, or measurably slow a user's chat turn or auth
  flow. If recording is unavailable, the user-facing app continues normally and
  the analytics data simply has a gap.
- **ADMIN-BR-4 — Owner-only full read access; no cross-exposure.** The admin has
  full read access to all user content (conversations, teams, prompts, emails);
  this is intentional and limited to the single owner. No user's data is ever
  exposed to another user, and no admin data is ever exposed to a non-admin.
- **ADMIN-BR-5 — Cost is an estimate.** Dollar figures are computed from a
  configurable per-model token price and are explicitly estimates; the model
  providers' own billing is authoritative.
- **ADMIN-BR-6 — Every turn is recorded.** Both guest and signed-in chat turns
  are recorded with the fields in ADMIN-AC-5.2; auth events per ADMIN-AC-6.2 are
  recorded.
- **ADMIN-BR-7 — Guest/turn content becomes persisted.** Recording a turn's
  prompt and answer means guest content — previously ephemeral and discarded on
  reload — is now stored. This is an accepted tradeoff for owner-only
  observability and requires the privacy policy to disclose it (see Open
  Questions / Constraints).
- **ADMIN-BR-8 — Date-range scoping.** Analytics views are scoped to a
  selectable time range and default to a sensible recent window.
- **ADMIN-BR-9 — Failure taxonomy.** A "failure" for the errors view means any
  turn whose status is not `answered` (`resolution_failed`,
  `clarification_needed`, `insufficient_data`), plus tool-trace errors,
  OTP delivery failures, and rate-limit rejections.
- **ADMIN-BR-10 — Live ≠ streaming.** The live view may refresh by short-interval
  polling; real-time push/streaming is not required.

## Non-Functional Requirements

- **Single admin user.** Effectively one concurrent operator; no scale concerns
  on the admin side.
- **No impact on the user-facing app.** The recording enabler must be additive
  and non-breaking (ADMIN-BR-3); the chat path's latency and reliability must be
  unaffected.
- **Responsiveness.** Dashboard and list views should load within a couple of
  seconds. Analytics queries must stay responsive as recorded data accumulates
  (the architect handles aggregation/indexing/retention).
- **Reliability.** Best-effort, like the rest of this hobby deployment. If
  recording or the panel is down, the user-facing app is unaffected.
- **Security & access control.** Admin-only, server-enforced (ADMIN-BR-1); the
  new usage data and admin endpoints must be unreachable by normal users and
  guests. Reuses the existing 30-day session model.
- **Privacy.** The admin can read private user content by design (ADMIN-BR-4);
  the privacy policy must be updated to disclose operator access and usage
  recording. No user-to-user exposure.
- **Platform.** Web, desktop browser. The admin panel is an operator tool; no
  mobile or offline requirement.

## UI/UX Vision

- **Feel.** A clean, **data-dense, functional operator dashboard** — closer to an
  internal admin/analytics tool than the polished consumer chat UI. Tables,
  charts, filters, fast navigation. Utility over flourish.
- **Key screens (indicative, architect/designer to finalize):**
  - **Sign-in.** Email → OTP code (the existing flow), then allowlist gate.
  - **Overview.** Top-line KPIs (turns, active users, signups, est. cost, error
    rate) with trend charts over the selected date range; a global date-range
    picker.
  - **Usage explorer / turns.** Searchable, filterable table of recorded turns;
    row click opens a turn-detail view (the full ADMIN-AC-5.2 breakdown).
  - **Cost.** Tokens and estimated spend by model over time.
  - **Errors.** Failure counts/rates by category, each clickable through to the
    underlying turns.
  - **Accounts.** Searchable account list → account detail (activity + sessions),
    read-only.
  - **Conversations.** Browse/search all conversations → full thread reader,
    read-only.
  - **Teams.** Browse/search saved teams, read-only.
  - **Heavy users / misuse.** Ranked view by volume/cost/failures with
    click-through.
- **Interaction patterns.** Global and per-view filters (date range, model,
  format/mode, status, guest-vs-signed-in, account/session), full-text search,
  sortable tables, time-series charts, and click-through from any aggregate to
  its underlying records. Live view auto-refreshes.

## Constraints and Preferences

> Inputs for the solution architect — not decisions made here.

- **Client tech preference:** the owner leans toward a **lightweight React +
  Vite SPA** for the panel, but is open to the architect choosing instead a
  **protected section/route inside the existing Next.js app** if that's simpler.
  Record React+Vite as a preference, not a hard constraint.
- **Auth reuse (hard):** the panel must reuse the existing email-OTP auth and
  session model; admin gating is an **email allowlist** (configuration/secret).
  No new credential system.
- **No client-side secrets/DB (hard):** the panel talks to Oak's server API; no
  LLM keys or direct DB access on the client, consistent with the existing app.
- **Read-only (hard):** the panel introduces no mutating user/operational
  actions (ADMIN-BR-2).
- **Additive, non-breaking recording (hard):** the usage-recording enabler must
  not alter or risk the chat path (ADMIN-BR-3).
- **Existing stack:** Next.js monolith, Postgres via Drizzle, single Fly machine.
  New storage is added via Drizzle migrations. The existing structured
  `oak_turn` / auth log fields are the natural template for what to persist.
- **Privacy policy:** must be updated to disclose operator read access and usage
  recording before/with shipping (ADMIN-BR-7).

## Open Questions

- **Guest content persistence (privacy).** Recording prompts/answers for
  drill-down and misuse-spotting means storing **guest** content that is ephemeral
  today. Recommended default: store it (owner-only access) and disclose it in the
  privacy policy — but confirm the owner is comfortable, and confirm whether full
  answer text (vs. metadata only) should be stored for every turn.
- **Data retention.** How long to keep recorded turns/events — indefinitely, or a
  rolling window (e.g. 90/180 days)? Recommended default: indefinite for now,
  revisit if volume/cost grows.
- **Cost pricing source.** Where do per-model token prices come from — a
  hardcoded config the owner edits in code, or an admin-editable value? (Note:
  making it editable would be the one exception to read-only; default
  recommendation is a code/config constant to preserve ADMIN-BR-2.) How often
  updated?
- **Allowlist storage.** Should the admin allowlist live in an env secret or as a
  flag on the account record? (Architect's call; env secret is simplest and
  keeps the schema untouched.)
- **Misuse-detection depth.** Is volume/metadata ranking + status filtering
  enough, or is any automated content classification (e.g. jailbreak detection)
  wanted? Recommended default: heuristics/metadata only — no ML classification.
- **Admin audit trail.** Should the owner's own reads of private content be
  logged for accountability? Out of scope for now (single trusted owner), but
  flagged in case it matters later.
- **"Live" refresh interval.** Acceptable polling cadence for the live view
  (e.g. every 5–15s)?

## Out of Scope

A builder should not add these without them being moved into scope:

- **Any operational control.** Triggering ingest / index rebuild, switching the
  active model (`ACTIVE_MODEL`), toggling formats, editing rate-limit tiers,
  rotating or editing secrets, or anything deploy-related. The owner explicitly
  deselected operational control — it stays CLI/Fly-managed.
- **User moderation actions.** Banning/suspending users, deleting accounts,
  deleting/editing/redacting conversations, messages, or teams, force-logout /
  session revocation, or resetting/adjusting a user's rate limits or tier. The
  panel is read-only.
- **Flag/report queue.** No content-flagging mechanism, no auto-flag rules, and
  no user-facing reporting.
- **Multi-admin roles / RBAC.** No role hierarchy inside the panel; a single
  trusted owner with full read access.
- **Billing, subscriptions, or payments** of any kind.
- **Alerting / paging / notifications.** The panel does not push alerts when
  errors or costs spike; the owner checks it manually.
- **Editing reference/index data.** No editing of `pokemon` / `learnset` /
  reference-cache or other ingested data through the panel.
- **Native mobile admin client.** Web/desktop browser only.
