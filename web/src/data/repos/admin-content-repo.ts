/**
 * src/data/repos/admin-content-repo.ts — the SOLE Postgres reader for the admin
 * panel's CROSS-ACCOUNT (un-scoped) row reads.
 *
 * Design refs:
 *   - docs/features/admin-panel/architecture/design.md
 *       § Component Design › 3 (Admin read repos — admin-content-repo)
 *       § Interface Definitions › admin-content-repo (these exact signatures)
 *       § API Design (common query params: from/to/model/mode/status/kind/
 *         accountId/sessionId/q/limit/cursor)
 *       § Technical Decisions AD-7 (search via ilike, keyset on (created_at,id)),
 *         AD-6 (cost is an estimate → estUsd), AD-3/AD-4 (full content; the
 *         rate_limited status row).
 *   - requirements.md ADMIN-US-5/8/9/10/11, ADMIN-AC-5.1/5.2/8.x/9.x/10.x/11.x,
 *     ADMIN-BR-2 (READ-ONLY — this repo NEVER writes), ADMIN-BR-4 (owner-only
 *     full read), ADMIN-BR-8 (date-range scoping), ADMIN-BR-9 (failure taxonomy).
 *
 * Boundary rules (CLAUDE.md "repos are the sole Postgres readers"; mirrors
 * conversation-repo.ts / team-repo.ts):
 *   - `import "server-only"` — never bundled to the client.
 *   - Reads the memoized `@/data/db` singleton directly (NOT a per-request ctx).
 *   - DB columns are snake_case (Drizzle); returned objects are camelCase.
 *     Epoch-ms timestamps are `bigint` mode "number"; count/sum computed columns
 *     use `.mapWith(Number)` (node-postgres returns bigint as a string).
 *   - Substring search is `ilike` (Postgres `LIKE` is case-sensitive), matching
 *     the existing conversation search; user-typed `%`/`_`/`\` are escaped so
 *     search stays a plain substring filter, not a wildcard surface.
 *
 * UN-SCOPED, by design: unlike conversation-repo / team-repo (which hard-scope
 * EVERY query to `account_id`), these reads span ALL accounts AND guest turns —
 * that is the whole point of the admin panel (ADMIN-BR-4). The HTTP guard
 * (`requireAdminRequest`) is the access boundary, not the query.
 *
 * READ-ONLY (ADMIN-BR-2): there is not a single INSERT/UPDATE/DELETE here.
 *
 * Error style (matches the existing repos): not in-domain Result unions — return
 * `null` for a clean miss and let GENUINE faults propagate (a DB error, or a
 * corrupted `members` payload that fails Zod, surfaces as a rejected promise at
 * the route/transport seam). Pagination/filter inputs are treated leniently: a
 * bad cursor or non-finite range bound is ignored rather than throwing.
 */

import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { AgentMode } from "@/agent/types";
import { db } from "@/data/db";
import { formatForMode, isFormat, modeForFormat } from "@/data/formats";
import {
  account,
  auth_session,
  conversation,
  conversation_message,
  team,
  turn_record,
} from "@/data/schema";
import { teamMembersSchema, type TeamMember } from "@/data/teams/team-schema";
import { estimateCostUsd } from "@/server/admin/pricing";
import { deriveTitle } from "@/server/history/derive-title";
import type { ToolTraceEntry } from "@/server/logger";
import type {
  AccountDetailResponse,
  AccountListOpts,
  AccountSort,
  AccountWithActivity,
  ConversationListOpts,
  ConversationSummary,
  ConversationThreadResponse,
  Paginated,
  SessionInfo,
  StoredTurn,
  TeamDetail,
  TeamListOpts,
  TeamSummary,
  TurnDetail,
  TurnFilter,
  TurnMode,
  TurnRecordStatus,
  TurnSummary,
} from "@/lib/admin/admin-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape LIKE/ILIKE metacharacters so a user-typed `%`/`_`/`\` matches literally
 * (Postgres ILIKE's default ESCAPE is backslash). Keeps search a plain substring
 * filter (AD-7), mirroring conversation-repo.likePattern.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Clamp a requested page size into a sane range (lenient: bad/0/∞ → default). */
function clampLimit(n: number, def = 50, max = 200): number {
  const v = Math.trunc(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(v, max);
}

/**
 * Opaque keyset cursor over an `(timeValue, id)` tuple — the ordering key for
 * the turns / conversations / teams lists (AD-7). Encoded base64url so the wire
 * value is opaque; decode is defensive (a malformed cursor → `null` → page one).
 */
function encodeKeysetCursor(timeValue: number, id: string): string {
  return Buffer.from(`${timeValue}:${id}`, "utf8").toString("base64url");
}
function decodeKeysetCursor(
  cursor: string | undefined,
): { t: number; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    const t = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(t) || id === "") return null;
    return { t, id };
  } catch {
    return null;
  }
}

