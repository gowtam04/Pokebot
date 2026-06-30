/**
 * Oracle/integration tests for src/server/auth/sessions.ts — the opaque
 * cookie-session lifecycle (account-creation design.md § Interface Definitions →
 * sessions.ts; AD-3, BR-A2, BR-A7, AC-4.2/4.3/5.1/5.2).
 *
 * sessions.ts and accounts-repo.ts both read the `@/data/db` SINGLETON, so the
 * harness mirrors accounts-repo.test.ts:
 *   1. migrate an isolated Postgres schema (createPgSchema, seed "none"),
 *   2. installAsSingleton(fix) BEFORE the first dynamic import of sessions.ts /
 *      the repo (so their static `import { db }` captures THIS schema), and
 *   3. neutralize `server-only` (throws under the vitest node env).
 *
 * `next/headers` is mocked with an in-memory cookie jar so the cookie helpers
 * are exercisable outside a request scope; the jar also captures the options
 * (httpOnly/SameSite/Secure/Max-Age) the helper sets.
 *
 * Negative branches assert the discriminant explicitly (null on absent/unknown/
 * expired/orphaned; the expired row is actually deleted), not happy-path only.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

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

// db.ts / accounts-repo.ts / sessions.ts `import "server-only"` (throws under
// node). Neutralize it; the real Postgres handle is supplied via installAsSingleton.
vi.mock("server-only", () => ({}));

// In-memory cookie jar standing in for next/headers' request-scoped cookies().
// `vi.hoisted` keeps it referenceable from the (hoisted) vi.mock factory.
const cookieMock = vi.hoisted(() => {
  const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    jar,
    store: {
      set: (name: string, value: string, options: Record<string, unknown> = {}) => {
        jar.set(name, { value, options });
      },
      get: (name: string) => {
        const entry = jar.get(name);
        return entry === undefined ? undefined : { name, value: entry.value };
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => cookieMock.store,
}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

type Sessions = typeof import("./sessions");
type Repo = typeof import("@/data/repos/accounts-repo");

let fix: PgFixture;
let sessions: Sessions;
let repo: Repo;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  sessions = await import("./sessions");
  repo = await import("@/data/repos/accounts-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE account, auth_session, otp_code RESTART IDENTITY`,
  );
  cookieMock.jar.clear();
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

/** Seed an account row and return it (sessions resolve to an Account). */
async function seedAccount(email = "ash@pallet.town") {
  const id = randomUUID();
  return repo.createAccount(email, id, 1_700_000_000_000);
}

// ---------------------------------------------------------------------------
// Constants (§ Interface Definitions)
// ---------------------------------------------------------------------------

describe("session constants", () => {
  it("names the cookie oak_session", () => {
    expect(sessions.SESSION_COOKIE).toBe("oak_session");
  });

  it("uses a 30-day fixed session window (BR-A7)", () => {
    expect(sessions.SESSION_TTL_MS).toBe(THIRTY_DAYS_MS);
  });
});

// ---------------------------------------------------------------------------
// hashToken — SHA-256 hex; raw token never equals its hash (AD-3, BR-A2)
// ---------------------------------------------------------------------------

describe("hashToken (AD-3)", () => {
  it("is SHA-256(token) in hex", () => {
    const token = "deadbeef";
    const expected = createHash("sha256").update(token).digest("hex");
    expect(sessions.hashToken(token)).toBe(expected);
  });

  it("emits a 64-char hex digest and differs from the raw token", () => {
    const token = randomBytes(32).toString("hex");
    const hash = sessions.hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
  });

  it("is deterministic", () => {
    expect(sessions.hashToken("x")).toBe(sessions.hashToken("x"));
  });
});

// ---------------------------------------------------------------------------
// issueSession — 256-bit token; only the hash is stored (AD-3, BR-A2)
// ---------------------------------------------------------------------------

