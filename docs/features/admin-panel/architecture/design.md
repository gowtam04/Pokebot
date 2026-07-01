# Admin Panel — Technical Design

Mode: PM
Budget Tier: Hobby / prototype
Backend Topology: Existing monolith (Next.js App Router, single Fly machine + Postgres) — no change

## Overview

A read-only, single-owner admin dashboard for Oak, built **as a protected
`/admin` route group inside the existing Next.js app** (not a separate Vite SPA).
It reuses Oak's existing email-OTP auth and sessions, gated by an
`ADMIN_EMAILS` allowlist, and reads the same Postgres via new cross-account
repos. It adds three read-only surfaces — observability/analytics, view-only
account management, and read-only conversation/team moderation — plus the
load-bearing enabler: Oak begins **persisting one record per chat turn and per
auth event** into Postgres, on a **non-blocking** path so recording can never
affect a user's chat (ADMIN-BR-3).

Nothing in the panel mutates user data, content, accounts, sessions, or
operational config (ADMIN-BR-2). The only writes this feature introduces are the
append-only usage/event records on the chat and auth paths.

### Scope call

Treating this as a **small/focused feature** on an established codebase → single
-file `design.md`, default topology (the existing monolith). The feature is
sizable in file count but architecturally cohesive: new tables + a recording
hook + admin read repos + admin API routes + an `/admin` UI section, all inside
the current app.

## Requirements Reference

Source: `docs/features/admin-panel/requirements/requirements.md`.

- **Access:** ADMIN-US-1 (ADMIN-AC-1.1–1.4), ADMIN-BR-1.
- **Observability:** ADMIN-US-2 (usage/growth), ADMIN-US-3 (cost/tokens),
  ADMIN-US-4 (errors), ADMIN-US-5 (per-turn drill-down), ADMIN-US-7 (live view).
- **Recording enabler:** ADMIN-US-6 (ADMIN-AC-6.1–6.3), ADMIN-BR-3, ADMIN-BR-6,
  ADMIN-BR-7.
- **Accounts (view-only):** ADMIN-US-8.
- **Moderation (read-only):** ADMIN-US-9 (conversations), ADMIN-US-10 (teams),
  ADMIN-US-11 (heavy users / misuse).
- **Business rules honored:** ADMIN-BR-1..10. Notable: BR-2 read-only, BR-3
  non-blocking recording, BR-4 owner-only-no-cross-exposure, BR-5 cost-is-
  estimate, BR-8 date-range scoping, BR-9 failure taxonomy, BR-10 live≠streaming.

Resolved open questions (from requirements), now design constraints:
- Guest/turn content **is stored** (prompt + answer) for every turn → privacy
  policy must disclose it (see Phase 9).
- Retention: **indefinite** (no prune job).
- Allowlist storage: **`ADMIN_EMAILS` env secret**.
- Cost pricing: **static per-model price config in code** (preserves read-only).

## Tech Stack

No new stack. Additions only:
- **Data:** 2 new Drizzle/Postgres tables (`turn_record`, `auth_event`), new
  read/write repos. Same `@/data/db` singleton, same migration flow
  (`db:generate` → `db:migrate`).
- **Backend:** new `/api/admin/*` Next route handlers; one new `AgentContext`
  field; small hooks in the chat route + auth emit sites.
- **Frontend:** new `/admin` App Router route group (server-gated layout +
  client pages), new `src/components/admin/*`. Tailwind + the existing CSS-token
  / BEM conventions.
- **One optional client dependency:** a small charting lib (`recharts`) for the
  time-series charts, code-split into the `/admin` bundle only. If we'd rather
  add zero deps, the charts can be hand-rolled as inline SVG/CSS sparklines —
  builder's discretion; the design does not depend on which.

## Data Model

Conventions mirrored from `schema.ts`: `text` ids (UUID via
`crypto.randomUUID()`), `bigint({mode:"number"})` epoch-ms timestamps, snake_case
columns, JSON stored as `text`, logical (un-constrained) FK columns, indexes
targeting query patterns.

### New table: `turn_record` (one row per chat turn — guest and signed-in)

Append-only. Written once, never updated. Holds the persisted form of the
runtime's existing `TurnTrace` plus the turn's content.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | = the turn's `request_id` (UUID, unique per turn) |
| `session_id` | text, not null | conversation/session id (groups turns) |
| `account_id` | text, **nullable** | null ⇒ guest turn |
| `model` | text, not null | `ModelKey` (`grok-4.3`\|`claude`\|`gpt-5.5`) — keys cost lookup |
| `provider_model` | text, not null | provider api model id from the trace (e.g. `grok-2`) |
| `mode` | text, not null | `standard` \| `champions` |
| `status` | text, not null | recorded status: `answered`\|`clarification_needed`\|`resolution_failed`\|`insufficient_data`\|`rate_limited` (superset of `TurnStatus`, see AD-4) |
| `input_tokens` | integer, not null, default 0 | |
| `output_tokens` | integer, not null, default 0 | |
| `thinking_tokens` | integer, not null, default 0 | |
| `tool_trace` | text, not null, default `'[]'` | JSON `ToolTraceEntry[]` |
| `tool_error_count` | integer, not null, default 0 | denormalized count of tool_trace entries with `error!=null` (cheap error rollups) |
| `citation_count` | integer, not null, default 0 | |
| `turn_latency_ms` | integer, not null, default 0 | |
| `images_count` | integer, not null, default 0 | attached image count (bytes never stored) |
| `prompt_text` | text, not null, default `''` | the user message (searchable; empty when image-only) |
| `answer_text` | text, nullable | `answer_markdown` (searchable; null for `rate_limited`) |
| `answer_json` | text, nullable | full `OakAnswer` JSON for drill-down re-render (null for `rate_limited`) |
| `created_at` | bigint, not null | epoch ms; primary time dimension |

