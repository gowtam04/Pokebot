/**
 * Oracle/integration tests for src/server/auth/current-user.ts — the SINGLE
 * identity seam every authenticated route resolves through, extended with the
 * `Authorization: Bearer` fallback (iphone-app ADR-2; M-ACCT-US-2, M-BR-ACCT-5,
 * M-BR-PLAT-3).
 *
 * The load-bearing claims:
 *   - a Bearer token resolves to the SAME `Account` the cookie would (identical
 *     hash + lookup via resolveSessionToken — no separate token type/path),
 *   - the COOKIE PATH WINS when both are present (cookie tried first, unchanged),
 *   - the Bearer path degrades to guest (`null`) on absent/malformed/unknown/
 *     revoked tokens, never throwing, and is strictly per-account (BR-A9).
 *
 * current-user.ts → sessions.ts → accounts-repo.ts all read the `@/data/db`
 * SINGLETON, so the harness mirrors sessions.test.ts: migrate an isolated schema,
 * installAsSingleton BEFORE the first dynamic import, neutralize `server-only`,
 * and mock `next/headers` with an in-memory cookie jar + a settable header store
 * so both credential sources are drivable outside a request scope.
 */

import { randomBytes, randomUUID } from "node:crypto";

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

// db.ts / accounts-repo.ts / sessions.ts / current-user.ts `import "server-only"`
// (throws under node). Neutralize it; the real Postgres handle is installed below.
vi.mock("server-only", () => ({}));

// In-memory stand-ins for next/headers' request-scoped cookies() + headers().
// `vi.hoisted` keeps them referenceable from the (hoisted) vi.mock factory; tests
// mutate `cookieMock.jar` / `headerMock.ctx.authorization` to set credentials.
const cookieMock = vi.hoisted(() => {
  const jar = new Map<string, string>();
  return {
    jar,
    store: {
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      get: (name: string) => {
        const value = jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    },
  };
});

const headerMock = vi.hoisted(() => {
  const ctx = { authorization: undefined as string | undefined };
  return {
    ctx,
    store: {
      get: (name: string) =>
        name.toLowerCase() === "authorization"
          ? ctx.authorization ?? null
          : null,
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => cookieMock.store,
  headers: async () => headerMock.store,
}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

type CurrentUser = typeof import("./current-user");
type Sessions = typeof import("./sessions");
type Repo = typeof import("@/data/repos/accounts-repo");

let fix: PgFixture;
let currentUser: CurrentUser;
let sessions: Sessions;
let repo: Repo;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  currentUser = await import("./current-user");
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
  headerMock.ctx.authorization = undefined;
});

const SESSION_COOKIE = "oak_session";

/** Seed an account and an issued session for it; return the account + raw token. */
async function seedAccountWithSession(email = "ash@pallet.town") {
  const account = await repo.createAccount(email, randomUUID(), 1_700_000_000_000);
  const { token } = await sessions.issueSession(account.id);
  return { account, token };
}

function setCookie(token: string): void {
  cookieMock.jar.set(SESSION_COOKIE, token);
}

function setBearer(token: string): void {
  headerMock.ctx.authorization = `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Cookie path (unchanged) — the primary, byte-identical-to-web behavior
// ---------------------------------------------------------------------------

describe("getCurrentAccount — cookie path (unchanged)", () => {
  it("resolves the oak_session cookie token to its owning account", async () => {
    const { account, token } = await seedAccountWithSession();
    setCookie(token);

    expect(await currentUser.getCurrentAccount()).toEqual(account);
  });

  it("returns null for a guest with no cookie and no Authorization header", async () => {
    expect(await currentUser.getCurrentAccount()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bearer fallback (ADR-2) — identical identity, guest-safe failures
// ---------------------------------------------------------------------------

describe("getCurrentAccount — Bearer fallback (ADR-2)", () => {
  it("resolves a Bearer token to the SAME account the cookie would (identical identity)", async () => {
    const { account, token } = await seedAccountWithSession();

    // Cookie resolution (baseline)…
    setCookie(token);
    const viaCookie = await currentUser.getCurrentAccount();

    // …vs. the identical token carried as a Bearer header, no cookie.
    cookieMock.jar.clear();
    setBearer(token);
    const viaBearer = await currentUser.getCurrentAccount();

    expect(viaBearer).toEqual(account);
    // The defining claim: Bearer === cookie identity, byte for byte.
    expect(viaBearer).toEqual(viaCookie);
  });

  it("accepts a case-insensitive scheme and surrounding whitespace", async () => {
    const { account, token } = await seedAccountWithSession();
    headerMock.ctx.authorization = `  bearer   ${token}  `;
    expect(await currentUser.getCurrentAccount()).toEqual(account);
  });

  it("returns null for an unknown Bearer token (degrades to guest)", async () => {
    await seedAccountWithSession();
    setBearer(randomBytes(32).toString("hex"));
    expect(await currentUser.getCurrentAccount()).toBeNull();
  });

  it("returns null for a revoked/orphaned Bearer token", async () => {
    const { token } = await seedAccountWithSession();
    await sessions.revokeSessionToken(token); // sign-out: row deleted
    setBearer(token);
    expect(await currentUser.getCurrentAccount()).toBeNull();
  });

  it("ignores a non-Bearer Authorization header (e.g. Basic)", async () => {
    const { token } = await seedAccountWithSession();
    headerMock.ctx.authorization = `Basic ${token}`;
    expect(await currentUser.getCurrentAccount()).toBeNull();
  });

  it("ignores a bare Authorization header with no token", async () => {
    headerMock.ctx.authorization = "Bearer";
    expect(await currentUser.getCurrentAccount()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Precedence — cookie is tried first and WINS when both are present
// ---------------------------------------------------------------------------

describe("getCurrentAccount — cookie wins over Bearer", () => {
  it("returns the COOKIE account when a valid cookie and a valid Bearer disagree", async () => {
    const ash = await seedAccountWithSession("ash@pallet.town");
    const misty = await seedAccountWithSession("misty@cerulean.gym");

    setCookie(ash.token); // valid cookie session for Ash …
    setBearer(misty.token); // … and a valid Bearer for Misty

    // Cookie path is tried first and short-circuits — Ash wins, Misty ignored.
    expect(await currentUser.getCurrentAccount()).toEqual(ash.account);
  });

  it("falls through to Bearer when the cookie token is invalid", async () => {
    const { account, token } = await seedAccountWithSession();
    setCookie("not-a-real-token"); // present but unresolvable …
    setBearer(token); // … so the Bearer fallback takes over

    expect(await currentUser.getCurrentAccount()).toEqual(account);
  });
});

// ---------------------------------------------------------------------------
// Per-account isolation (BR-A9) — a Bearer token resolves ONLY to its owner
// ---------------------------------------------------------------------------

describe("getCurrentAccount — Bearer isolation (BR-A9)", () => {
  it("a Bearer token for account B never resolves to account A", async () => {
    const ash = await seedAccountWithSession("ash@pallet.town");
    const misty = await seedAccountWithSession("misty@cerulean.gym");

    setBearer(misty.token);
    const resolved = await currentUser.getCurrentAccount();

    expect(resolved).toEqual(misty.account);
    expect(resolved?.id).not.toBe(ash.account.id);
    expect(resolved?.email).not.toBe(ash.account.email);
  });
});
