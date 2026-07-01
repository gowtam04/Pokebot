/**
 * ADMIN-API-E2E checkpoint — the twelve `/api/admin/*` route handlers exercised
 * end-to-end against a REAL Testcontainers Postgres seeded with the shared admin
 * fixture, with NO repo/aggregation mocking (admin-panel design.md § Build
 * Manifest `integration_checkpoints.after:[p5] admin-api-e2e`, § Phase 5 / p5;
 * ADMIN-US-1..11, ADMIN-AC-1.2/1.4/5.1/5.2, ADMIN-BR-1/2/4/8/9).
 *
 * This is the post-Phase-5 integration checkpoint: it proves the thin handlers
 * compose the guard + the Phase-4 read repos into a correctly-GATED, correctly-
 * SHAPED HTTP surface. Everything below the HTTP edge is REAL — the admin guard,
 * `isAdmin` (reading `process.env.ADMIN_EMAILS` at call time), the analytics +
 * content repos, the static price table, and Zod/team parsing all run for real
 * against an isolated migrated + seeded Postgres schema (the `@/data/db`
 * singleton, installed via `installAsSingleton`). Only two things are stubbed:
 *   - `server-only` (throws under the vitest node env), and
 *   - `@/server/auth/current-user.getCurrentAccount`, the single identity seam,
 *     so we can flip guest / non-admin / admin per case (mirrors the teams +
 *     auth integration tests). The allowlist itself is the REAL `isAdmin`,
 *     re-stubbed per case with `vi.stubEnv("ADMIN_EMAILS", …)`.
 *
 * Seeded ground truth + expected aggregates are KNOWN BY CONSTRUCTION from the
 * shared fixture header (`test/fixtures/admin-fixture.ts`), the same dataset the
 * Phase-4 repo oracles assert against — so the shape/filter/pagination
 * expectations below are exact. All `/api/admin/*` routes are READ-ONLY
 * (ADMIN-BR-2), so the fixture is seeded ONCE and there is no per-test truncate.
 *
 * The analytics routes (overview/cost/errors) default their window to the last 7
 * days relative to the wall clock; the fixture sits in the past, so those reads
 * are pinned to the canonical `ADMIN_RANGE` (via `?from=&to=&bucket=`) wherever a
 * deterministic aggregate is asserted. `getLive` reads the wall clock for its
 * last-hour window, so its block pins `Date.now()` to `LIVE_NOW` (fake `Date`
 * only, so the node-postgres driver timers keep working).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every admin route's repo/db/guard chain `import "server-only"` (throws under
// the vitest node env). Neutralize it; the real Postgres handle is installed
// below via installAsSingleton.
vi.mock("server-only", () => ({}));

// The ONLY identity seam: the guard resolves `getCurrentAccount()`; stubbing it
// lets us flip guest / non-admin / admin. `isAdmin` stays REAL (it reads
// process.env.ADMIN_EMAILS at call time, re-stubbed per case via vi.stubEnv).
const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/server/auth/current-user", () => cu);

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../../test/support/pg";

import {
  ACCOUNTS,
  ADMIN_RANGE,
  CONVERSATIONS,
  LIVE,
  LIVE_NOW,
  SESSIONS,
  TEAMS,
  seedAdminFixture,
} from "../../../../test/fixtures/admin-fixture";

import type {
  AccountDetailResponse,
  AccountsResponse,
  ConversationThreadResponse,
  ConversationsListResponse,
  CostResponse,
  ErrorsResponse,
  LiveResponse,
  OverviewResponse,
  TeamDetailResponse,
  TeamsListResponse,
  TurnDetailResponse,
  TurnsListResponse,
} from "@/lib/admin/admin-types";

// ---------------------------------------------------------------------------
// Dynamically-imported route subjects (loaded AFTER installAsSingleton so the
// repos' lazily-imported `@/data/db` binds to this schema). The top-level imports
// in each route module are pure (`json`/`jsonError` + erased `import type`s), so
// loading them here never evaluates the env/db chain.
// ---------------------------------------------------------------------------

type OverviewRoute = typeof import("./overview/route");
type CostRoute = typeof import("./cost/route");
type ErrorsRoute = typeof import("./errors/route");
type TurnsRoute = typeof import("./turns/route");
type TurnsIdRoute = typeof import("./turns/[id]/route");
type AccountsRoute = typeof import("./accounts/route");
type AccountsIdRoute = typeof import("./accounts/[id]/route");
type ConversationsRoute = typeof import("./conversations/route");
type ConversationsIdRoute = typeof import("./conversations/[id]/route");
type TeamsRoute = typeof import("./teams/route");
type TeamsIdRoute = typeof import("./teams/[id]/route");
type LiveRoute = typeof import("./live/route");

let fix: PgFixture;
let overview: OverviewRoute;
let cost: CostRoute;
let errors: ErrorsRoute;
let turns: TurnsRoute;
let turnsId: TurnsIdRoute;
let accounts: AccountsRoute;
let accountsId: AccountsIdRoute;
let conversations: ConversationsRoute;
let conversationsId: ConversationsIdRoute;
let teams: TeamsRoute;
let teamsId: TeamsIdRoute;
let live: LiveRoute;

// ---------------------------------------------------------------------------
// Identity + request harness
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "owner@oak.test";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Allowlisted admin: ADMIN_EMAILS contains the signed-in account's email. */
function asAdmin(): void {
  vi.stubEnv("ADMIN_EMAILS", ADMIN_EMAIL);
  cu.getCurrentAccount.mockResolvedValue({
    id: "acct-admin",
    email: ADMIN_EMAIL,
    createdAt: 0,
  });
}