Indexes:
- `turn_record_created_idx` on `(created_at)` — time-series + retention scans.
- `turn_record_account_created_idx` on `(account_id, created_at)` — per-account activity & heavy-user rollups.
- `turn_record_session_idx` on `(session_id)` — group a session's turns.
- `turn_record_status_created_idx` on `(status, created_at)` — errors view.
- `turn_record_model_created_idx` on `(model, created_at)` — cost-by-model.
- (Optional perf upgrade, not in v1) `pg_trgm` GIN on `prompt_text`/`answer_text` if substring search gets slow.

### New table: `auth_event` (one row per auth event)

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID |
| `type` | text, not null | `otp_requested` \| `otp_verified` \| `otp_email_failed` |
| `email` | text, nullable | the email involved (normalized) |
| `account_id` | text, nullable | set on `otp_verified` |
| `created_flag` | integer, nullable | for `otp_verified`: 1 = new signup, 0 = returning sign-in; null otherwise |
| `detail` | text, nullable | JSON extra (e.g. error string on `otp_email_failed`) |
| `created_at` | bigint, not null | epoch ms |

Indexes: `auth_event_created_idx` on `(created_at)`, `auth_event_type_created_idx` on `(type, created_at)`.

### Reused (read-only) existing tables

- `account` (id, email, created_at) — **signups** come straight from
  `account.created_at`; no need to derive them from `auth_event`.
- `auth_session` (account_id, created_at, expires_at) — account "active sessions".
- `conversation` / `conversation_message` — signed-in saved threads for the
  moderation browser (existing `text_content` + `answer_json`). Guest sessions
  never get a row here; the moderation browser instead synthesizes a guest
  pseudo-conversation by grouping that session's `turn_record` rows
  (`account_id IS NULL`) at read time — see `listAllConversations` /
  `getConversationThread` below.
- `team` — saved teams browser.

No existing table is altered.

## Component Design

### 1. Usage recording (write path)

- **`AgentContext.onTurnComplete?: (trace: TurnTrace) => void`** (`src/agent/types.ts`).
  A pure sink. The runtime already assembles the `TurnTrace` and calls
  `logTurn(trace)` inside `finalize()`; right there it additionally calls
  `ctx.onTurnComplete?.(trace)`. One line; no change to `runOak`'s return type,
  no ripple to tests/eval. (See AD-2.)
- **`src/data/repos/usage-repo.ts`** — owns the two append-only writes:
  `recordTurn(record: TurnRecordInput): Promise<void>` and
  `recordAuthEvent(event: AuthEventInput): Promise<void>`. `import "server-only"`,
  uses the `@/data/db` singleton, plain INSERTs.
- **`src/app/api/chat/route.ts`** (modify) — sets `onTurnComplete` to a closure
  that captures the trace into the turn's async scope; after `runOak` resolves
  (the existing post-answer, non-blocking section where conversation turns are
  already persisted in try/catch), it composes a `TurnRecordInput` from the
  captured trace + `message`/`images`/`answer`/`account`/`mode` and fires
  `void recordTurn(...).catch(logOnly)`. On the **rate-limit rejection branch**
  (before the stream opens) it fires `void recordTurn({...status:"rate_limited"})`.
- **Auth emit sites** (modify) — wherever `otp_requested` / `otp_verified` /
  `otp_email_failed` are logged today (`src/server/auth/auth-service.ts` and/or
  the `request-code`/`verify` routes), add a sibling
  `void recordAuthEvent(...).catch(logOnly)`.

All recording calls are **fire-and-forget with a `.catch` that only logs**
(ADMIN-BR-3). Never awaited on the user's critical path.

### 2. Admin auth & gating

- **`src/env.ts`** (modify) — add `ADMIN_EMAILS` (optional, comma-separated),
  using the existing `preprocess(emptyToUndefined, …)` pattern.
- **`src/server/auth/admin.ts`** (new) — `isAdmin(account): boolean` (email is on
  the normalized allowlist) and `requireAdmin(account): Account` (throws if not).
- **`src/app/api/admin/_lib/guard.ts`** (new) — `requireAdminRequest(req):
  Promise<{account: Account} | {response: Response}>`: resolves
  `getCurrentAccount()`, returns `jsonError(401,"unauthorized")` if null,
  `jsonError(403,"forbidden")` if not admin, else the account. Every admin route
  calls this first (ADMIN-AC-1.4).
- **`src/app/admin/layout.tsx`** (new, server component) — second gate at the UI
  layer: resolves the account server-side and `redirect("/")`/`notFound()` for
  non-admins, so non-admins never receive admin HTML (defense in depth, AD-5).

### 3. Admin read repos (cross-account, un-scoped)

Existing conversation/team reads are hard-scoped to `account_id`; admin needs new
**un-scoped** reads + aggregations. Split by concern:

