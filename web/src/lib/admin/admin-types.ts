/**
 * src/lib/admin/admin-types.ts — the CLIENT-SAFE shared request/response wire
 * types for the admin panel. This is the single seam imported by BOTH the admin
 * read repos (`admin-analytics-repo.ts`, `admin-content-repo.ts`) AND the
 * `/api/admin/*` route handlers AND the `/admin` pages/components, so the shapes
 * a route returns and a page renders can never drift.
 *
 * Design refs:
 *   - docs/features/admin-panel/architecture/design.md
 *       § API Design (common query params; response shapes)
 *       § Interface Definitions › admin-analytics-repo / admin-content-repo
 *       § Component Design › 3 (admin read repos) + 5 ("a shared client-safe
 *         wire-types module … imported by both the API handlers and the pages")
 *       § Technical Decisions AD-6 (cost is an estimate → `estimated: true`),
 *         AD-7 (search/aggregation), AD-4 (`rate_limited` is a recorded status).
 *   - requirements.md ADMIN-US-2/3/4/5/7/8/9/10/11, ADMIN-AC-5.1/5.2/8.x/11.x,
 *     ADMIN-BR-5 (cost estimate), ADMIN-BR-8 (date-range scoping),
 *     ADMIN-BR-9 (failure taxonomy).
 *
 * CLIENT-SAFE: pure types/constants only — NO `server-only`, NO `@/data/db`,
 * NO SDK imports. The two imports below are erased at compile time
 * (`import type`), so this module pulls nothing server- or Node-bound into a
 * client bundle:
 *   - `ToolTraceEntry` is the canonical per-tool-call trace shape (owned by
 *     `@/server/logger`); reusing it keeps the drill-down (ADMIN-AC-5.2) aligned
 *     with what the runtime records instead of re-declaring a parallel shape.
 *   - `TeamMember` is the portable team data model (`@/data/teams/team-schema`,
 *     listed as a mobile-portable module in CLAUDE.md).
 */

import type { TeamMember } from "@/data/teams/team-schema";
import type { ToolTraceEntry } from "@/server/logger";

// ---------------------------------------------------------------------------
// Shared scalar unions / dimensions
// ---------------------------------------------------------------------------

/** Time bucket granularity for analytics series (API param `bucket`). */
export type BucketSize = "day" | "hour";

/** The active format/mode a turn ran under (mirrors `AgentMode`). */
export type TurnMode = "standard" | "champions";

/**
 * The recorded turn status. Superset of the agent's `TurnStatus`: it adds
 * `rate_limited`, because a rate-limit rejection is recorded as a `turn_record`
 * row too (AD-4) so "every turn is recorded" stays literally true.
 */
export type TurnRecordStatus =
  | "answered"
  | "clarification_needed"
  | "resolution_failed"
  | "insufficient_data"
  | "rate_limited";

/** Guest-vs-signed-in filter dimension (API param `kind`). */
export type TurnKind = "guest" | "signed";

/** Sort modes for the accounts list (drives the heavy-user view, AC-11.1). */
export type AccountSort = "recent" | "turns" | "cost" | "errors";

/** Sort modes for the analytics heavy-user ranking (getHeavyUsers). */
export type HeavyUserSort = "turns" | "cost" | "errors";

/**
 * The errors-view failure taxonomy (ADMIN-BR-9): any non-`answered` turn
 * outcome, plus tool-trace errors, OTP delivery failures, and rate-limit
 * rejections. Each category links to a matching `turns` filter (ADMIN-AC-4.2).
 */
export type ErrorCategoryKey =
  | "resolution_failed"
  | "clarification_needed"
  | "insufficient_data"
  | "tool_error"
  | "otp_email_failed"
  | "rate_limited";

// ---------------------------------------------------------------------------
// Common request shapes (built by the routes from query params; consumed by the
// repos). Validation is lenient — bad/missing → sensible defaults, never 500.
// ---------------------------------------------------------------------------

