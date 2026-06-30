/**
 * Integration/seam tests for src/server/auth/auth-service.ts — the requestCode /
 * verifyCode orchestration (account-creation design.md § Interface Definitions →
 * auth-service.ts, Phase 3; BR-A1..A6, AC-2.2..2.7).
 *
 * Harness (auth-service → repo / sessions all read the `@/data/db` SINGLETON):
 *   1. migrate an isolated Postgres schema (createPgSchema, seed "none"),
 *   2. installAsSingleton(fix) BEFORE the first dynamic import of auth-service /
 *      repo / sessions, and
 *   3. neutralize `server-only`.
 *
 * The email transport is mocked so each "sent" code is captured (to feed verify)
 * and a delivery fault can be forced (→ `email_failed`). `next/headers` is stubbed
 * (auth-service pulls it in transitively via sessions but never touches cookies).
 *
 * Every negative branch asserts the FULL result object (discriminant + payload)
 * via toEqual/toMatchObject — not happy-path only. The BR-A1 non-enumeration
 * check is a single toEqual of the known-vs-unknown results.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  hashCode,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
} from "@/server/auth/otp";
import {
  _resetForTests,
  checkVerifyThrottle,
} from "@/server/auth/otp-throttle";

// server-only throws under the node env; the real db handle is installed below.
vi.mock("server-only", () => ({}));

// auth-service → sessions → next/headers. auth-service never calls a cookie
// helper, but the import must resolve; stub it.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

// Controllable email transport: capture the code that would be sent, and allow
// forcing a delivery fault for the email_failed branch.
const emailMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn<(to: string, code: string) => Promise<void>>(),
}));
vi.mock("@/server/auth/email/transport", () => ({
  getEmailTransport: () => ({ sendOtpEmail: emailMock.sendOtpEmail }),
}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

type AuthService = typeof import("./auth-service");
type Repo = typeof import("@/data/repos/accounts-repo");
type Sessions = typeof import("./sessions");

let fix: PgFixture;
let auth: AuthService;
let repo: Repo;
let sessions: Sessions;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  auth = await import("./auth-service");
  repo = await import("@/data/repos/accounts-repo");
  sessions = await import("./sessions");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE account, auth_session, otp_code RESTART IDENTITY`,
  );
  _resetForTests();
  emailMock.sendOtpEmail.mockReset();
  emailMock.sendOtpEmail.mockResolvedValue(undefined);
});

const IP = "10.0.0.1";

/** The plaintext code most recently handed to the (mocked) transport. */
function lastSentCode(): string {
  const calls = emailMock.sendOtpEmail.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("no OTP email was sent");
  return last[1];
}

/**
 * Issue a fresh code for `email` and return it. Resets the in-memory request
 * throttle first so setup-time re-issues for the same email aren't blocked by
 * the 60s cooldown (the cooldown itself is asserted in its own test).
 */
async function issueAndCapture(email: string, ip = IP): Promise<string> {
  _resetForTests();
  const r = await auth.requestCode(email, ip);
  expect(r).toEqual({ ok: true });
  return lastSentCode();
}

/** Count account rows for a normalized email (duplicate-prevention check). */
async function accountCount(email: string): Promise<number> {
  const res = await fix.db.execute(
    sql`SELECT count(*)::int AS n FROM account WHERE email = ${email}`,
  );
  return (res.rows[0] as { n: number }).n;
}

// ===========================================================================
// requestCode — every branch (invalid_email / throttled / email_failed / ok)
// ===========================================================================