- **`src/data/repos/admin-analytics-repo.ts`** — aggregations over `turn_record`
  / `auth_event` / `account`: time-bucketed usage series, active users, signups,
  guest/signed split, cost-by-model, error rollups, heavy-user rankings, live
  recent turns + current-window counts. SQL `GROUP BY` with
  `date_trunc(...)` over `to_timestamp(created_at/1000)`, `.mapWith(Number)` on
  computed columns.
- **`src/data/repos/admin-content-repo.ts`** — cross-account row reads:
  `listAccounts` (+ derived activity), `getAccountDetail` (+ sessions),
  `listAllConversations` / `getConversationThread` (un-scoped variants of the
  existing methods), `listAllTeams` / `getTeamById`, `listTurns` (filter/search/
  paginate), `getTurn` (single record for drill-down). Substring search via
  `ilike` (matching the existing convention).

### 4. Admin API (`src/app/api/admin/*`)

Thin handlers: `requireAdminRequest` → parse query → call a repo → `json(200,…)`.
Endpoints (all GET, all gated):
`overview`, `cost`, `errors`, `turns`, `turns/[id]`, `accounts`, `accounts/[id]`,
`conversations`, `conversations/[id]`, `teams`, `teams/[id]`, `live`.
(Heavy-users is `accounts?sort=cost|turns|errors`; it is not a separate route.)

### 5. Admin frontend (`src/app/admin/*` + `src/components/admin/*`)

- `layout.tsx` server-gates and renders the nav shell (tabs: Overview, Usage,
  Cost, Errors, Accounts, Conversations, Teams) + a global date-range picker.
- Each page is a client component that fetches its `/api/admin/*` endpoint and
  renders with shared admin primitives (`KpiCard`, `TimeSeriesChart`,
  `DataTable`, `FilterBar`, `DateRangePicker`, `TurnDetail`). Component tests
  render fixture payloads only — they never import db/repos (existing rule).
- A shared **client-safe wire-types module** `src/lib/admin/admin-types.ts` is
  imported by both the API handlers and the pages, so request/response shapes
  can't drift.

## API Design

Auth: every route requires a session whose account email is on `ADMIN_EMAILS`.
Non-authenticated → `401 {code:"unauthorized"}`; authenticated non-admin →
`403 {code:"forbidden"}`. Cookie or Bearer, via the existing `getCurrentAccount`.

Common query params (where applicable): `from`,`to` (epoch ms; default last 7
days), `bucket` (`day`|`hour`, default `day`), `model`, `mode`, `status`,
`kind` (`guest`|`signed`), `accountId`, `sessionId`, `q` (search),
`limit`,`cursor` (keyset pagination on `created_at,id`).

Representative response shapes (full types in Interface Definitions):

- `GET /api/admin/overview` → `OverviewResponse` — KPI totals + per-bucket series
  (turns, activeSigned, activeGuest, signups) + headline cost & error rate.
- `GET /api/admin/cost` → `CostResponse` — token totals & estimated USD by model,
  plus a per-bucket cost series. Carries `estimated:true` (ADMIN-BR-5).
- `GET /api/admin/errors` → `ErrorsResponse` — counts/rates by category over the
  range; each category links to a `turns` filter.
- `GET /api/admin/turns` → `TurnsListResponse` — paginated, filtered turn rows
  (summary projection, no heavy JSON).
- `GET /api/admin/turns/{id}` → `TurnDetailResponse` — the full `turn_record`
  including `tool_trace`, `prompt_text`, `answer_json`.
- `GET /api/admin/accounts` → `AccountsResponse` — accounts + derived activity;
  `sort` enables the heavy-user view.
- `GET /api/admin/accounts/{id}` → `AccountDetailResponse` — activity + sessions.
- `GET /api/admin/conversations` / `…/{id}` → list / full thread (cross-account).
- `GET /api/admin/teams` / `…/{id}` → list / detail (cross-account).
- `GET /api/admin/live` → `LiveResponse` — last N turns + current-window counts;
  the client polls this every ~10s (ADMIN-BR-10).

Errors use the existing `jsonError(status, code, message)` envelope. Validation
of query params is lenient (bad/missing → sensible defaults), never 500.

## File Structure