/** A resolved analytics window (API params `from`/`to`/`bucket`; ADMIN-BR-8). */
export interface Range {
  from: number; // epoch ms (inclusive)
  to: number; // epoch ms (exclusive)
  bucket: BucketSize;
}

/** Filter/search/pagination input for the turns explorer (ADMIN-AC-5.1). */
export interface TurnFilter {
  from?: number;
  to?: number;
  model?: string;
  mode?: string;
  status?: string;
  kind?: TurnKind;
  accountId?: string;
  sessionId?: string;
  q?: string; // substring search over prompt/answer (ilike, AD-7)
  limit: number;
  cursor?: string; // keyset cursor on (created_at, id)
}

/** Options for the cross-account accounts list (ADMIN-US-8, heavy users US-11). */
export interface AccountListOpts {
  q?: string; // email substring search (ilike)
  sort?: AccountSort;
  limit: number;
  cursor?: string;
}

/** Options for the cross-account conversations browser (ADMIN-US-9). */
export interface ConversationListOpts {
  q?: string; // title-or-message substring search (ilike)
  format?: string;
  limit: number;
  cursor?: string;
}

/** Options for the cross-account teams browser (ADMIN-US-10). */
export interface TeamListOpts {
  q?: string; // name substring search (ilike)
  format?: string;
  limit: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Generic pagination envelope (keyset on (created_at, id), AD-7)
// ---------------------------------------------------------------------------

/** A page of rows plus the opaque cursor for the next page (null = last page). */
export interface Paginated<Row> {
  rows: Row[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Turn rows — list projection + full drill-down
// ---------------------------------------------------------------------------

/**
 * Summary projection of a `turn_record` row for the turns list and the live
 * view — the scalar columns plus the searchable prompt and an estimated cost
 * (ADMIN-BR-5), but NOT the heavy JSON (`tool_trace` / `answer_json`).
 * `accountEmail` is LEFT-JOINed from `account` for display (null for guests).
 */
export interface TurnSummary {
  id: string; // = request_id (turn PK)
  sessionId: string;
  accountId: string | null; // null = guest turn
  accountEmail: string | null; // joined; null for guests
  model: string | null; // ModelKey; null for a rate_limited row (no model resolved)
  providerModel: string | null;
  mode: TurnMode;
  status: TurnRecordStatus;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolErrorCount: number; // denormalized count of tool_trace entries with error != null
  citationCount: number;
  turnLatencyMs: number;
  imagesCount: number;
  promptText: string; // user message (may be empty for an image-only turn)
  estUsd: number; // estimated USD cost (ADMIN-BR-5; unpriced/unknown model → 0)
  createdAt: number; // epoch ms
}

/**
 * Full per-turn drill-down (ADMIN-AC-5.2): everything in {@link TurnSummary}
 * plus the parsed `tool_trace`, the full `answer_text`, and the raw
 * `answer_json` (the complete `OakAnswer` for re-render). `answerText` /
 * `answerJson` are null for a `rate_limited` row.
 */
export interface TurnDetail {
  id: string;
  sessionId: string;
  accountId: string | null;
  accountEmail: string | null;
  model: string | null;
  providerModel: string | null;
  mode: TurnMode;
  status: TurnRecordStatus;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTrace: ToolTraceEntry[]; // parsed from the stored JSON
  toolErrorCount: number;
  citationCount: number;
  turnLatencyMs: number;
  imagesCount: number;
  promptText: string;
  answerText: string | null;
  answerJson: string | null; // raw OakAnswer JSON for the answer-card re-render
  estUsd: number; // estimated USD cost (ADMIN-BR-5)
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Account rows — list + detail with derived activity
// ---------------------------------------------------------------------------

/**
 * An account enriched with derived activity (ADMIN-AC-8.1/8.2, ADMIN-AC-11.1).
 * Activity is over the account's full lifetime (the accounts list is not
 * date-range scoped; range-scoped heavy users use {@link HeavyUserRow}).
 */
export interface AccountWithActivity {
  id: string;
  email: string;
  createdAt: number; // signup date (AC-8.1)
  turns: number; // total recorded turns
  lastActiveAt: number | null; // most-recent turn createdAt (null = never chatted)
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number; // input + output + thinking
  estUsd: number; // estimated cost attributable to the account (ADMIN-BR-5)
  conversations: number; // saved conversation count
  teams: number; // saved team count
  rateLimited: number; // count of rate_limited turns (AC-11.1)
  failed: number; // count of non-answered (failure) turns (AC-11.1)
}

/** One active session row for the account-detail view (ADMIN-AC-8.3). */
export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A row in the analytics heavy-user ranking (getHeavyUsers). Unlike
 * {@link AccountWithActivity} this is date-range scoped and includes GUEST
 * activity (ADMIN-AC-11.1 ranks "accounts and guest sessions"): a guest row has
 * `accountId: null` / `email: null` and is grouped by its session.
 */
export interface HeavyUserRow {
  accountId: string | null; // null = guest session
  email: string | null;
  turns: number;
  estUsd: number;
  rateLimited: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Conversation + team rows (cross-account, un-scoped variants)
// ---------------------------------------------------------------------------

/**
 * Cross-account conversation list projection (ADMIN-US-9). Like the user-facing
 * `ConversationSummary` but carries the owning account so the operator can see
 * whose thread it is (ADMIN-BR-4 owner-only full read access). `accountId: null`
 * is a synthetic guest-session pseudo-conversation, reconstructed from that
 * session's `turn_record` rows rather than a real `conversation` row (mirrors
 * the `TurnSummary`/`HeavyUserRow` guest convention elsewhere in this file).
 */
export interface ConversationSummary {
  id: string;
  accountId: string | null; // null = guest session (no real `conversation` row)
  accountEmail: string | null; // joined from account; null for guests too
  title: string;
  format: string; // "scarlet-violet" | "champions"
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * One stored turn within a conversation thread (ADMIN-AC-9.2). `answerJson` is
 * the full `OakAnswer` JSON on assistant rows, null on user rows. Mirrors the
 * shape returned by the user-facing conversation repo's `getMessages`.
 */
export interface StoredTurn {
  id: string;
  role: "user" | "assistant";
  seq: number;
  textContent: string;
  answerJson: string | null;
  createdAt: number;
}

/**
 * Cross-account saved-team list projection (ADMIN-US-10). Like the user-facing
 * `TeamSummary` but carries the owning account.
 */
export interface TeamSummary {
  id: string;
  accountId: string;
  accountEmail: string | null; // joined from account
  name: string;
  format: string; // "scarlet-violet" | "champions"
  memberCount: number;
  incomplete: boolean; // < 6 members, or any missing species / 4th move
  species: string[]; // filled-slot species slugs, in slot order
  createdAt: number;
  updatedAt: number;
}

/** A saved team with full members for the team-detail reader (ADMIN-AC-10.1). */
export interface TeamDetail {
  id: string;
  accountId: string;
  accountEmail: string | null;
  name: string;
  format: string;
  members: TeamMember[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Analytics aggregation building blocks (repo result pieces)
// ---------------------------------------------------------------------------

/** One time bucket of the usage series (ADMIN-AC-2.1/2.2). */
export interface UsageBucket {
  t: number; // bucket start, epoch ms
  turns: number;
  activeSigned: number; // distinct signed-in accounts active in the bucket
  activeGuest: number; // distinct guest sessions active in the bucket
  signups: number; // new accounts created in the bucket
}

/** Range totals accompanying the usage series. */
export interface UsageTotals {
  turns: number;
  activeSigned: number; // distinct over the whole range
  activeGuest: number; // distinct over the whole range
  signups: number;
  guestTurns: number; // turns with account_id null
  signedTurns: number; // turns with account_id set
}

/** Token + estimated-cost rollup for one model (ADMIN-AC-3.1/3.2). */
export interface CostByModel {
  model: string; // ModelKey, or a stored value with no price entry
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  estUsd: number; // estimated; 0 when unpriced
  priced: boolean; // false when the model has no entry in MODEL_PRICING
}

/** One time bucket of estimated cost (ADMIN-AC-3.2 cost trend). */
export interface CostBucket {
  t: number; // bucket start, epoch ms
  estUsd: number;
}

/** One failure category over the range (ADMIN-AC-4.1, ADMIN-BR-9). */
export interface ErrorCategory {
  key: ErrorCategoryKey;
  count: number;
  ratePct: number; // count / totalTurns * 100
}

/** Current-window live counters (ADMIN-AC-7.1). */
export interface LiveWindow {
  lastHourTurns: number;
  lastHourActive: number; // distinct sessions active in the last hour
}

// ---------------------------------------------------------------------------
// Analytics repo result types (admin-analytics-repo.ts)
// ---------------------------------------------------------------------------

/** Result of getUsageSeries (per-bucket series + range totals). */
export interface UsageSeriesResult {
  buckets: UsageBucket[];
  totals: UsageTotals;
}

/** Result of getCostBreakdown. Carries `estimated: true` (ADMIN-BR-5). */
export interface CostBreakdownResult {
  byModel: CostByModel[];
  series: CostBucket[];
  totalEstUsd: number;
  estimated: true;
}

/** Result of getErrorBreakdown (ADMIN-BR-9 taxonomy). */
export interface ErrorBreakdownResult {
  categories: ErrorCategory[];
  totalTurns: number;
}

/** Result of getHeavyUsers (ranked accounts + guest sessions, AC-11.1). */
export interface HeavyUsersResult {
  rows: HeavyUserRow[];
}

// ---------------------------------------------------------------------------
// API response wrappers (GET /api/admin/*) — imported by routes AND pages
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/overview — KPI totals + per-bucket usage series + headline
 * estimated cost & error rate over the range (ADMIN-US-2/3/4 headline).
 */
export interface OverviewResponse {
  range: Range; // the resolved window (echoes defaults; ADMIN-BR-8)
  totals: UsageTotals;
  buckets: UsageBucket[];
  totalEstUsd: number; // headline estimated cost over the range
  estimated: true; // the cost figure is an estimate (ADMIN-BR-5)
  errorRatePct: number; // failures / totalTurns * 100 (ADMIN-BR-9)
}

/** GET /api/admin/cost — token totals & estimated USD by model + cost series. */
export interface CostResponse extends CostBreakdownResult {
  range: Range;
}

/** GET /api/admin/errors — counts/rates by failure category over the range. */
export interface ErrorsResponse extends ErrorBreakdownResult {
  range: Range;
}

/** GET /api/admin/turns — paginated, filtered turn rows (summary projection). */
export type TurnsListResponse = Paginated<TurnSummary>;

/** GET /api/admin/turns/{id} — the full turn record for drill-down. */
export interface TurnDetailResponse {
  turn: TurnDetail;
}

/** GET /api/admin/accounts — accounts + derived activity (sort drives US-11). */
export type AccountsResponse = Paginated<AccountWithActivity>;

/** GET /api/admin/accounts/{id} — account activity + active sessions. */
export interface AccountDetailResponse {
  account: AccountWithActivity;
  sessions: SessionInfo[];
}

/** GET /api/admin/conversations — paginated cross-account conversation list. */
export type ConversationsListResponse = Paginated<ConversationSummary>;

/** GET /api/admin/conversations/{id} — the full thread for reading. */
export interface ConversationThreadResponse {
  summary: ConversationSummary;
  turns: StoredTurn[];
}

/** GET /api/admin/teams — paginated cross-account saved-team list. */
export type TeamsListResponse = Paginated<TeamSummary>;

/** GET /api/admin/teams/{id} — a saved team with full members. */
export interface TeamDetailResponse {
  team: TeamDetail;
}

/** GET /api/admin/live — last N turns + current-window counters (ADMIN-US-7). */
export interface LiveResponse {
  recent: TurnSummary[];
  window: LiveWindow;
}