/** Signed in, but NOT on the allowlist (a real fixture account, misty). */
function asNonAdmin(): void {
  vi.stubEnv("ADMIN_EMAILS", ADMIN_EMAIL);
  cu.getCurrentAccount.mockResolvedValue({
    id: ACCOUNTS.B.id,
    email: ACCOUNTS.B.email,
    createdAt: ACCOUNTS.B.createdAt,
  });
}

/** No session at all. */
function asGuest(): void {
  vi.stubEnv("ADMIN_EMAILS", ADMIN_EMAIL);
  cu.getCurrentAccount.mockResolvedValue(null);
}

/** Build a GET Request with query params (undefined values omitted). */
function adminReq(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Request {
  const url = new URL(`http://admin.test${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return new Request(url.toString(), { method: "GET" });
}

/** App-Router dynamic-segment context (`params` is a Promise in Next 15). */
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** The canonical analytics window pinned on deterministic-aggregate reads. */
const RANGE = { from: ADMIN_RANGE.from, to: ADMIN_RANGE.to, bucket: "day" };

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  await seedAdminFixture(fix.db);

  overview = await import("./overview/route");
  cost = await import("./cost/route");
  errors = await import("./errors/route");
  turns = await import("./turns/route");
  turnsId = await import("./turns/[id]/route");
  accounts = await import("./accounts/route");
  accountsId = await import("./accounts/[id]/route");
  conversations = await import("./conversations/route");
  conversationsId = await import("./conversations/[id]/route");
  teams = await import("./teams/route");
  teamsId = await import("./teams/[id]/route");
  live = await import("./live/route");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(() => {
  // Default = guest, so a test that forgets to set identity fails as a clean
  // 401 rather than dereferencing an undefined account. Each test overrides via
  // asAdmin/asNonAdmin/asGuest.
  cu.getCurrentAccount.mockReset();
  cu.getCurrentAccount.mockResolvedValue(null);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The full route table — one invoker per handler (fresh request each call).
// ---------------------------------------------------------------------------

interface RouteCase {
  name: string;
  call: () => Promise<Response>;
}

function routeCases(): RouteCase[] {
  return [
    { name: "overview", call: () => overview.GET(adminReq("/api/admin/overview")) },
    { name: "cost", call: () => cost.GET(adminReq("/api/admin/cost")) },
    { name: "errors", call: () => errors.GET(adminReq("/api/admin/errors")) },
    { name: "turns", call: () => turns.GET(adminReq("/api/admin/turns")) },
    {
      name: "turns/[id]",
      call: () =>
        turnsId.GET(adminReq("/api/admin/turns/tr-01"), idCtx("tr-01")),
    },
    { name: "accounts", call: () => accounts.GET(adminReq("/api/admin/accounts")) },
    {
      name: "accounts/[id]",
      call: () =>
        accountsId.GET(
          adminReq(`/api/admin/accounts/${ACCOUNTS.A.id}`),
          idCtx(ACCOUNTS.A.id),
        ),
    },
    {
      name: "conversations",
      call: () => conversations.GET(adminReq("/api/admin/conversations")),
    },
    {
      name: "conversations/[id]",
      call: () =>
        conversationsId.GET(
          adminReq(`/api/admin/conversations/${CONVERSATIONS.A1.id}`),
          idCtx(CONVERSATIONS.A1.id),
        ),
    },
    { name: "teams", call: () => teams.GET(adminReq("/api/admin/teams")) },
    {
      name: "teams/[id]",
      call: () =>
        teamsId.GET(
          adminReq(`/api/admin/teams/${TEAMS.A1.id}`),
          idCtx(TEAMS.A1.id),
        ),
    },
    { name: "live", call: () => live.GET(adminReq("/api/admin/live")) },
  ];
}

// ===========================================================================
// Gating — the REAL authorization boundary on EVERY route (ADMIN-AC-1.2/1.4)
// ===========================================================================

describe("gating — every /api/admin/* route", () => {
  it("returns 401 {code:'unauthorized'} to a guest on every route", async () => {
    asGuest();
    for (const rc of routeCases()) {
      const res = await rc.call();
      expect(res.status, `${rc.name} (guest) status`).toBe(401);
      const body = await res.json();
      expect(body.code, `${rc.name} (guest) code`).toBe("unauthorized");
    }
  });

  it("returns 403 {code:'forbidden'} to a signed-in non-admin on every route", async () => {
    asNonAdmin();
    for (const rc of routeCases()) {
      const res = await rc.call();
      expect(res.status, `${rc.name} (non-admin) status`).toBe(403);
      const body = await res.json();
      expect(body.code, `${rc.name} (non-admin) code`).toBe("forbidden");
    }
  });

  it("returns 200 to an allowlisted admin on every route", async () => {
    asAdmin();
    for (const rc of routeCases()) {
      const res = await rc.call();
      expect(res.status, `${rc.name} (admin) status`).toBe(200);
    }
  });

  it("treats an empty/unset ADMIN_EMAILS as ZERO admins (would-be admin → 403)", async () => {
    // Same account email, but the allowlist is empty → the panel stays dark
    // (design § Deployment "No ADMIN_EMAILS set ⇒ zero admins").
    cu.getCurrentAccount.mockResolvedValue({
      id: "acct-admin",
      email: ADMIN_EMAIL,
      createdAt: 0,
    });
    vi.stubEnv("ADMIN_EMAILS", "");
    const res = await overview.GET(adminReq("/api/admin/overview"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("matches the allowlist case-insensitively (normalization)", async () => {
    // Account email in a different case than the allowlist entry still matches.
    cu.getCurrentAccount.mockResolvedValue({
      id: "acct-admin",
      email: "Owner@Oak.TEST",
      createdAt: 0,
    });
    vi.stubEnv("ADMIN_EMAILS", "owner@oak.test, someone@else.test");
    const res = await overview.GET(adminReq("/api/admin/overview"));
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// GET /api/admin/overview — KPI totals + series + headline cost & error rate
// ===========================================================================

describe("GET /api/admin/overview", () => {
  it("returns correctly-shaped totals/buckets/cost/error-rate over a pinned range", async () => {
    asAdmin();
    const res = await overview.GET(adminReq("/api/admin/overview", RANGE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;

    // The resolved window is echoed back (ADMIN-BR-8).
    expect(body.range).toEqual({
      from: ADMIN_RANGE.from,
      to: ADMIN_RANGE.to,
      bucket: "day",
    });

    // Range totals — known by construction (12 turns; distinct active over the
    // whole window; 2 signups; guest/signed split 5/7).
    expect(body.totals).toEqual({
      turns: 12,
      activeSigned: 3,
      activeGuest: 4,
      signups: 2,
      guestTurns: 5,
      signedTurns: 7,
    });

    // Three UTC day buckets.
    expect(body.buckets).toHaveLength(3);
    expect(body.buckets[0].turns).toBe(5);

    // Cost is an ESTIMATE (ADMIN-BR-5).
    expect(body.estimated).toBe(true);
    expect(body.totalEstUsd).toBeGreaterThan(0);

    // Headline error rate: failed turns / total turns × 100. Failing statuses
    // over the range: resolution_failed(1) + clarification_needed(1) +
    // insufficient_data(1) + rate_limited(1) = 4 of 12.
    expect(body.errorRatePct).toBeCloseTo((4 / 12) * 100, 9);
  });

  it("applies default params leniently (last-7-day day-bucket window; bad input → defaults)", async () => {
    asAdmin();

    // No params → a 7-day day-bucket window (ADMIN-BR-8).
    const def = (await (
      await overview.GET(adminReq("/api/admin/overview"))
    ).json()) as OverviewResponse;
    expect(def.range.bucket).toBe("day");
    expect(def.range.to - def.range.from).toBe(SEVEN_DAYS_MS);
    expect(def.estimated).toBe(true);

    // bucket=hour respected.
    const hourly = (await (
      await overview.GET(adminReq("/api/admin/overview", { bucket: "hour" }))
    ).json()) as OverviewResponse;
    expect(hourly.range.bucket).toBe("hour");

    // Garbage params never 500 — they fall back to the defaults.
    const garbage = await overview.GET(
      adminReq("/api/admin/overview", {
        from: "not-a-number",
        to: "nope",
        bucket: "weird",
      }),
    );
    expect(garbage.status).toBe(200);
    const gbody = (await garbage.json()) as OverviewResponse;
    expect(gbody.range.bucket).toBe("day");
    expect(gbody.range.to - gbody.range.from).toBe(SEVEN_DAYS_MS);
  });
});

// ===========================================================================
// GET /api/admin/cost — token totals & estimated USD by model + trend
// ===========================================================================

describe("GET /api/admin/cost", () => {
  it("rolls up tokens & estimated cost by model with the priced flag + range", async () => {
    asAdmin();
    const res = await cost.GET(adminReq("/api/admin/cost", RANGE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostResponse;

    expect(body.estimated).toBe(true);
    expect(body.range).toEqual({
      from: ADMIN_RANGE.from,
      to: ADMIN_RANGE.to,
      bucket: "day",
    });
    expect(body.totalEstUsd).toBeGreaterThan(0);
    // One cost bucket per active UTC day.
    expect(body.series).toHaveLength(3);

    const byModel = new Map(body.byModel.map((m) => [m.model, m]));
    expect(byModel.get("grok-4.3")).toMatchObject({
      priced: true,
      inputTokens: 2750,
    });
    // Unknown model → unpriced, $0 (AD-6).
    expect(byModel.get("mystery")).toMatchObject({ priced: false, estUsd: 0 });
    // The rate_limited row's null model surfaces as "n/a", unpriced.
    expect(byModel.get("n/a")).toMatchObject({ priced: false, estUsd: 0 });
  });
});

// ===========================================================================
// GET /api/admin/errors — failure taxonomy (ADMIN-BR-9)
// ===========================================================================

describe("GET /api/admin/errors", () => {
  it("counts every BR-9 category over the range in stable order with rates", async () => {
    asAdmin();
    const res = await errors.GET(adminReq("/api/admin/errors", RANGE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErrorsResponse;

    expect(body.totalTurns).toBe(12);
    expect(body.range).toEqual({
      from: ADMIN_RANGE.from,
      to: ADMIN_RANGE.to,
      bucket: "day",
    });

    // Stable display order (mirrors the ErrorCategoryKey union).
    expect(body.categories.map((c) => c.key)).toEqual([
      "resolution_failed",
      "clarification_needed",
      "insufficient_data",
      "tool_error",
      "otp_email_failed",
      "rate_limited",
    ]);

    const byKey = new Map(body.categories.map((c) => [c.key, c]));
    expect(byKey.get("resolution_failed")!.count).toBe(1);
    expect(byKey.get("clarification_needed")!.count).toBe(1);
    expect(byKey.get("insufficient_data")!.count).toBe(1);
    expect(byKey.get("tool_error")!.count).toBe(2);
    expect(byKey.get("otp_email_failed")!.count).toBe(1);
    expect(byKey.get("rate_limited")!.count).toBe(1);
    expect(byKey.get("tool_error")!.ratePct).toBeCloseTo((2 / 12) * 100, 9);
  });
});

// ===========================================================================
// GET /api/admin/turns — list (filters, search, keyset pagination)
// ===========================================================================

describe("GET /api/admin/turns", () => {
  it("lists turns across ALL accounts AND guests over a pinned range, newest first", async () => {
    asAdmin();
    const res = await turns.GET(adminReq("/api/admin/turns", { ...RANGE, limit: 50 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnsListResponse;

    expect(body.rows.map((r) => r.id)).toEqual([
      "tr-12",
      "tr-11",
      "tr-10",
      "tr-09",
      "tr-08",
      "tr-07",
      "tr-06",
      "tr-05",
      "tr-04",
      "tr-03",
      "tr-02",
      "tr-01",
    ]);
    expect(body.nextCursor).toBeNull();

    // A summary row carries the joined owner + an estimated cost (ADMIN-BR-4/5).
    const signed = body.rows.find((r) => r.id === "tr-01")!;
    expect(signed.accountId).toBe(ACCOUNTS.A.id);
    expect(signed.accountEmail).toBe(ACCOUNTS.A.email);
    expect(signed.estUsd).toBeGreaterThan(0);
    const guest = body.rows.find((r) => r.id === "tr-03")!;
    expect(guest.accountId).toBeNull();
    expect(guest.accountEmail).toBeNull();
  });

  it("filters by kind, status and substring search", async () => {
    asAdmin();

    const guests = (await (
      await turns.GET(adminReq("/api/admin/turns", { ...RANGE, limit: 50, kind: "guest" }))
    ).json()) as TurnsListResponse;
    expect(guests.rows.map((r) => r.id).sort()).toEqual([
      "tr-03",
      "tr-04",
      "tr-08",
      "tr-09",
      "tr-12",
    ]);

    const answered = (await (
      await turns.GET(
        adminReq("/api/admin/turns", { ...RANGE, limit: 50, status: "answered" }),
      )
    ).json()) as TurnsListResponse;
    expect(answered.rows).toHaveLength(8);

    // Case-insensitive substring over prompt OR answer text.
    const hit = (await (
      await turns.GET(adminReq("/api/admin/turns", { ...RANGE, limit: 50, q: "garchomp" }))
    ).json()) as TurnsListResponse;
    expect(hit.rows.map((r) => r.id)).toEqual(["tr-01"]);
  });

  it("round-trips the keyset cursor across pages with no overlap or loss", async () => {
    asAdmin();
    const page = async (cursor?: string) =>
      (await (
        await turns.GET(adminReq("/api/admin/turns", { ...RANGE, limit: 5, cursor }))
      ).json()) as TurnsListResponse;

    const p1 = await page();
    expect(p1.rows.map((r) => r.id)).toEqual([
      "tr-12",
      "tr-11",
      "tr-10",
      "tr-09",
      "tr-08",
    ]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await page(p1.nextCursor!);
    expect(p2.rows.map((r) => r.id)).toEqual([
      "tr-07",
      "tr-06",
      "tr-05",
      "tr-04",
      "tr-03",
    ]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await page(p2.nextCursor!);
    expect(p3.rows.map((r) => r.id)).toEqual(["tr-02", "tr-01"]);
    expect(p3.nextCursor).toBeNull();

    const allIds = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(allIds).size).toBe(12);
  });
});

// ===========================================================================
// GET /api/admin/turns/[id] — drill-down (ADMIN-AC-5.2)
// ===========================================================================

describe("GET /api/admin/turns/[id]", () => {
  it("returns the full record (parsed tool_trace + answer json) for a known id", async () => {
    asAdmin();
    const res = await turnsId.GET(
      adminReq("/api/admin/turns/tr-01"),
      idCtx("tr-01"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnDetailResponse;
    expect(body.turn.id).toBe("tr-01");
    expect(body.turn.status).toBe("answered");
    expect(body.turn.toolTrace).toHaveLength(1);
    expect(body.turn.answerText).toBe("Garchomp has base 102 Speed.");
    expect(JSON.parse(body.turn.answerJson!)).toMatchObject({ status: "answered" });
  });

  it("returns 404 {code:'not_found'} for an unknown id", async () => {
    asAdmin();
    const res = await turnsId.GET(
      adminReq("/api/admin/turns/nope"),
      idCtx("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

// ===========================================================================
// GET /api/admin/accounts (+ /[id]) — derived activity, sorts, pagination
// ===========================================================================

describe("GET /api/admin/accounts", () => {
  it("defaults to recent (signup) order with derived activity", async () => {
    asAdmin();
    const res = await accounts.GET(adminReq("/api/admin/accounts", { limit: 50 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountsResponse;
    // createdAt DESC: misty (Jan-6) > ash (Jan-5) > brock (older).
    expect(body.rows.map((r) => r.id)).toEqual([
      ACCOUNTS.B.id,
      ACCOUNTS.A.id,
      ACCOUNTS.C.id,
    ]);

    const ash = body.rows.find((r) => r.id === ACCOUNTS.A.id)!;
    expect(ash).toMatchObject({
      email: ACCOUNTS.A.email,
      turns: 4,
      conversations: 2,
      teams: 1,
      rateLimited: 0,
      failed: 0,
    });
    expect(ash.estUsd).toBeGreaterThan(0);
  });

  it("supports the heavy-user sorts and email search", async () => {
    asAdmin();

    const byTurns = (await (
      await accounts.GET(adminReq("/api/admin/accounts", { limit: 50, sort: "turns" }))
    ).json()) as AccountsResponse;
    expect(byTurns.rows.map((r) => r.id)).toEqual([
      ACCOUNTS.A.id,
      ACCOUNTS.B.id,
      ACCOUNTS.C.id,
    ]);

    const search = (await (
      await accounts.GET(adminReq("/api/admin/accounts", { limit: 50, q: "cerulean" }))
    ).json()) as AccountsResponse;
    expect(search.rows.map((r) => r.id)).toEqual([ACCOUNTS.B.id]);
  });

  it("round-trips the id-position cursor over the sorted list", async () => {
    asAdmin();
    const p1 = (await (
      await accounts.GET(adminReq("/api/admin/accounts", { limit: 1 }))
    ).json()) as AccountsResponse;
    expect(p1.rows.map((r) => r.id)).toEqual([ACCOUNTS.B.id]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (await (
      await accounts.GET(
        adminReq("/api/admin/accounts", { limit: 1, cursor: p1.nextCursor! }),
      )
    ).json()) as AccountsResponse;
    expect(p2.rows.map((r) => r.id)).toEqual([ACCOUNTS.A.id]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = (await (
      await accounts.GET(
        adminReq("/api/admin/accounts", { limit: 1, cursor: p2.nextCursor! }),
      )
    ).json()) as AccountsResponse;
    expect(p3.rows.map((r) => r.id)).toEqual([ACCOUNTS.C.id]);
    expect(p3.nextCursor).toBeNull();
  });
});

describe("GET /api/admin/accounts/[id]", () => {
  it("returns activity + only the active (non-expired) sessions, newest first", async () => {
    asAdmin();
    const res = await accountsId.GET(
      adminReq(`/api/admin/accounts/${ACCOUNTS.A.id}`),
      idCtx(ACCOUNTS.A.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountDetailResponse;
    expect(body.account.id).toBe(ACCOUNTS.A.id);
    expect(body.account.turns).toBe(4);
    expect(body.sessions.map((s) => s.id)).toEqual([
      SESSIONS.A2.id,
      SESSIONS.A1.id,
    ]);
  });

  it("returns 404 for an unknown account", async () => {
    asAdmin();
    const res = await accountsId.GET(
      adminReq("/api/admin/accounts/nope"),
      idCtx("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

// ===========================================================================
// GET /api/admin/conversations (+ /[id]) — cross-account browser + thread
// ===========================================================================

describe("GET /api/admin/conversations", () => {
  it("lists conversations across accounts (owner + count), newest-active first", async () => {
    asAdmin();
    const res = await conversations.GET(
      adminReq("/api/admin/conversations", { limit: 50 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationsListResponse;
    // Real conversations keep their relative updated_at DESC order even once
    // guest pseudo-conversations (synthesized from the fixture's guest
    // turn_record rows, e.g. sess-G1) are interleaved into the full list.
    const signedRows = body.rows.filter((r) => r.accountId !== null);
    expect(signedRows.map((r) => r.id)).toEqual([
      CONVERSATIONS.B1.id,
      CONVERSATIONS.A2.id,
      CONVERSATIONS.A1.id,
    ]);
    const a1 = body.rows.find((r) => r.id === CONVERSATIONS.A1.id)!;
    expect(a1.accountEmail).toBe(ACCOUNTS.A.email);
    expect(a1.messageCount).toBe(2);

    // A guest session (no real `conversation` row) shows up too, synthesized
    // from turn_record — accountId/accountEmail both null.
    const guest = body.rows.find((r) => r.id === "sess-G1")!;
    expect(guest).toBeDefined();
    expect(guest.accountId).toBeNull();
    expect(guest.accountEmail).toBeNull();
  });

  it("filters by format and searches title OR message text", async () => {
    asAdmin();
    const champ = (await (
      await conversations.GET(
        adminReq("/api/admin/conversations", { limit: 50, format: "champions" }),
      )
    ).json()) as ConversationsListResponse;
    expect(champ.rows.map((r) => r.id)).toEqual([CONVERSATIONS.A2.id]);

    // Message-text-only hit ("rain core" lives in B1's assistant message).
    const msg = (await (
      await conversations.GET(
        adminReq("/api/admin/conversations", { limit: 50, q: "rain core" }),
      )
    ).json()) as ConversationsListResponse;
    expect(msg.rows.map((r) => r.id)).toEqual([CONVERSATIONS.B1.id]);
  });

  it("round-trips the keyset cursor", async () => {
    // The full unscoped list now also carries guest pseudo-conversations (the
    // exact merged order is asserted in depth by the repo oracle test); this
    // HTTP-level check only proves the cursor round-trips to a distinct page.
    asAdmin();
    const p1 = (await (
      await conversations.GET(adminReq("/api/admin/conversations", { limit: 1 }))
    ).json()) as ConversationsListResponse;
    expect(p1.rows).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await (
      await conversations.GET(
        adminReq("/api/admin/conversations", { limit: 1, cursor: p1.nextCursor! }),
      )
    ).json()) as ConversationsListResponse;
    expect(p2.rows).toHaveLength(1);
    expect(p2.rows[0]!.id).not.toBe(p1.rows[0]!.id);
  });
});

describe("GET /api/admin/conversations/[id]", () => {
  it("returns the full thread (summary + ordered turns) for any account", async () => {
    asAdmin();
    const res = await conversationsId.GET(
      adminReq(`/api/admin/conversations/${CONVERSATIONS.A1.id}`),
      idCtx(CONVERSATIONS.A1.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationThreadResponse;
    expect(body.summary.accountEmail).toBe(ACCOUNTS.A.email);
    expect(body.summary.messageCount).toBe(2);
    expect(body.turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(body.turns[0].role).toBe("user");
    expect(body.turns[1].role).toBe("assistant");
  });

  it("reconstructs a guest session's thread from turn_record", async () => {
    asAdmin();
    const res = await conversationsId.GET(
      adminReq("/api/admin/conversations/sess-G1"),
      idCtx("sess-G1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationThreadResponse;
    expect(body.summary.accountId).toBeNull();
    expect(body.summary.accountEmail).toBeNull();
    expect(body.turns.length).toBeGreaterThan(0);
    expect(body.turns[0]!.role).toBe("user");
  });

  it("returns 404 for an unknown conversation", async () => {
    asAdmin();
    const res = await conversationsId.GET(
      adminReq("/api/admin/conversations/nope"),
      idCtx("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

// ===========================================================================
// GET /api/admin/teams (+ /[id]) — cross-account browser + detail
// ===========================================================================

describe("GET /api/admin/teams", () => {
  it("lists teams across accounts with member summary + owner, newest-active first", async () => {
    asAdmin();
    const res = await teams.GET(adminReq("/api/admin/teams", { limit: 50 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamsListResponse;
    expect(body.rows.map((r) => r.id)).toEqual([TEAMS.B1.id, TEAMS.A1.id]);

    const a = body.rows.find((r) => r.id === TEAMS.A1.id)!;
    expect(a.accountEmail).toBe(ACCOUNTS.A.email);
    expect(a.memberCount).toBe(1);
    expect(a.incomplete).toBe(true);

    const b = body.rows.find((r) => r.id === TEAMS.B1.id)!;
    expect(b.memberCount).toBe(6);
    expect(b.incomplete).toBe(false);
  });

  it("filters by format and searches by name", async () => {
    asAdmin();
    const champ = (await (
      await teams.GET(adminReq("/api/admin/teams", { limit: 50, format: "champions" }))
    ).json()) as TeamsListResponse;
    expect(champ.rows.map((r) => r.id)).toEqual([TEAMS.B1.id]);

    const named = (await (
      await teams.GET(adminReq("/api/admin/teams", { limit: 50, q: "Sun" }))
    ).json()) as TeamsListResponse;
    expect(named.rows.map((r) => r.id)).toEqual([TEAMS.A1.id]);
  });
});

describe("GET /api/admin/teams/[id]", () => {
  it("returns the full team with members + owner for any account", async () => {
    asAdmin();
    const res = await teamsId.GET(
      adminReq(`/api/admin/teams/${TEAMS.B1.id}`),
      idCtx(TEAMS.B1.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamDetailResponse;
    expect(body.team.id).toBe(TEAMS.B1.id);
    expect(body.team.accountEmail).toBe(ACCOUNTS.B.email);
    expect(body.team.members).toHaveLength(6);
  });

  it("returns 404 for an unknown team", async () => {
    asAdmin();
    const res = await teamsId.GET(
      adminReq("/api/admin/teams/nope"),
      idCtx("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

// ===========================================================================
// GET /api/admin/live — recent feed + current-window counters (Date pinned)
// ===========================================================================

describe("GET /api/admin/live (window pinned to LIVE_NOW)", () => {
  // getLive reads the wall clock for its last-hour window; pin Date.now() to
  // LIVE_NOW so the window is deterministic. Fake ONLY `Date` so the real
  // node-postgres driver timers keep working.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns recent turns newest-first + the last-hour counters", async () => {
    asAdmin();
    const res = await live.GET(adminReq("/api/admin/live"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LiveResponse;

    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent.length).toBeLessThanOrEqual(20);
    expect(body.recent[0].sessionId).toBe(LIVE.topSession);

    // Strictly non-increasing createdAt (newest first).
    for (let i = 1; i < body.recent.length; i++) {
      expect(body.recent[i - 1].createdAt).toBeGreaterThanOrEqual(
        body.recent[i].createdAt,
      );
    }

    // Last-hour window: LIVE1 (−5m) + LIVE2 (−30m); LIVE3 (−90m) is outside.
    expect(body.window.lastHourTurns).toBe(LIVE.expectedLastHourTurns);
    expect(body.window.lastHourActive).toBe(LIVE.expectedLastHourActive);
  });
});