```
web/src/
├── data/
│   ├── schema.ts                         (MODIFY) + turn_record, auth_event tables & indexes
│   └── repos/
│       ├── usage-repo.ts                 (NEW) recordTurn(), recordAuthEvent() — append-only writes
│       ├── admin-analytics-repo.ts       (NEW) time-series/cost/errors/heavy-user/live aggregations
│       └── admin-content-repo.ts         (NEW) cross-account accounts/conversations/teams/turns reads
├── server/
│   ├── admin/
│   │   └── pricing.ts                     (NEW) MODEL_PRICING + estimateCostUsd() (static, estimate)
│   └── auth/
│       ├── admin.ts                       (NEW) isAdmin(), requireAdmin()
│       └── auth-service.ts                (MODIFY) emit recordAuthEvent() alongside existing logs
├── agent/
│   ├── types.ts                           (MODIFY) AgentContext.onTurnComplete?
│   └── runtime.ts                         (MODIFY) finalize() calls ctx.onTurnComplete?.(trace)
├── env.ts                                 (MODIFY) ADMIN_EMAILS
├── lib/admin/
│   └── admin-types.ts                     (NEW) client-safe request/response wire types
├── app/
│   ├── api/
│   │   ├── chat/route.ts                  (MODIFY) capture trace, fire recordTurn (+ rate-limit branch)
│   │   └── admin/
│   │       ├── _lib/guard.ts              (NEW) requireAdminRequest()
│   │       ├── overview/route.ts          (NEW)
│   │       ├── cost/route.ts              (NEW)
│   │       ├── errors/route.ts            (NEW)
│   │       ├── turns/route.ts             (NEW)
│   │       ├── turns/[id]/route.ts        (NEW)
│   │       ├── accounts/route.ts          (NEW)
│   │       ├── accounts/[id]/route.ts     (NEW)
│   │       ├── conversations/route.ts     (NEW)
│   │       ├── conversations/[id]/route.ts(NEW)
│   │       ├── teams/route.ts             (NEW)
│   │       ├── teams/[id]/route.ts        (NEW)
│   │       └── live/route.ts              (NEW)
│   └── admin/
│       ├── layout.tsx                     (NEW, server) admin gate + nav shell + date-range provider
│       ├── admin.css                      (NEW) admin BEM styles (or extend globals.css)
│       ├── page.tsx                       (NEW) Overview
│       ├── cost/page.tsx                  (NEW)
│       ├── errors/page.tsx                (NEW)
│       ├── usage/page.tsx                 (NEW) turns explorer
│       ├── usage/[id]/page.tsx            (NEW) turn drill-down
│       ├── accounts/page.tsx              (NEW)
│       ├── accounts/[id]/page.tsx         (NEW)
│       ├── conversations/page.tsx         (NEW)
│       ├── conversations/[id]/page.tsx    (NEW) full thread reader
│       └── teams/page.tsx                 (NEW)
└── components/admin/                       (NEW)
    ├── KpiCard.tsx                        headline metric tile
    ├── TimeSeriesChart.tsx                bucketed line/area chart (recharts or SVG)
    ├── DataTable.tsx                      sortable/paginated table
    ├── FilterBar.tsx                      model/mode/status/kind/search filters
    ├── DateRangePicker.tsx                global range control
    └── TurnDetail.tsx                     full per-turn breakdown view

web/src/app/privacy/page.tsx               (MODIFY) disclose operator access + usage recording
```

Tests (mirror existing infixes):
```
web/src/data/repos/usage-repo.oracle.test.ts            insert + read-back
web/src/data/repos/admin-analytics-repo.oracle.test.ts  aggregation correctness vs seeded turns
web/src/data/repos/admin-content-repo.oracle.test.ts    cross-account reads/search/pagination
web/src/server/auth/admin.test.ts                       allowlist logic
web/src/app/api/admin/admin-routes.integration.test.ts  gating (401/403/200) + shapes/filters
web/src/app/api/chat/route.test.ts                      (MODIFY) records a turn; recorder failure never fails the turn
web/src/components/admin/*.test.tsx                      fixture-rendered views
```

## Interface Definitions

Biased to high detail at the seams, because the consumer is an autonomous
builder that can't ask back.

### Recording sink (agent ↔ route)

```ts
// src/agent/types.ts  (addition to AgentContext)
onTurnComplete?: (trace: TurnTrace) => void; // pure sink; called once in finalize() after the trace is built

// src/agent/runtime.ts  finalize()  — add one line next to logTurn(trace):
ctx.onTurnComplete?.(trace);
```

`TurnTrace` (existing, `src/server/logger.ts`) is the source object:
`{ request_id, session_id, model, input_tokens, output_tokens, thinking_tokens,
tool_trace: ToolTraceEntry[], turn_latency_ms, status, citation_count }`.

### usage-repo

```ts
// src/data/repos/usage-repo.ts
import "server-only";

export interface TurnRecordInput {
  id: string;                 // request_id
  sessionId: string;
  accountId: string | null;   // null = guest
  model: string;              // ModelKey
  providerModel: string;      // trace.model
  mode: "standard" | "champions";
  status: "answered" | "clarification_needed" | "resolution_failed"
        | "insufficient_data" | "rate_limited";
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTrace: ToolTraceEntry[];      // serialized to JSON by the repo
  citationCount: number;
  turnLatencyMs: number;
  imagesCount: number;
  promptText: string;
  answerText: string | null;
  answer: unknown | null;           // OakAnswer; repo JSON.stringifies into answer_json
  createdAt: number;                // epoch ms
}
export function recordTurn(input: TurnRecordInput): Promise<void>;

export interface AuthEventInput {
  type: "otp_requested" | "otp_verified" | "otp_email_failed";
  email: string | null;
  accountId?: string | null;
  createdFlag?: 0 | 1 | null;       // signup vs sign-in for otp_verified
  detail?: unknown | null;          // JSON.stringified
  createdAt: number;
}
export function recordAuthEvent(input: AuthEventInput): Promise<void>;
```
`recordTurn` derives `tool_error_count` from `toolTrace`. Both functions are
INSERT-only and are always called as `void recordX(...).catch(logOnly)`.

### Admin auth

```ts
// src/server/auth/admin.ts
export function isAdmin(account: Account | null): boolean;     // email ∈ ADMIN_EMAILS (normalized)
export function requireAdmin(account: Account | null): Account; // throws if !isAdmin

// src/app/api/admin/_lib/guard.ts
export async function requireAdminRequest(
  req: Request,
): Promise<{ account: Account } | { response: Response }>;     // 401 if no session, 403 if not admin
```

### pricing (cost estimate, static)