describe("issueSession (AD-3, BR-A2, BR-A7)", () => {
  it("mints a 256-bit (64 hex char) token and a 30-day window", async () => {
    const account = await seedAccount();

    const before = Date.now();
    const { token, expiresAt } = await sessions.issueSession(account.id);
    const after = Date.now();

    // 32 bytes → 64 hex chars of CSPRNG entropy.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
  });

  it("stores ONLY the SHA-256 hash, never the raw token (BR-A2)", async () => {
    const account = await seedAccount();
    const { token } = await sessions.issueSession(account.id);

    // The row is found by the token's HASH...
    const row = await repo.findSessionByTokenHash(sessions.hashToken(token));
    expect(row).not.toBeNull();
    expect(row?.accountId).toBe(account.id);
    expect(row?.tokenHash).toBe(sessions.hashToken(token));
    expect(row?.tokenHash).not.toBe(token);

    // ...and NOT by the raw token value (it is never persisted as-is).
    expect(await repo.findSessionByTokenHash(token)).toBeNull();
  });

  it("issues independent sessions per device for one account (AC-4.3)", async () => {
    const account = await seedAccount();
    const a = await sessions.issueSession(account.id);
    const b = await sessions.issueSession(account.id);

    expect(a.token).not.toBe(b.token);
    // Both resolve to the same account.
    expect(await sessions.resolveSessionToken(a.token)).toEqual(account);
    expect(await sessions.resolveSessionToken(b.token)).toEqual(account);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionToken — happy path + every null branch (§ Interface Definitions)
// ---------------------------------------------------------------------------

describe("resolveSessionToken", () => {
  it("resolves a live token to its owning Account", async () => {
    const account = await seedAccount();
    const { token } = await sessions.issueSession(account.id);

    const resolved = await sessions.resolveSessionToken(token);
    expect(resolved).toEqual(account);
    expect(typeof resolved?.createdAt).toBe("number");
  });

  it("returns null for an absent token (undefined cookie)", async () => {
    expect(await sessions.resolveSessionToken(undefined)).toBeNull();
  });

  it("returns null for an empty-string token", async () => {
    expect(await sessions.resolveSessionToken("")).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(
      await sessions.resolveSessionToken(randomBytes(32).toString("hex")),
    ).toBeNull();
  });

  it("treats an expired session as null AND best-effort deletes it (AC-4.2, BR-A7)", async () => {
    const account = await seedAccount();
    const token = randomBytes(32).toString("hex");
    const tokenHash = sessions.hashToken(token);
    const now = Date.now();

    // Craft an already-expired session row directly through the repo.
    await repo.insertSession({
      id: randomUUID(),
      tokenHash,
      accountId: account.id,
      createdAt: now - THIRTY_DAYS_MS,
      expiresAt: now - 1, // just expired
    });

    expect(await sessions.resolveSessionToken(token)).toBeNull();
    // Lazy cleanup: the dead row is gone after the resolve.
    expect(await repo.findSessionByTokenHash(tokenHash)).toBeNull();
  });

  it("returns null for an orphaned session (account row gone)", async () => {
    // issueSession does not verify the account exists; a session whose account
    // was deleted resolves cleanly to null (degrades to guest).
    const { token } = await sessions.issueSession("no-such-account-id");
    expect(await sessions.resolveSessionToken(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-account isolation (BR-A9) — a device token resolves ONLY to its owning
// account; one account can never read or revoke another's session/data.
// ---------------------------------------------------------------------------

describe("per-account isolation (BR-A9)", () => {
  it("resolves each device token to its OWN account only — no cross-account read", async () => {
    const ash = await seedAccount("ash@pallet.town");
    const misty = await seedAccount("misty@cerulean.gym");

    const ashToken = (await sessions.issueSession(ash.id)).token;
    const mistyToken = (await sessions.issueSession(misty.id)).token;

    const ashResolved = await sessions.resolveSessionToken(ashToken);
    const mistyResolved = await sessions.resolveSessionToken(mistyToken);

    // Each token resolves strictly to its owner ...
    expect(ashResolved).toEqual(ash);
    expect(mistyResolved).toEqual(misty);
    // ... and never leaks the OTHER account's identity (the load-bearing BR-A9
    // check: a valid token for A cannot read B).
    expect(ashResolved?.id).not.toBe(misty.id);
    expect(ashResolved?.email).not.toBe(misty.email);
    expect(mistyResolved?.id).not.toBe(ash.id);
  });

  it("revoking one account's session leaves another account's session intact (BR-A9, AC-5.2)", async () => {
    const ash = await seedAccount("ash@pallet.town");
    const misty = await seedAccount("misty@cerulean.gym");
    const ashToken = (await sessions.issueSession(ash.id)).token;
    const mistyToken = (await sessions.issueSession(misty.id)).token;

    await sessions.revokeSessionToken(ashToken);

    // Ash is signed out; Misty is wholly unaffected — strict isolation.
    expect(await sessions.resolveSessionToken(ashToken)).toBeNull();
    expect(await sessions.resolveSessionToken(mistyToken)).toEqual(misty);
  });
});

// ---------------------------------------------------------------------------
// revokeSessionToken — idempotent sign-out (AC-5.1, AC-5.2)
// ---------------------------------------------------------------------------

describe("revokeSessionToken (AC-5.1)", () => {
  it("revokes the current session and leaves other devices signed in (AC-5.2)", async () => {
    const account = await seedAccount();
    const deviceA = await sessions.issueSession(account.id);
    const deviceB = await sessions.issueSession(account.id);

    await sessions.revokeSessionToken(deviceA.token);

    expect(await sessions.resolveSessionToken(deviceA.token)).toBeNull();
    // The other device's session survives.
    expect(await sessions.resolveSessionToken(deviceB.token)).toEqual(account);
  });

  it("is idempotent — re-revoking or revoking absent/undefined tokens is a no-op", async () => {
    const account = await seedAccount();
    const { token } = await sessions.issueSession(account.id);

    await expect(sessions.revokeSessionToken(token)).resolves.toBeUndefined();
    await expect(sessions.revokeSessionToken(token)).resolves.toBeUndefined();
    await expect(
      sessions.revokeSessionToken("never-existed"),
    ).resolves.toBeUndefined();
    await expect(
      sessions.revokeSessionToken(undefined),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full session lifecycle (seam) — issue → resolve → revoke → null
// ---------------------------------------------------------------------------

describe("session lifecycle (seam)", () => {
  it("create → resolve → revoke → resolves null", async () => {
    const account = await seedAccount("trainer@kanto.test");

    const { token, expiresAt } = await sessions.issueSession(account.id);
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Resolves while live.
    expect(await sessions.resolveSessionToken(token)).toEqual(account);

    // After sign-out it no longer resolves.
    await sessions.revokeSessionToken(token);
    expect(await sessions.resolveSessionToken(token)).toBeNull();
    expect(await repo.findSessionByTokenHash(sessions.hashToken(token))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers — httpOnly / SameSite=Lax / Secure-in-prod / Max-Age 30d
// ---------------------------------------------------------------------------

describe("cookie helpers (§ API Design)", () => {
  it("setSessionCookie writes a hardened cookie with a 30-day Max-Age", async () => {
    const expiresAt = Date.now() + THIRTY_DAYS_MS;
    await sessions.setSessionCookie("opaque-token", expiresAt);

    const entry = cookieMock.jar.get(sessions.SESSION_COOKIE);
    expect(entry?.value).toBe("opaque-token");
    expect(entry?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days in SECONDS
    });
    // Secure is gated on production; under the vitest "test" env it is off so
    // http://localhost dev works.
    expect(entry?.options.secure).toBe(false);
    expect((entry?.options.expires as Date).getTime()).toBe(expiresAt);
  });

  it("readSessionCookie round-trips the written token", async () => {
    await sessions.setSessionCookie("tok-123", Date.now() + THIRTY_DAYS_MS);
    expect(await sessions.readSessionCookie()).toBe("tok-123");
  });

  it("readSessionCookie returns undefined when no cookie is set", async () => {
    expect(await sessions.readSessionCookie()).toBeUndefined();
  });

  it("clearSessionCookie removes the cookie (sign-out)", async () => {
    await sessions.setSessionCookie("tok-xyz", Date.now() + THIRTY_DAYS_MS);
    expect(await sessions.readSessionCookie()).toBe("tok-xyz");

    await sessions.clearSessionCookie();
    expect(await sessions.readSessionCookie()).toBeUndefined();
  });
});