describe("requestCode branches", () => {
  it("rejects a syntactically invalid email (AC-2.1)", async () => {
    expect(await auth.requestCode("not-an-email", IP)).toEqual({
      ok: false,
      reason: "invalid_email",
    });
    // No code is generated/sent for an invalid email.
    expect(emailMock.sendOtpEmail).not.toHaveBeenCalled();
  });

  it("throttles a too-soon resend for the same email (BR-A5)", async () => {
    expect(await auth.requestCode("cooldown@test.com", IP)).toEqual({ ok: true });

    // Immediate second request is inside the 60s cooldown.
    const r = await auth.requestCode("cooldown@test.com", IP);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected throttled");
    if (r.reason !== "throttled") throw new Error(`expected throttled, got ${r.reason}`);
    expect(r.reason).toBe("throttled");
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("maps an email delivery fault to email_failed (NFR: retryable, not enumeration)", async () => {
    emailMock.sendOtpEmail.mockRejectedValueOnce(new Error("resend 500"));

    expect(await auth.requestCode("bounce@test.com", IP)).toEqual({
      ok: false,
      reason: "email_failed",
    });
    // The code was still upserted (stays valid if delivery later succeeds).
    expect(await repo.getOtpCode("bounce@test.com")).not.toBeNull();
  });

  it("upserts an HMAC-hashed code and never persists the plaintext (BR-A3, AD-4)", async () => {
    const code = await issueAndCapture("hash@test.com");
    const row = await repo.getOtpCode("hash@test.com");
    expect(row?.codeHash).toBe(hashCode("hash@test.com", code));
    expect(row?.codeHash).not.toBe(code);
    expect(row?.attempts).toBe(0);
    expect(row?.consumedAt).toBeNull();
    // ~10-minute expiry (BR-A3).
    expect((row?.expiresAt ?? 0) - (row?.createdAt ?? 0)).toBe(OTP_TTL_MS);
  });
});

// ===========================================================================
// BR-A1 — non-enumerating: known and unknown emails are byte-identical
// ===========================================================================

describe("requestCode is non-enumerating (BR-A1, AC-2.2)", () => {
  it("returns a byte-identical result for a registered vs unregistered email", async () => {
    // Pre-register one email; leave the other unknown.
    await repo.createAccount("known@test.com", randomUUID(), Date.now());

    // Distinct emails + same IP (under the per-IP cap) so neither cooldown nor
    // caps differ between the two calls — only account existence differs.
    const known = await auth.requestCode("known@test.com", IP);
    const unknown = await auth.requestCode("unknown@test.com", IP);

    // The whole point of BR-A1: the request side cannot reveal registration.
    expect(known).toEqual(unknown);
    expect(known).toEqual({ ok: true });
  });
});

// ===========================================================================
// verifyCode — create-vs-login, supersession, expiry, single-use, lockout
// ===========================================================================

describe("verifyCode — create vs login (BR-A1, AC-2.3, AC-2.4)", () => {
  it("creates a new account on first verify and signs in (created=true, AC-2.3)", async () => {
    const code = await issueAndCapture("new@test.com");

    const result = await auth.verifyCode("new@test.com", code, IP);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.created).toBe(true);
    expect(result.account.email).toBe("new@test.com");
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // Account is persisted, and the issued token resolves to it end-to-end.
    expect(await repo.findAccountByEmail("new@test.com")).toEqual(result.account);
    expect(await sessions.resolveSessionToken(result.token)).toEqual(
      result.account,
    );
  });

  it("logs an existing email into the SAME account — no duplicate (created=false, AC-2.4)", async () => {
    // First verify creates the account.
    const code1 = await issueAndCapture("dup@test.com");
    const first = await auth.verifyCode("dup@test.com", code1, IP);
    if (!first.ok) throw new Error("expected first ok");
    expect(first.created).toBe(true);

    // Second full request→verify for the same email logs into the same account.
    const code2 = await issueAndCapture("dup@test.com");
    const second = await auth.verifyCode("dup@test.com", code2, IP);
    if (!second.ok) throw new Error("expected second ok");

    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    // Exactly one account row exists for the email (BR-A1).
    expect(await accountCount("dup@test.com")).toBe(1);
  });

  it("normalizes the email (trim + lowercase) into the account identity (BR-A2)", async () => {
    const email = "Ash.Ketchum@Pallet.Town";
    const code = await issueAndCapture(email);

    const result = await auth.verifyCode(email, code, IP);
    if (!result.ok) throw new Error("expected ok");
    expect(result.account.email).toBe("ash.ketchum@pallet.town");
    expect(await repo.findAccountByEmail("ash.ketchum@pallet.town")).not.toBeNull();
  });
});

describe("verifyCode — supersession (BR-A5, AC-3.2)", () => {
  it("invalidates the prior code and accepts only the latest (both directions)", async () => {
    const email = "supersede@test.com";
    const codeA = await issueAndCapture(email);
    const codeB = await issueAndCapture(email); // supersedes codeA

    // Direction 1: the OLD code no longer authenticates.
    const old = await auth.verifyCode(email, codeA, IP);
    expect(old).toEqual({
      ok: false,
      reason: "invalid_code",
      attemptsRemaining: OTP_MAX_ATTEMPTS - 1,
    });

    // Direction 2: the NEW code does.
    const fresh = await auth.verifyCode(email, codeB, IP);
    expect(fresh.ok).toBe(true);
  });
});

describe("verifyCode — invalid / expired / consumed (AC-2.5, AC-2.6, BR-A3)", () => {
  it("returns invalid_or_expired when no code was ever issued", async () => {
    expect(await auth.verifyCode("nocode@test.com", "000000", "ip-a")).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("returns invalid_or_expired for an expired code (AC-2.6, BR-A3)", async () => {
    const email = "expired@test.com";
    const code = "123456";
    const now = Date.now();
    // Seed an already-expired code directly.
    await repo.upsertOtpCode({
      email,
      codeHash: hashCode(email, code),
      createdAt: now - OTP_TTL_MS - 1,
      expiresAt: now - 1,
    });

    expect(await auth.verifyCode(email, code, "ip-b")).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("is single-use: a correct code cannot be reused after success (BR-A3)", async () => {
    const email = "single@test.com";
    const code = "246810";
    const now = Date.now();
    await repo.upsertOtpCode({
      email,
      codeHash: hashCode(email, code),
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
    });

    const first = await auth.verifyCode(email, code, "ip-c");
    expect(first.ok).toBe(true);

    // Second use of the same (now consumed) code is rejected.
    expect(await auth.verifyCode(email, code, "ip-c")).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("reports a decrementing attemptsRemaining on each wrong guess (AC-2.5)", async () => {
    const email = "wrong@test.com";
    const now = Date.now();
    await repo.upsertOtpCode({
      email,
      codeHash: hashCode(email, "111111"),
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
    });

    const r1 = await auth.verifyCode(email, "999999", "ip-d");
    expect(r1).toEqual({
      ok: false,
      reason: "invalid_code",
      attemptsRemaining: 4,
    });
    const r2 = await auth.verifyCode(email, "888888", "ip-d");
    expect(r2).toEqual({
      ok: false,
      reason: "invalid_code",
      attemptsRemaining: 3,
    });
  });
});

describe("verifyCode — lockout after 5 wrong attempts (BR-A4)", () => {
  it("locks out at 5, and even the CORRECT code then fails with too_many_attempts", async () => {
    const email = "lock@test.com";
    const correct = "135790";
    const now = Date.now();
    await repo.upsertOtpCode({
      email,
      codeHash: hashCode(email, correct),
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
    });

    // Five wrong attempts: attemptsRemaining walks 4→0.
    const remaining: number[] = [];
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const r = await auth.verifyCode(email, "000000", "ip-lock");
      if (r.ok || r.reason !== "invalid_code") {
        throw new Error(`attempt ${i} not invalid_code`);
      }
      remaining.push(r.attemptsRemaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    // The CORRECT code is now refused — the code is locked out (BR-A4).
    expect(await auth.verifyCode(email, correct, "ip-lock")).toEqual({
      ok: false,
      reason: "too_many_attempts",
    });
  });
});

describe("verifyCode — per-IP verify throttle", () => {
  it("refuses once the per-IP verify cap is exhausted", async () => {
    const ip = "203.0.113.99";
    // Exhaust the 20/10-min verify budget for this IP (shared module state).
    for (let i = 0; i < 20; i++) {
      expect(checkVerifyThrottle(ip).allowed).toBe(true);
    }

    const r = await auth.verifyCode("any@test.com", "000000", ip);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected throttled");
    if (r.reason !== "throttled") throw new Error(`expected throttled, got ${r.reason}`);
    expect(r.reason).toBe("throttled");
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });
});