```ts
// src/server/admin/pricing.ts
export interface ModelPrice { inputPer1M: number; outputPer1M: number; thinkingPer1M: number }
export const MODEL_PRICING: Record<string /* ModelKey */, ModelPrice>;
export function estimateCostUsd(
  m: { model: string; inputTokens: number; outputTokens: number; thinkingTokens: number },
): number; // unknown model → 0, and the caller flags it
```

### admin-analytics-repo (key signatures)

```ts
// src/data/repos/admin-analytics-repo.ts  (all import "server-only")
interface Range { from: number; to: number; bucket: "day" | "hour" }

getUsageSeries(r: Range): Promise<{
  buckets: { t: number; turns: number; activeSigned: number; activeGuest: number; signups: number }[];
  totals:  { turns: number; activeSigned: number; activeGuest: number; signups: number; guestTurns: number; signedTurns: number };
}>;

getCostBreakdown(r: Range): Promise<{
  byModel: { model: string; inputTokens: number; outputTokens: number; thinkingTokens: number; estUsd: number; priced: boolean }[];
  series:  { t: number; estUsd: number }[];
  totalEstUsd: number; estimated: true;
}>;

getErrorBreakdown(r: Range): Promise<{
  categories: { key: "resolution_failed"|"clarification_needed"|"insufficient_data"|"tool_error"|"otp_email_failed"|"rate_limited"; count: number; ratePct: number }[];
  totalTurns: number;
}>;

getHeavyUsers(r: Range, sort: "turns"|"cost"|"errors", limit: number): Promise<{
  rows: { accountId: string | null; email: string | null; turns: number; estUsd: number; rateLimited: number; failed: number }[];
}>;

getLive(): Promise<{
  recent: TurnSummary[];                 // last N turns
  window: { lastHourTurns: number; lastHourActive: number };
}>;
```

### admin-content-repo (key signatures)

```ts
// src/data/repos/admin-content-repo.ts  (all import "server-only")
interface TurnFilter {
  from?: number; to?: number; model?: string; mode?: string;
  status?: string; kind?: "guest"|"signed"; accountId?: string;
  sessionId?: string; q?: string; limit: number; cursor?: string;
}
listTurns(f: TurnFilter): Promise<{ rows: TurnSummary[]; nextCursor: string | null }>;
getTurn(id: string): Promise<TurnDetail | null>;

listAccounts(opts: { q?: string; sort?: "recent"|"turns"|"cost"|"errors"; limit: number; cursor?: string }):
  Promise<{ rows: AccountWithActivity[]; nextCursor: string | null }>;
getAccountDetail(accountId: string): Promise<{ account: AccountWithActivity; sessions: SessionInfo[] } | null>;

listAllConversations(opts: { q?: string; format?: string; limit: number; cursor?: string }):
  Promise<{ rows: ConversationSummary[]; nextCursor: string | null }>;
  // Un-scoped variant of listConversations, UNIONed with guest sessions
  // synthesized from turn_record (accountId: null) — see Reused tables above.
getConversationThread(conversationId: string): Promise<{ summary: ConversationSummary; turns: StoredTurn[] } | null>;
  // Also resolves a guest session_id (no matching `conversation` row) by
  // reconstructing the thread from that session's turn_record rows.

listAllTeams(opts: { q?: string; format?: string; limit: number; cursor?: string }):
  Promise<{ rows: TeamSummary[]; nextCursor: string | null }>;
getTeamById(teamId: string): Promise<TeamDetail | null>;
```
`TurnSummary`/`TurnDetail`/`AccountWithActivity`/`SessionInfo` and the API
response wrappers (`OverviewResponse`, `CostResponse`, …) live in
`src/lib/admin/admin-types.ts` and are imported by both API routes and pages.

## Implementation Phases

> Dependency-ordered. Phase 3 (gating) is independent of recording and runs in
> parallel with Phases 1–2. Phases 7 & 8 (screens) run in parallel after 5+6.

**Phase 1 — Recording storage + write repo + pricing.**
What: `turn_record` + `auth_event` in `schema.ts`; generated migration;
`usage-repo.ts` (`recordTurn`, `recordAuthEvent`); `server/admin/pricing.ts`.
Depends on: nothing. Produces: the write API + tables.
Parallel: pricing vs repo vs schema can be authored together.
Test focus: insert + read-back; `tool_error_count` derivation; estimateCostUsd
math (incl. unknown model → 0).
Refs: ADMIN-US-6, ADMIN-AC-6.1/6.2, ADMIN-BR-6/7, ADMIN-BR-5.

