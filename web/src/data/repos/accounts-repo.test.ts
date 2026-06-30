/**
 * Oracle tests for src/data/repos/accounts-repo.ts — the sole Postgres
 * reader/writer for the email-OTP auth tables (account, auth_session, otp_code).
 *
 * The repo reads the `@/data/db` SINGLETON directly (mirrors resolve-index.ts),
 * NOT a per-request ctx handle, so the harness must:
 *   1. migrate an isolated Postgres schema (createPgSchema, seed "none"), and
 *   2. installAsSingleton(fix) BEFORE the first dynamic import of the repo, so
 *      the repo's static `import { db }` captures THIS fixture's handle.
 * Hence the repo is imported dynamically inside beforeAll (after install), and
 * `server-only` is neutralised (it throws under the vitest node env).
 *
 * Behaviour is asserted against the design's Interface Definitions + the
 * referenced business rules (negative branches assert the discriminant
 * explicitly — null misses, the UNIQUE rejection, the reset/lockout/cleanup
 * counters), not happy-path only.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// db.ts / accounts-repo.ts `import "server-only"` (throws under node). Neutralize
// it; the real Postgres handle is supplied via installAsSingleton below.
vi.mock("server-only", () => ({}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

// Type-only import — erased at compile time, so it does NOT trigger the runtime
// module load before installAsSingleton (the runtime handle is imported in
// beforeAll). Used purely for the AuthSession shape in the test helper.
import type { AuthSession } from "./accounts-repo";

type Repo = typeof import("./accounts-repo");

let fix: PgFixture;
let repo: Repo;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  // Install BEFORE importing the repo so its `import { db } from "@/data/db"`
  // binds to this schema's handle.
  await installAsSingleton(fix);
  repo = await import("./accounts-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

// One migrated schema for the whole file (the singleton db is captured once);
// reset the tables between tests so each starts clean. The chat-history + team
// tables are included because deleteAccount cascades into them.
beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE account, auth_session, otp_code, conversation, conversation_message, team RESTART IDENTITY`,
  );
});

const EMAIL = "ash@pallet.town";

// ---------------------------------------------------------------------------
// account — BR-A1 (one per email), BR-A2 (email identity)
// ---------------------------------------------------------------------------

describe("account", () => {
  it("round-trips a created account and finds it by email (BR-A2)", async () => {
    const id = randomUUID();
    const createdAt = 1_700_000_000_000;

    const created = await repo.createAccount(EMAIL, id, createdAt);
    expect(created).toEqual({ id, email: EMAIL, createdAt });

    const found = await repo.findAccountByEmail(EMAIL);
    expect(found).toEqual({ id, email: EMAIL, createdAt });
    // bigint mode:"number" must read back as a JS number, not a string.
    expect(typeof found?.createdAt).toBe("number");
  });

  it("findAccountByEmail returns null for an unknown email (non-enumerating, BR-A1)", async () => {
    const found = await repo.findAccountByEmail("nobody@nowhere.test");
    expect(found).toBeNull();
  });

  it("rejects a duplicate email — UNIQUE enforces one account per email (BR-A1)", async () => {
    await repo.createAccount(EMAIL, randomUUID(), 1);

    // A second account for the SAME normalized email must be rejected by the
    // account_email_idx UNIQUE constraint (different id, same email).
    await expect(
      repo.createAccount(EMAIL, randomUUID(), 2),
    ).rejects.toThrow();

    // And only the first account survives.
    const found = await repo.findAccountByEmail(EMAIL);
    expect(found).not.toBeNull();
    expect(found?.createdAt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// otp_code — BR-A3 (single-use/expiry), BR-A4 (lockout), BR-A5 (supersession)
// ---------------------------------------------------------------------------

describe("otp_code", () => {
  it("inserts then round-trips a code via getOtpCode (BR-A3 fields)", async () => {
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "hash-1",
      createdAt: 1000,
      expiresAt: 1000 + 600_000,
    });

    const row = await repo.getOtpCode(EMAIL);
    expect(row).toEqual({
      email: EMAIL,
      codeHash: "hash-1",
      createdAt: 1000,
      expiresAt: 1000 + 600_000,
      attempts: 0,
      consumedAt: null,
    });
  });

  it("getOtpCode returns null when no code has been issued", async () => {
    expect(await repo.getOtpCode("nocode@nowhere.test")).toBeNull();
  });

  it("upsertOtpCode supersedes the prior row: new hash/expiry, attempts→0, consumed→null (BR-A5)", async () => {
    // First code, then dirty it: 3 wrong attempts + consumed.
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "old-hash",
      createdAt: 1000,
      expiresAt: 2000,
    });
    await repo.incrementOtpAttempts(EMAIL);
    await repo.incrementOtpAttempts(EMAIL);
    await repo.incrementOtpAttempts(EMAIL);
    await repo.consumeOtpCode(EMAIL, 1500);

    const dirty = await repo.getOtpCode(EMAIL);
    expect(dirty?.attempts).toBe(3);
    expect(dirty?.consumedAt).toBe(1500);

    // Issuing a fresh code overwrites the row and RESETS the lifecycle fields.
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "new-hash",
      createdAt: 5000,
      expiresAt: 6000,
    });

    const fresh = await repo.getOtpCode(EMAIL);
    expect(fresh).toEqual({
      email: EMAIL,
      codeHash: "new-hash",
      createdAt: 5000,
      expiresAt: 6000,
      attempts: 0,
      consumedAt: null,
    });
  });

  it("incrementOtpAttempts returns the NEW count and persists it (BR-A4)", async () => {
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "h",
      createdAt: 0,
      expiresAt: 10,
    });

    expect(await repo.incrementOtpAttempts(EMAIL)).toBe(1);
    expect(await repo.incrementOtpAttempts(EMAIL)).toBe(2);
    expect((await repo.getOtpCode(EMAIL))?.attempts).toBe(2);
  });

  it("incrementOtpAttempts walks up to the lockout threshold of 5 (BR-A4)", async () => {
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "h",
      createdAt: 0,
      expiresAt: 10,
    });

    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      counts.push(await repo.incrementOtpAttempts(EMAIL));
    }
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.getOtpCode(EMAIL))?.attempts).toBe(5);
  });

  it("incrementOtpAttempts returns 0 when no code row exists (nothing to bump)", async () => {
    expect(await repo.incrementOtpAttempts("nocode@nowhere.test")).toBe(0);
  });

  it("consumeOtpCode marks the row single-use (BR-A3)", async () => {
    await repo.upsertOtpCode({
      email: EMAIL,
      codeHash: "h",
      createdAt: 0,
      expiresAt: 10,
    });
    expect((await repo.getOtpCode(EMAIL))?.consumedAt).toBeNull();

    await repo.consumeOtpCode(EMAIL, 7777);
    expect((await repo.getOtpCode(EMAIL))?.consumedAt).toBe(7777);
  });
});

// ---------------------------------------------------------------------------
// auth_session — BR-A7 (per-device sessions, lazy cleanup), AC-5.1 (sign out)
// ---------------------------------------------------------------------------

describe("auth_session", () => {
  function session(over: Partial<AuthSession> = {}): AuthSession {
    return {
      id: randomUUID(),
      tokenHash: `th-${randomUUID()}`,
      accountId: "acct-1",
      createdAt: 1000,
      expiresAt: 1000 + 30 * 24 * 60 * 60_000,
      ...over,
    };
  }

  it("round-trips a session by token hash (BR-A7)", async () => {
    const s = session();
    await repo.insertSession(s);

    const found = await repo.findSessionByTokenHash(s.tokenHash);
    expect(found).toEqual(s);
    expect(typeof found?.expiresAt).toBe("number");
  });

  it("findSessionByTokenHash returns null for an unknown hash", async () => {
    expect(await repo.findSessionByTokenHash("does-not-exist")).toBeNull();
  });

  it("supports independent sessions for the same account (AC-4.3)", async () => {
    const a = session({ accountId: "acct-shared" });
    const b = session({ accountId: "acct-shared" });
    await repo.insertSession(a);
    await repo.insertSession(b);

    // Revoking one device's session leaves the other's active (AC-5.2).
    await repo.deleteSessionByTokenHash(a.tokenHash);
    expect(await repo.findSessionByTokenHash(a.tokenHash)).toBeNull();
    expect(await repo.findSessionByTokenHash(b.tokenHash)).not.toBeNull();
  });

  it("deleteSessionByTokenHash is idempotent (sign out, AC-5.1)", async () => {
    const s = session();
    await repo.insertSession(s);

    await repo.deleteSessionByTokenHash(s.tokenHash);
    expect(await repo.findSessionByTokenHash(s.tokenHash)).toBeNull();

    // Deleting again (or an absent token) must not throw.
    await expect(
      repo.deleteSessionByTokenHash(s.tokenHash),
    ).resolves.toBeUndefined();
    await expect(
      repo.deleteSessionByTokenHash("never-existed"),
    ).resolves.toBeUndefined();
  });

  it("deleteExpiredSessions returns the deleted count and leaves live rows (BR-A7)", async () => {
    const now = 1_000_000;
    const expiredA = session({ expiresAt: now - 1 });
    const expiredB = session({ expiresAt: now }); // exactly-at-now counts as expired
    const live = session({ expiresAt: now + 1 });
    await repo.insertSession(expiredA);
    await repo.insertSession(expiredB);
    await repo.insertSession(live);

    const removed = await repo.deleteExpiredSessions(now);
    expect(removed).toBe(2);

    // The two expired rows are gone; the live one survives.
    expect(await repo.findSessionByTokenHash(expiredA.tokenHash)).toBeNull();
    expect(await repo.findSessionByTokenHash(expiredB.tokenHash)).toBeNull();
    expect(await repo.findSessionByTokenHash(live.tokenHash)).not.toBeNull();
  });

  it("deleteExpiredSessions returns 0 when nothing is expired", async () => {
    const now = 1_000_000;
    await repo.insertSession(session({ expiresAt: now + 5_000 }));
    expect(await repo.deleteExpiredSessions(now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteAccount — full cascade across every account-scoped table in one txn
// (iphone-app M-ACCT-US-6 / M-BR-ACCT-6; BR-A9 isolation)
// ---------------------------------------------------------------------------

describe("deleteAccount (cascade)", () => {
  /** Read the row count for an aggregate `count(*)::int AS n` result. */
  function n(res: { rows: unknown[] }): number {
    return (res.rows[0] as { n: number }).n;
  }

  /** A full per-account row count across the six cascade tables. */
  async function snapshot(accountId: string, email: string) {
    return {
      account: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM account WHERE id = ${accountId}`,
        ),
      ),
      session: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM auth_session WHERE account_id = ${accountId}`,
        ),
      ),
      otp: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM otp_code WHERE email = ${email}`,
        ),
      ),
      conversation: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM conversation WHERE account_id = ${accountId}`,
        ),
      ),
      message: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM conversation_message WHERE account_id = ${accountId}`,
        ),
      ),
      team: n(
        await fix.db.execute(
          sql`SELECT count(*)::int AS n FROM team WHERE account_id = ${accountId}`,
        ),
      ),
    };
  }

  /** Seed an account plus one row in every cascade table (2 messages). */
  async function seedFullAccount(email: string) {
    const accountId = randomUUID();
    const t = 1_700_000_000_000;
    await repo.createAccount(email, accountId, t);
    await repo.insertSession({
      id: randomUUID(),
      tokenHash: `th-${randomUUID()}`,
      accountId,
      createdAt: t,
      expiresAt: t + 30 * 24 * 60 * 60_000,
    });
    await repo.upsertOtpCode({
      email,
      codeHash: `ch-${randomUUID()}`,
      createdAt: t,
      expiresAt: t + 600_000,
    });
    const teamId = randomUUID();
    await fix.db.execute(
      sql`INSERT INTO team (id, account_id, format, name, members, created_at, updated_at)
          VALUES (${teamId}, ${accountId}, 'scarlet-violet', 'My Team', '[]', ${t}, ${t})`,
    );
    const convId = randomUUID();
    await fix.db.execute(
      sql`INSERT INTO conversation (id, account_id, title, format, pinned, created_at, updated_at)
          VALUES (${convId}, ${accountId}, 'Chat', 'scarlet-violet', 0, ${t}, ${t})`,
    );
    await fix.db.execute(
      sql`INSERT INTO conversation_message (id, conversation_id, account_id, seq, role, text_content, answer_json, created_at)
          VALUES (${randomUUID()}, ${convId}, ${accountId}, 0, 'user', 'hi', NULL, ${t})`,
    );
    await fix.db.execute(
      sql`INSERT INTO conversation_message (id, conversation_id, account_id, seq, role, text_content, answer_json, created_at)
          VALUES (${randomUUID()}, ${convId}, ${accountId}, 1, 'assistant', 'hello', '{}', ${t})`,
    );
    return { accountId, email };
  }

  const FULL = {
    account: 1,
    session: 1,
    otp: 1,
    conversation: 1,
    message: 2,
    team: 1,
  };
  const EMPTY = {
    account: 0,
    session: 0,
    otp: 0,
    conversation: 0,
    message: 0,
    team: 0,
  };

  it("removes EVERY account-scoped row across all six tables", async () => {
    const { accountId, email } = await seedFullAccount(EMAIL);
    expect(await snapshot(accountId, email)).toEqual(FULL);

    await repo.deleteAccount(accountId);

    expect(await snapshot(accountId, email)).toEqual(EMPTY);
  });

  it("never deletes another account's rows (BR-A9 isolation)", async () => {
    const target = await seedFullAccount("ash@pallet.town");
    const other = await seedFullAccount("misty@cerulean.gym");

    await repo.deleteAccount(target.accountId);

    // Target wiped; the OTHER account is wholly intact.
    expect(await snapshot(target.accountId, target.email)).toEqual(EMPTY);
    expect(await snapshot(other.accountId, other.email)).toEqual(FULL);
  });

  it("is idempotent — a second delete and an unknown id are clean no-ops", async () => {
    const { accountId, email } = await seedFullAccount(EMAIL);
    await repo.deleteAccount(accountId);

    await expect(repo.deleteAccount(accountId)).resolves.toBeUndefined();
    await expect(repo.deleteAccount(randomUUID())).resolves.toBeUndefined();
    expect(await snapshot(accountId, email)).toEqual(EMPTY);
  });

  it("deletes an account that has no child rows (FK-safe, children are no-ops)", async () => {
    const accountId = randomUUID();
    await repo.createAccount(EMAIL, accountId, 1);

    await repo.deleteAccount(accountId);

    expect(await repo.findAccountByEmail(EMAIL)).toBeNull();
  });
});