/** Opaque id-position cursor (used by the JS-sorted accounts list). */
function encodeIdCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeIdCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/** Parse + validate a stored team `members` JSON payload (team-repo invariant). */
function parseMembers(raw: string): TeamMember[] {
  return teamMembersSchema.parse(JSON.parse(raw));
}

/** A partial team is "incomplete": <6 members, or any missing species / 4 moves. */
function isIncomplete(members: TeamMember[]): boolean {
  return (
    members.length < 6 ||
    members.some((m) => m.species === null || m.moves.length < 4)
  );
}

/**
 * Coerce a possibly-string (bigint/count/sum) raw `db.execute` value to a finite
 * number — node-postgres returns bigint columns as strings (mirrors
 * admin-analytics-repo.ts's `num`, needed here only for the guest-conversation
 * UNION query, which can't be expressed through the query builder).
 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A raw result row from `db.execute` (loosely typed; coerced field-by-field). */
function rowsOf(res: { rows: unknown[] }): Record<string, unknown>[] {
  return res.rows as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Turns — filtered/searched/paginated list + single-record drill-down
// ---------------------------------------------------------------------------

/**
 * Cross-account turns explorer (ADMIN-US-5, ADMIN-AC-5.1). Returns the summary
 * projection (scalar columns + the searchable prompt + an estimated cost) — NOT
 * the heavy JSON (`tool_trace` / `answer_json`); those come from {@link getTurn}.
 * `accountEmail` is LEFT-JOINed for display (null for guest turns). Keyset
 * paginated on `(created_at, id)` DESC; `nextCursor` is null on the last page.
 *
 * Filters (all optional, lenient): `from` (inclusive) / `to` (EXCLUSIVE, matching
 * the analytics `Range`), `model`, `mode`, `status`, `kind` (guest = null
 * account, signed = non-null), `accountId`, `sessionId`, `q` (ilike over
 * prompt_text OR answer_text).
 */
export async function listTurns(
  f: TurnFilter,
): Promise<Paginated<TurnSummary>> {
  const lim = clampLimit(f.limit);
  const conditions: SQL[] = [];

  if (typeof f.from === "number" && Number.isFinite(f.from)) {
    conditions.push(gte(turn_record.created_at, f.from));
  }
  if (typeof f.to === "number" && Number.isFinite(f.to)) {
    conditions.push(lt(turn_record.created_at, f.to));
  }
  if (f.model) conditions.push(eq(turn_record.model, f.model));
  if (f.mode) conditions.push(eq(turn_record.mode, f.mode));
  if (f.status) conditions.push(eq(turn_record.status, f.status));
  if (f.kind === "guest") conditions.push(isNull(turn_record.account_id));
  else if (f.kind === "signed")
    conditions.push(isNotNull(turn_record.account_id));
  if (f.accountId) conditions.push(eq(turn_record.account_id, f.accountId));
  if (f.sessionId) conditions.push(eq(turn_record.session_id, f.sessionId));

  const q = f.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    conditions.push(
      or(
        ilike(turn_record.prompt_text, pattern),
        ilike(turn_record.answer_text, pattern),
      )!,
    );
  }

  const cursor = decodeKeysetCursor(f.cursor);
  if (cursor) {
    conditions.push(
      or(
        lt(turn_record.created_at, cursor.t),
        and(eq(turn_record.created_at, cursor.t), lt(turn_record.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: turn_record.id,
      sessionId: turn_record.session_id,
      accountId: turn_record.account_id,
      accountEmail: account.email,
      model: turn_record.model,
      providerModel: turn_record.provider_model,
      mode: turn_record.mode,
      status: turn_record.status,
      inputTokens: turn_record.input_tokens,
      outputTokens: turn_record.output_tokens,
      thinkingTokens: turn_record.thinking_tokens,
      toolErrorCount: turn_record.tool_error_count,
      citationCount: turn_record.citation_count,
      turnLatencyMs: turn_record.turn_latency_ms,
      imagesCount: turn_record.images_count,
      promptText: turn_record.prompt_text,
      createdAt: turn_record.created_at,
    })
    .from(turn_record)
    .leftJoin(account, eq(account.id, turn_record.account_id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(turn_record.created_at), desc(turn_record.id))
    .limit(lim + 1);

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const summaries: TurnSummary[] = page.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    accountId: r.accountId,
    accountEmail: r.accountEmail ?? null,
    model: r.model,
    providerModel: r.providerModel,
    mode: r.mode as TurnMode,
    status: r.status as TurnRecordStatus,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    thinkingTokens: r.thinkingTokens,
    toolErrorCount: r.toolErrorCount,
    citationCount: r.citationCount,
    turnLatencyMs: r.turnLatencyMs,
    imagesCount: r.imagesCount,
    promptText: r.promptText,
    estUsd: estimateCostUsd({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      thinkingTokens: r.thinkingTokens,
    }),
    createdAt: r.createdAt,
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeKeysetCursor(last.createdAt, last.id) : null;
  return { rows: summaries, nextCursor };
}

/**
 * The full per-turn drill-down (ADMIN-AC-5.2): every {@link TurnSummary} field
 * plus the parsed `tool_trace`, the full `answer_text`, and the raw `answer_json`
 * (the complete `OakAnswer` for the answer-card re-render). `answerText` /
 * `answerJson` are null for a `rate_limited` row (AD-4). Returns `null` if no
 * turn with `id` exists. The stored `tool_trace` JSON is parsed defensively (a
 * corrupt value yields an empty trace rather than throwing).
 */
export async function getTurn(id: string): Promise<TurnDetail | null> {
  const rows = await db
    .select({
      id: turn_record.id,
      sessionId: turn_record.session_id,
      accountId: turn_record.account_id,
      accountEmail: account.email,
      model: turn_record.model,
      providerModel: turn_record.provider_model,
      mode: turn_record.mode,
      status: turn_record.status,
      inputTokens: turn_record.input_tokens,
      outputTokens: turn_record.output_tokens,
      thinkingTokens: turn_record.thinking_tokens,
      toolTrace: turn_record.tool_trace,
      toolErrorCount: turn_record.tool_error_count,
      citationCount: turn_record.citation_count,
      turnLatencyMs: turn_record.turn_latency_ms,
      imagesCount: turn_record.images_count,
      promptText: turn_record.prompt_text,
      answerText: turn_record.answer_text,
      answerJson: turn_record.answer_json,
      createdAt: turn_record.created_at,
    })
    .from(turn_record)
    .leftJoin(account, eq(account.id, turn_record.account_id))
    .where(eq(turn_record.id, id))
    .limit(1);

  const r = rows[0];
  if (!r) return null;

  let toolTrace: ToolTraceEntry[] = [];
  try {
    const parsed = JSON.parse(r.toolTrace ?? "[]");
    if (Array.isArray(parsed)) toolTrace = parsed as ToolTraceEntry[];
  } catch {
    toolTrace = [];
  }

  return {
    id: r.id,
    sessionId: r.sessionId,
    accountId: r.accountId,
    accountEmail: r.accountEmail ?? null,
    model: r.model,
    providerModel: r.providerModel,
    mode: r.mode as TurnMode,
    status: r.status as TurnRecordStatus,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    thinkingTokens: r.thinkingTokens,
    toolTrace,
    toolErrorCount: r.toolErrorCount,
    citationCount: r.citationCount,
    turnLatencyMs: r.turnLatencyMs,
    imagesCount: r.imagesCount,
    promptText: r.promptText,
    answerText: r.answerText,
    answerJson: r.answerJson,
    estUsd: estimateCostUsd({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      thinkingTokens: r.thinkingTokens,
    }),
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Accounts — list + detail, with derived activity
// ---------------------------------------------------------------------------

/**
 * Compute {@link AccountWithActivity} for a set of base account rows. Activity is
 * over each account's full lifetime (the accounts list is NOT date-range scoped):
 * recorded-turn count, last-active timestamp, token totals, an estimated cost
 * (model-aware — summed per-model so mixed-model accounts are priced correctly),
 * saved-conversation/team counts, and the misuse counters (ADMIN-AC-11.1):
 * `rateLimited` (status `rate_limited`) and `failed` (an answer failure —
 * `resolution_failed` / `insufficient_data`; `clarification_needed` is a normal
 * outcome and `rate_limited` has its own column, so neither is counted here).
 */
async function activityForAccounts(
  base: { id: string; email: string; createdAt: number }[],
): Promise<AccountWithActivity[]> {
  if (base.length === 0) return [];
  const ids = base.map((b) => b.id);

  // Per (account, model) turn aggregate — model is part of the key so estUsd can
  // be priced per model and rolled up in JS (AD-6); a rate_limited row's null
  // model groups together and prices to $0.
  const turnRows = await db
    .select({
      accountId: turn_record.account_id,
      model: turn_record.model,
      turns: sql<number>`count(*)`.mapWith(Number),
      inputTokens:
        sql<number>`coalesce(sum(${turn_record.input_tokens}), 0)`.mapWith(
          Number,
        ),
      outputTokens:
        sql<number>`coalesce(sum(${turn_record.output_tokens}), 0)`.mapWith(
          Number,
        ),
      thinkingTokens:
        sql<number>`coalesce(sum(${turn_record.thinking_tokens}), 0)`.mapWith(
          Number,
        ),
      lastActiveAt: sql<number>`max(${turn_record.created_at})`.mapWith(Number),
      rateLimited:
        sql<number>`coalesce(sum(case when ${turn_record.status} = 'rate_limited' then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      failed:
        sql<number>`coalesce(sum(case when ${turn_record.status} in ('resolution_failed', 'insufficient_data') then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
    })
    .from(turn_record)
    .where(inArray(turn_record.account_id, ids))
    .groupBy(turn_record.account_id, turn_record.model);

  const convRows = await db
    .select({
      accountId: conversation.account_id,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(conversation)
    .where(inArray(conversation.account_id, ids))
    .groupBy(conversation.account_id);

  const teamRows = await db
    .select({
      accountId: team.account_id,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(team)
    .where(inArray(team.account_id, ids))
    .groupBy(team.account_id);

  interface Acc {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    lastActiveAt: number | null;
    rateLimited: number;
    failed: number;
    estUsd: number;
  }
  const agg = new Map<string, Acc>();
  for (const r of turnRows) {
    const aid = r.accountId;
    if (aid == null) continue; // inArray excludes nulls, but be defensive.
    let a = agg.get(aid);
    if (!a) {
      a = {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        lastActiveAt: null,
        rateLimited: 0,
        failed: 0,
        estUsd: 0,
      };
      agg.set(aid, a);
    }
    a.turns += r.turns;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.thinkingTokens += r.thinkingTokens;
    a.rateLimited += r.rateLimited;
    a.failed += r.failed;
    a.lastActiveAt =
      a.lastActiveAt == null
        ? r.lastActiveAt
        : Math.max(a.lastActiveAt, r.lastActiveAt);
    a.estUsd += estimateCostUsd({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      thinkingTokens: r.thinkingTokens,
    });
  }

  const convMap = new Map(
    convRows.map((r) => [r.accountId, r.n] as const),
  );
  const teamMap = new Map(
    teamRows.map((r) => [r.accountId, r.n] as const),
  );

  return base.map((b) => {
    const a = agg.get(b.id);
    const inputTokens = a?.inputTokens ?? 0;
    const outputTokens = a?.outputTokens ?? 0;
    const thinkingTokens = a?.thinkingTokens ?? 0;
    return {
      id: b.id,
      email: b.email,
      createdAt: b.createdAt,
      turns: a?.turns ?? 0,
      lastActiveAt: a?.lastActiveAt ?? null,
      inputTokens,
      outputTokens,
      thinkingTokens,
      totalTokens: inputTokens + outputTokens + thinkingTokens,
      estUsd: a?.estUsd ?? 0,
      conversations: convMap.get(b.id) ?? 0,
      teams: teamMap.get(b.id) ?? 0,
      rateLimited: a?.rateLimited ?? 0,
      failed: a?.failed ?? 0,
    };
  });
}

/** Total, deterministic comparator for the accounts list under each sort mode. */
function sortAccounts(
  rows: AccountWithActivity[],
  sort: AccountSort,
): AccountWithActivity[] {
  const idDesc = (a: AccountWithActivity, b: AccountWithActivity) =>
    a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  const copy = [...rows];
  switch (sort) {
    case "turns":
      copy.sort(
        (a, b) => b.turns - a.turns || b.createdAt - a.createdAt || idDesc(a, b),
      );
      break;
    case "cost":
      copy.sort(
        (a, b) => b.estUsd - a.estUsd || b.turns - a.turns || idDesc(a, b),
      );
      break;
    case "errors":
      copy.sort(
        (a, b) =>
          b.failed + b.rateLimited - (a.failed + a.rateLimited) ||
          b.turns - a.turns ||
          idDesc(a, b),
      );
      break;
    case "recent":
    default:
      copy.sort((a, b) => b.createdAt - a.createdAt || idDesc(a, b));
      break;
  }
  return copy;
}

/**
 * Cross-account accounts list with derived activity (ADMIN-US-8). `sort` drives
 * the heavy-user view (ADMIN-US-11): `recent` (signup, default) | `turns` |
 * `cost` | `errors`. `q` is an email substring (ilike).
 *
 * The activity rollup and the metric sorts are computed in JS (the cost figure
 * is model-aware and the metrics aren't expressible as a plain column keyset),
 * so pagination is a stable id-position seek over the deterministic sort rather
 * than a column keyset — equivalent at hobby volume (the AD-7 O(scan) tradeoff).
 */
export async function listAccounts(
  opts: AccountListOpts,
): Promise<Paginated<AccountWithActivity>> {
  const lim = clampLimit(opts.limit);
  const conditions: SQL[] = [];
  const q = opts.q?.trim();
  if (q) conditions.push(ilike(account.email, likePattern(q)));

  const baseRows = await db
    .select({
      id: account.id,
      email: account.email,
      createdAt: account.created_at,
    })
    .from(account)
    .where(conditions.length ? and(...conditions) : undefined);

  const enriched = await activityForAccounts(baseRows);
  const sorted = sortAccounts(enriched, opts.sort ?? "recent");

  const cursorId = decodeIdCursor(opts.cursor);
  let start = 0;
  if (cursorId) {
    const idx = sorted.findIndex((a) => a.id === cursorId);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const rows = sorted.slice(start, start + lim);
  const last = rows[rows.length - 1];
  const nextCursor =
    last && start + lim < sorted.length ? encodeIdCursor(last.id) : null;
  return { rows, nextCursor };
}

/**
 * One account's full detail (ADMIN-AC-8.x): its derived activity plus its
 * currently-active device sessions (expires_at in the future), most recent
 * first. Returns `null` if no account with `accountId` exists. READ-ONLY — never
 * revokes a session (ADMIN-BR-2).
 */
export async function getAccountDetail(
  accountId: string,
): Promise<AccountDetailResponse | null> {
  const baseRows = await db
    .select({
      id: account.id,
      email: account.email,
      createdAt: account.created_at,
    })
    .from(account)
    .where(eq(account.id, accountId))
    .limit(1);
  const base = baseRows[0];
  if (!base) return null;

  const [activity] = await activityForAccounts([base]);

  const now = Date.now();
  const sessions: SessionInfo[] = await db
    .select({
      id: auth_session.id,
      createdAt: auth_session.created_at,
      expiresAt: auth_session.expires_at,
    })
    .from(auth_session)
    .where(
      and(
        eq(auth_session.account_id, accountId),
        gt(auth_session.expires_at, now),
      ),
    )
    .orderBy(desc(auth_session.created_at));

  return { account: activity, sessions };
}

// ---------------------------------------------------------------------------
// Conversations — cross-account list + full thread (un-scoped variants)
// ---------------------------------------------------------------------------

/**
 * Cross-account conversation browser (ADMIN-US-9) — the un-scoped variant of the
 * user-facing `listConversations`, carrying the owning account (id + joined
 * email) so the operator can see whose thread it is. `q` matches the title OR any
 * message text (ilike); `format` filters exactly. Keyset paginated on
 * `(updated_at, id)` DESC (most recently active first).
 *
 * ALSO includes guest sessions: a guest never gets a real `conversation` row
 * (HIST-AD-1 — only signed-in turns are saved there), but every guest turn is
 * already durably recorded in `turn_record` (account_id IS NULL). Guest turns are
 * grouped by `session_id` into a synthetic conversation row (`accountId`/
 * `accountEmail` both null, mirroring the existing `HeavyUserRow` guest
 * convention) and UNIONed with the real rows so both are sorted/paginated
 * together by `updated_at`. Since `conversation.id` IS the client `session_id`
 * (HIST-AD-1), a guest session that was later imported into a real conversation
 * is excluded from the guest side via `NOT EXISTS`, so it only ever shows once —
 * as the real, fully-imported conversation. Expressed as one raw SQL statement
 * (not the query builder) so the two sources paginate correctly as a single
 * ordered result set, following the `db.execute(sql\`...\`)` precedent in
 * admin-analytics-repo.ts's `getHeavyUsers`.
 */
export async function listAllConversations(
  opts: ConversationListOpts,
): Promise<Paginated<ConversationSummary>> {
  const lim = clampLimit(opts.limit);

  const format = opts.format?.trim() || null;
  const validFormat = format && isFormat(format) ? format : null;
  const modeFilter = validFormat ? modeForFormat(validFormat) : null;

  const q = opts.q?.trim();
  const pattern = q ? likePattern(q) : null;

  const cursor = decodeKeysetCursor(opts.cursor);

  const realFormatClause = format ? sql`WHERE c.format = ${format}` : sql``;
  // Filter guest sessions by their REPRESENTATIVE mode — the same latest-turn
  // value used for the displayed `format` column — via HAVING on the aggregate,
  // NOT a pre-aggregation WHERE (which would silently drop the session's other
  // turns from the group instead of excluding the session outright). A format
  // WAS requested but isn't a recognized one ⇒ no guest session can ever match
  // (mirrors the real side, which likewise matches nothing).
  const guestFormatClause = !format
    ? sql``
    : modeFilter
      ? sql`HAVING (array_agg(tr.mode ORDER BY tr.created_at DESC))[1] = ${modeFilter}`
      : sql`HAVING false`;

  const realQMatch = pattern
    ? sql`(c.title ILIKE ${pattern} OR EXISTS (
        SELECT 1 FROM conversation_message cm2
        WHERE cm2.conversation_id = c.id AND cm2.text_content ILIKE ${pattern}
      ))`
    : sql`true`;
  const guestQMatch = pattern
    ? sql`bool_or(tr.prompt_text ILIKE ${pattern} OR tr.answer_text ILIKE ${pattern})`
    : sql`true`;

  const cursorClause = cursor
    ? sql`AND (updated_at < ${cursor.t} OR (updated_at = ${cursor.t} AND id < ${cursor.id}))`
    : sql``;

  const rows = rowsOf(
    await db.execute(sql`
      WITH real_rows AS (
        SELECT
          c.id AS id,
          c.account_id AS account_id,
          a.email AS account_email,
          c.title AS title,
          c.format AS format,
          c.created_at AS created_at,
          c.updated_at AS updated_at,
          (SELECT count(*) FROM conversation_message cm
            WHERE cm.conversation_id = c.id)::bigint AS message_count,
          ${realQMatch} AS q_match
        FROM conversation c
        LEFT JOIN account a ON a.id = c.account_id
        ${realFormatClause}
      ),
      guest_rows AS (
        SELECT
          tr.session_id AS id,
          NULL::text AS account_id,
          NULL::text AS account_email,
          (array_agg(tr.prompt_text ORDER BY tr.created_at ASC))[1] AS title,
          (array_agg(tr.mode ORDER BY tr.created_at DESC))[1] AS format,
          min(tr.created_at) AS created_at,
          max(tr.created_at) AS updated_at,
          sum(CASE WHEN tr.status = 'rate_limited' THEN 1 ELSE 2 END)::bigint
            AS message_count,
          ${guestQMatch} AS q_match
        FROM turn_record tr
        WHERE tr.account_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM conversation c2 WHERE c2.id = tr.session_id
          )
        GROUP BY tr.session_id
        ${guestFormatClause}
      ),
      combined AS (
        SELECT * FROM real_rows
        UNION ALL
        SELECT * FROM guest_rows
      )
      SELECT id, account_id, account_email, title, format, created_at,
             updated_at, message_count
      FROM combined
      WHERE q_match
      ${cursorClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${lim + 1}
    `),
  );

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;

  const summaries: ConversationSummary[] = page.map((r) => {
    const accountId = (r.account_id as string | null) ?? null;
    const isGuest = accountId === null;
    return {
      id: String(r.id),
      accountId,
      accountEmail: (r.account_email as string | null) ?? null,
      title: isGuest ? deriveTitle(String(r.title ?? "")) : String(r.title),
      format: isGuest
        ? formatForMode(String(r.format) as AgentMode)
        : String(r.format),
      messageCount: num(r.message_count),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  });

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeKeysetCursor(num(last.updated_at), String(last.id))
      : null;
  return { rows: summaries, nextCursor };
}

/**
 * A conversation's full thread (ADMIN-AC-9.2) — summary (with owning account +
 * message count) plus every stored turn in `seq` order. Un-scoped: ANY
 * conversation, regardless of account (ADMIN-BR-4). Returns `null` if missing.
 *
 * Also resolves guest pseudo-conversations (see {@link listAllConversations}):
 * if `conversationId` matches no real `conversation` row, it's tried as a guest
 * `session_id` — reconstructing the thread from that session's `turn_record` rows
 * (account_id IS NULL). Each turn expands to a "user" turn (the prompt) plus,
 * unless the turn was `rate_limited` (no answer), an "assistant" turn.
 */
export async function getConversationThread(
  conversationId: string,
): Promise<ConversationThreadResponse | null> {
  const rows = await db
    .select({
      id: conversation.id,
      accountId: conversation.account_id,
      accountEmail: account.email,
      title: conversation.title,
      format: conversation.format,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    })
    .from(conversation)
    .leftJoin(account, eq(account.id, conversation.account_id))
    .where(eq(conversation.id, conversationId))
    .limit(1);
  const c = rows[0];

  if (c) {
    const turnRows = await db
      .select({
        id: conversation_message.id,
        role: conversation_message.role,
        seq: conversation_message.seq,
        textContent: conversation_message.text_content,
        answerJson: conversation_message.answer_json,
        createdAt: conversation_message.created_at,
      })
      .from(conversation_message)
      .where(eq(conversation_message.conversation_id, conversationId))
      .orderBy(asc(conversation_message.seq));

    const turns: StoredTurn[] = turnRows.map((t) => ({
      id: t.id,
      role: t.role as "user" | "assistant",
      seq: t.seq,
      textContent: t.textContent,
      answerJson: t.answerJson,
      createdAt: t.createdAt,
    }));

    const summary: ConversationSummary = {
      id: c.id,
      accountId: c.accountId,
      accountEmail: c.accountEmail ?? null,
      title: c.title,
      format: c.format,
      messageCount: turns.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };

    return { summary, turns };
  }

  // Not a real conversation — try it as a guest session_id (HIST-AD-1:
  // conversation.id IS the client session_id, so a guest thread's id is its
  // session_id too).
  const guestTurns = await db
    .select({
      id: turn_record.id,
      status: turn_record.status,
      mode: turn_record.mode,
      promptText: turn_record.prompt_text,
      answerText: turn_record.answer_text,
      answerJson: turn_record.answer_json,
      createdAt: turn_record.created_at,
    })
    .from(turn_record)
    .where(
      and(
        eq(turn_record.session_id, conversationId),
        isNull(turn_record.account_id),
      ),
    )
    .orderBy(asc(turn_record.created_at));

  if (guestTurns.length === 0) return null;

  const turns: StoredTurn[] = [];
  let seq = 0;
  for (const t of guestTurns) {
    turns.push({
      id: `${t.id}-u`,
      role: "user",
      seq: seq++,
      textContent: t.promptText,
      answerJson: null,
      createdAt: t.createdAt,
    });
    if (t.status !== "rate_limited") {
      turns.push({
        id: `${t.id}-a`,
        role: "assistant",
        seq: seq++,
        textContent: t.answerText ?? "",
        answerJson: t.answerJson,
        createdAt: t.createdAt,
      });
    }
  }

  const first = guestTurns[0]!;
  const last = guestTurns[guestTurns.length - 1]!;
  const summary: ConversationSummary = {
    id: conversationId,
    accountId: null,
    accountEmail: null,
    title: deriveTitle(first.promptText),
    format: formatForMode(last.mode as AgentMode),
    messageCount: turns.length,
    createdAt: first.createdAt,
    updatedAt: last.createdAt,
  };

  return { summary, turns };
}

// ---------------------------------------------------------------------------
// Teams — cross-account list + full detail (un-scoped variants)
// ---------------------------------------------------------------------------

/**
 * Cross-account saved-team browser (ADMIN-US-10) — the un-scoped variant of the
 * user-facing `listTeams`, carrying the owning account. `q` is a name substring
 * (ilike); `format` filters exactly. Reads each team's `members` JSON to compute
 * the cheap completeness summary (memberCount / incomplete / species), like
 * team-repo.listTeams. Keyset paginated on `(updated_at, id)` DESC.
 */
export async function listAllTeams(
  opts: TeamListOpts,
): Promise<Paginated<TeamSummary>> {
  const lim = clampLimit(opts.limit);
  const conditions: SQL[] = [];

  const format = opts.format?.trim();
  if (format) conditions.push(eq(team.format, format));

  const q = opts.q?.trim();
  if (q) conditions.push(ilike(team.name, likePattern(q)));

  const cursor = decodeKeysetCursor(opts.cursor);
  if (cursor) {
    conditions.push(
      or(
        lt(team.updated_at, cursor.t),
        and(eq(team.updated_at, cursor.t), lt(team.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: team.id,
      accountId: team.account_id,
      accountEmail: account.email,
      name: team.name,
      format: team.format,
      members: team.members,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
    })
    .from(team)
    .leftJoin(account, eq(account.id, team.account_id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(team.updated_at), desc(team.id))
    .limit(lim + 1);

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;

  const summaries: TeamSummary[] = page.map((r) => {
    const members = parseMembers(r.members);
    return {
      id: r.id,
      accountId: r.accountId,
      accountEmail: r.accountEmail ?? null,
      name: r.name,
      format: r.format,
      memberCount: members.length,
      incomplete: isIncomplete(members),
      species: members
        .map((m) => m.species)
        .filter((s): s is string => s !== null),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeKeysetCursor(last.updatedAt, last.id) : null;
  return { rows: summaries, nextCursor };
}

/**
 * A saved team with its full members (ADMIN-AC-10.1) — un-scoped: ANY team,
 * regardless of account (ADMIN-BR-4), with the owning account joined. Returns
 * `null` if missing. A corrupted `members` payload that fails Zod propagates.
 */
export async function getTeamById(teamId: string): Promise<TeamDetail | null> {
  const rows = await db
    .select({
      id: team.id,
      accountId: team.account_id,
      accountEmail: account.email,
      name: team.name,
      format: team.format,
      members: team.members,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
    })
    .from(team)
    .leftJoin(account, eq(account.id, team.account_id))
    .where(eq(team.id, teamId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;

  return {
    id: r.id,
    accountId: r.accountId,
    accountEmail: r.accountEmail ?? null,
    name: r.name,
    format: r.format,
    members: parseMembers(r.members),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