**Phase 2 — Wire recording into chat + auth (non-blocking).**
What: `AgentContext.onTurnComplete`; `runtime.finalize()` one-liner; chat-route
capture + `void recordTurn` on the post-answer path and the rate-limit branch;
`void recordAuthEvent` at the three auth emit sites.
Depends on: Phase 1. Produces: live recording of every turn/event.
Test focus: a chat turn writes exactly one `turn_record` with correct fields; a
recorder that throws never fails/delays the turn (mock repo to reject); a
rate-limited request writes a `rate_limited` row; auth events recorded.
Refs: ADMIN-US-6, ADMIN-AC-6.1/6.2/**6.3**, ADMIN-BR-3/6.

**Phase 3 — Admin auth gating** (parallel with 1–2).
What: `ADMIN_EMAILS` in `env.ts`; `server/auth/admin.ts`; `api/admin/_lib/guard.ts`.
Depends on: nothing. Produces: `isAdmin`/`requireAdmin`/`requireAdminRequest`.
Test focus: allowlist match (normalization, empty/unset → no admins); guard
returns 401 (no session) / 403 (non-admin) / passes admin.
Refs: ADMIN-US-1, ADMIN-AC-1.1–1.4, ADMIN-BR-1.

**Phase 4 — Admin read repos** (analytics ∥ content).
What: `admin-analytics-repo.ts` + `admin-content-repo.ts`; shared types in
`lib/admin/admin-types.ts`.
Depends on: Phase 1 (tables). Produces: all cross-account reads + aggregations.
Parallel: the two repos are independent.
Test focus: aggregation correctness vs a seeded turn set (buckets, active-user
distinct counts, cost rollups, error taxonomy per ADMIN-BR-9); cross-account
listing/search/keyset pagination; account activity derivation.
Refs: ADMIN-US-2/3/4/5/8/9/10/11, ADMIN-BR-8/9.

**Phase 5 — Admin API endpoints.**
What: the 12 `/api/admin/*` handlers (guard → repo → json).
Depends on: Phase 3 (guard) + Phase 4 (repos). Produces: the admin HTTP surface.
Test focus: gating on every route (401/403/200); param parsing & defaults;
response shapes match `admin-types.ts`; pagination cursors.
Refs: ADMIN-US-1..11, ADMIN-AC-*, ADMIN-BR-1/2/4.

**Phase 6 — Admin shell: gated layout, nav, shared components.**
What: `admin/layout.tsx` (server gate + redirect), nav, `DateRangePicker`,
`DataTable`, `FilterBar`, `KpiCard`, `TimeSeriesChart`, `TurnDetail`, admin CSS.
Depends on: Phase 5 (endpoints to call) — UI primitives can be scaffolded
against fixtures in parallel with Phase 5, integrated after.
Test focus: layout renders nav; non-admin is redirected (server gate); component
primitives render fixture data.
Refs: ADMIN-US-1, UI/UX vision.

**Phase 7 — Observability screens** (parallel with Phase 8).
What: Overview, Cost, Errors, Usage explorer + `usage/[id]` drill-down, Live.
Depends on: Phase 6 + Phase 5.
Test focus: fixture-rendered views assert KPIs, series, filters, and the full
drill-down breakdown (ADMIN-AC-5.2); live view polls.
Refs: ADMIN-US-2/3/4/5/7, ADMIN-AC-2.*/3.*/4.*/5.*/7.*.

**Phase 8 — Account & content screens** (parallel with Phase 7).
What: Accounts list/detail, Conversations browser + thread reader, Teams
browser, heavy-users (accounts sorted).
Depends on: Phase 6 + Phase 5.
Test focus: fixture-rendered lists/detail; search; thread reader; read-only (no
mutating controls present).
Refs: ADMIN-US-8/9/10/11, ADMIN-AC-8.*/9.*/10.*/11.*.

**Phase 9 — Integration, privacy disclosure, polish.**
What: admin entry link (shown only to admins) or direct `/admin` nav; update
`app/privacy/page.tsx` to disclose operator read access + usage recording
(ADMIN-BR-7); E2E checks; empty/zero-data states; `ADMIN_EMAILS` fly secret +
README/CLAUDE note.
Depends on: all prior.
Test focus: end-to-end — admin signs in and a turn just made appears in
Overview/Usage; a non-admin is fully blocked (ADMIN-AC-1.2); privacy copy
present.
Refs: ADMIN-BR-2/4/7, ADMIN-AC-1.2, success criteria.

### Integration checkpoints

- **After Phase 2 — `recording-e2e`:** a real chat turn (and a rate-limited
  request) writes the expected `turn_record`, and forcing the recorder to throw
  leaves the turn unaffected. Verifies ADMIN-BR-3 against a real DB.
- **After Phase 5 — `admin-api-e2e`:** the admin API against a real seeded DB —
  non-admin blocked on every route, admin gets correctly shaped/filtered data.
- **After Phase 9 — `panel-e2e`:** sign in as an allowlisted admin, confirm a
  freshly-made chat turn surfaces in Overview and the Usage drill-down.

## Build Manifest

```yaml
commands:
  test: "cd web && npm test"
  test_one: "cd web && npx vitest run {file}"
  typecheck: "cd web && npm run typecheck"
  build: "cd web && npm run build"
  migrate: "cd web && npm run db:generate && npm run db:migrate"
phases:
  - id: p1
    name: Recording storage + write repo + pricing
    depends_on: []
    owns: ["web/src/data/repos/usage-repo.ts", "web/src/server/admin/pricing.ts",
           "web/src/data/repos/usage-repo.oracle.test.ts", "web/drizzle/**"]
    shared: ["web/src/data/schema.ts"]
    requirement_refs: [ADMIN-US-6, ADMIN-AC-6.1, ADMIN-AC-6.2, ADMIN-BR-5, ADMIN-BR-6, ADMIN-BR-7]
    test_focus: "insert/read-back, tool_error_count derivation, cost math"
  - id: p2
    name: Wire recording into chat + auth (non-blocking)
    depends_on: [p1]
    owns: []
    shared: ["web/src/agent/types.ts", "web/src/agent/runtime.ts",
             "web/src/app/api/chat/route.ts", "web/src/app/api/chat/route.test.ts",
             "web/src/server/auth/auth-service.ts"]
    requirement_refs: [ADMIN-US-6, ADMIN-AC-6.1, ADMIN-AC-6.2, ADMIN-AC-6.3, ADMIN-BR-3, ADMIN-BR-6]
    test_focus: "one record per turn; recorder failure never fails/delays turn; rate_limited row; auth events"
  - id: p3
    name: Admin auth gating
    depends_on: []
    owns: ["web/src/server/auth/admin.ts", "web/src/server/auth/admin.test.ts",
           "web/src/app/api/admin/_lib/guard.ts"]
    shared: ["web/src/env.ts"]
    requirement_refs: [ADMIN-US-1, ADMIN-AC-1.1, ADMIN-AC-1.2, ADMIN-AC-1.3, ADMIN-AC-1.4, ADMIN-BR-1]
    test_focus: "allowlist match/normalization; guard 401/403/pass"
  - id: p4
    name: Admin read repos
    depends_on: [p1]
    owns: ["web/src/data/repos/admin-analytics-repo.ts",
           "web/src/data/repos/admin-content-repo.ts",
           "web/src/lib/admin/admin-types.ts",
           "web/src/data/repos/admin-analytics-repo.oracle.test.ts",
           "web/src/data/repos/admin-content-repo.oracle.test.ts"]
    shared: []
    requirement_refs: [ADMIN-US-2, ADMIN-US-3, ADMIN-US-4, ADMIN-US-5, ADMIN-US-8, ADMIN-US-9, ADMIN-US-10, ADMIN-US-11, ADMIN-BR-8, ADMIN-BR-9]
    test_focus: "aggregation correctness, active-user distinct counts, cost rollups, error taxonomy, cross-account search/pagination"
  - id: p5
    name: Admin API endpoints
    depends_on: [p3, p4]
    owns: ["web/src/app/api/admin/overview/**", "web/src/app/api/admin/cost/**",
           "web/src/app/api/admin/errors/**", "web/src/app/api/admin/turns/**",
           "web/src/app/api/admin/accounts/**", "web/src/app/api/admin/conversations/**",
           "web/src/app/api/admin/teams/**", "web/src/app/api/admin/live/**",
           "web/src/app/api/admin/admin-routes.integration.test.ts"]
    shared: []
    requirement_refs: [ADMIN-US-1, ADMIN-US-2, ADMIN-US-3, ADMIN-US-4, ADMIN-US-5, ADMIN-US-7, ADMIN-US-8, ADMIN-US-9, ADMIN-US-10, ADMIN-US-11, ADMIN-BR-1, ADMIN-BR-2, ADMIN-BR-4]
    test_focus: "per-route gating, param defaults, response shapes, pagination"
  - id: p6
    name: Admin shell — gated layout, nav, shared components
    depends_on: [p5]
    owns: ["web/src/app/admin/layout.tsx", "web/src/app/admin/admin.css",
           "web/src/components/admin/**"]
    shared: []
    requirement_refs: [ADMIN-US-1]
    flags: [scaffold, ui]
    test_focus: "nav render; non-admin server-gate redirect; primitives render fixtures"
  - id: p7
    name: Observability screens
    depends_on: [p5, p6]
    owns: ["web/src/app/admin/page.tsx", "web/src/app/admin/cost/**",
           "web/src/app/admin/errors/**", "web/src/app/admin/usage/**"]
    shared: []
    requirement_refs: [ADMIN-US-2, ADMIN-US-3, ADMIN-US-4, ADMIN-US-5, ADMIN-US-7, ADMIN-AC-5.2]
    flags: [ui]
    test_focus: "fixture-rendered KPIs/series/filters; full drill-down breakdown; live polling"
  - id: p8
    name: Account & content screens
    depends_on: [p5, p6]
    owns: ["web/src/app/admin/accounts/**", "web/src/app/admin/conversations/**",
           "web/src/app/admin/teams/**"]
    shared: []
    requirement_refs: [ADMIN-US-8, ADMIN-US-9, ADMIN-US-10, ADMIN-US-11]
    flags: [ui]
    test_focus: "fixture lists/detail; search; thread reader; no mutating controls"
  - id: p9
    name: Integration, privacy disclosure, polish
    depends_on: [p2, p7, p8]
    owns: []
    shared: ["web/src/app/privacy/page.tsx", "web/src/app/page.tsx", "README.md", "CLAUDE.md"]
    requirement_refs: [ADMIN-BR-2, ADMIN-BR-4, ADMIN-BR-7, ADMIN-AC-1.2]
    test_focus: "end-to-end admin-only access; turn appears in panel; privacy copy present"
integration_checkpoints:
  - after: [p2]
    name: recording-e2e
    verifies: "a real chat turn (and a rate-limited request) writes the expected turn_record; recorder throw never affects the turn"
  - after: [p5]
    name: admin-api-e2e
    verifies: "admin API against a real seeded DB — non-admin blocked on every route, admin gets shaped/filtered data"
  - after: [p9]
    name: panel-e2e
    verifies: "allowlisted admin signs in and a freshly-made chat turn appears in Overview + Usage drill-down"
```

> `web/src/data/schema.ts`, `web/src/env.ts`, `web/src/app/page.tsx`,
> `web/src/app/privacy/page.tsx`, and the chat/auth files appear in `shared`
> (touched by one phase here, but they are pre-existing files edited in place —
> a parallel build must serialize edits to them).

## Technical Decisions

**AD-1 — In-app `/admin` route group, not a separate Vite SPA.**
Chosen: a protected section inside the existing Next.js app. Alternatives: a
standalone React+Vite SPA (the user's initial lean) talking to the admin API over
Bearer. Rationale: for one operator, the in-app section reuses auth, sessions,
repos, and the DB directly server-side — no second deploy, no CORS, no duplicate
token plumbing, and the admin bundle is code-split out of the main route anyway.
Tradeoff: admin code lives in the same repo/app (not independently deployable),
which is fine at this scale. (User-confirmed.)

**AD-2 — Recording via an `AgentContext.onTurnComplete` sink.**
Chosen: the runtime hands its already-assembled `TurnTrace` back through an
optional context callback; the route does the single DB write. Alternatives:
(a) change `runOak`'s return type to include the trace (ripples to all callers +
tests + eval); (b) write to the DB from inside the runtime (couples the pure,
provider-agnostic loop to persistence); (c) parse the pino log line by
`request_id` (brittle). Rationale: the sink is one optional field + one line in
`finalize()`, keeps persistence at the route (which already owns the non-blocking
post-answer write path), and leaves the runtime pure. Tradeoff: the route must
compose the record from two sources (trace + its own message/answer/account) —
trivial.

**AD-3 — Store full content for every turn; retain indefinitely.**
Chosen: persist `prompt_text` + `answer_text` + `answer_json` for guests and
signed-in alike, no prune. Alternative: metadata-only, or signed-in-only content.
Rationale: it's required for per-turn drill-down (ADMIN-AC-5.2) and reading what
guests asked (ADMIN-US-9/11). Tradeoff: guest content, ephemeral today, becomes
persisted → **privacy-policy disclosure required (Phase 9)**; storage grows
unbounded but is negligible at hobby volume (revisit retention if it grows).
(User-confirmed.)

**AD-4 — Record rate-limited rejections as `turn_record` rows (`status:"rate_limited"`).**
Chosen: a recorded "turn" superset status rather than a third table. Rationale:
keeps "every turn is recorded" literally true, gives the errors view and
heavy-user view a single source, and avoids extra surface. Tradeoff: the recorded
status set is a superset of the agent's `TurnStatus` — documented in the schema.

**AD-5 — Two-layer admin gating (API guard + server-component layout).**
Chosen: `requireAdminRequest` on every `/api/admin/*` route AND a server-side
redirect in `admin/layout.tsx`. Rationale: the API guard is the real boundary
(ADMIN-AC-1.4); the layout gate prevents even a flash of admin HTML to a
non-admin. Tradeoff: two checks to keep in sync — both call the same `isAdmin`.

**AD-6 — Cost is a static in-code price table, estimate-only.**
Chosen: `MODEL_PRICING` constant + `estimateCostUsd`; responses carry
`estimated:true`. Rationale: keeps the panel read-only (no editable settings,
ADMIN-BR-2/BR-5); provider billing stays authoritative. Tradeoff: prices are
updated by a code edit + deploy, not in the UI — acceptable for one operator.

**AD-7 — Search via `ilike`, aggregation via SQL `GROUP BY`.**
Chosen: substring `ilike` (matching the existing conversation search) and
`date_trunc` bucketing over `to_timestamp(created_at/1000)` with `.mapWith(Number)`.
Rationale: consistent with the codebase, no FTS infra. Tradeoff: substring search
is O(scan); a `pg_trgm` GIN index is the noted upgrade path if it ever matters.

## Deployment & Infrastructure (Hobby)

- **Hosting/runtime:** unchanged — the same single Fly machine serves `/admin`
  and `/api/admin/*` from the existing Next app.
- **Database:** the existing Postgres; two new append-only tables. `turn_record`
  carries `answer_json` (a few KB/turn); negligible at hobby volume, indefinite
  retention accepted (AD-3) with a noted revisit if it grows.
- **Migrations:** `npm run db:generate` then `npm run db:migrate`; the deploy
  already runs `migrate.mjs` as its release command, so the new tables ship on
  deploy.
- **Background jobs/queues:** none. Recording is in-process fire-and-forget; no
  prune cron (indefinite retention).
- **Secrets:** add `ADMIN_EMAILS` via `fly secrets set ADMIN_EMAILS=you@…`
  (comma-separated). No `ADMIN_EMAILS` set ⇒ zero admins ⇒ panel is dark
  (safe default).
- **Observability:** stdout logs unchanged; the new tables *are* the analytics
  store the panel reads.
- **Environments:** prod only (unchanged).
- **Added monthly cost: ~$0.**

## Unresolved from Requirements

All requirements open-questions were resolved during this design (content
storage = full/all, retention = indefinite, allowlist = env, pricing = static
config). Remaining minor, builder-discretion items — none block the build:
- **Chart dependency:** `recharts` vs hand-rolled SVG (Phase 6/7) — either is
  fine; pick at scaffold time.
- **Live poll interval:** default ~10s for `/api/admin/live` (ADMIN-BR-10) —
  tune during Phase 7.
- **`pg_trgm` GIN index:** deferred; add only if substring search gets slow.
- **Admin audit trail** (logging the owner's own reads) remains intentionally
  out of scope per requirements; revisit only if a second admin is ever added.
```

