/**
 * Production cookie hardening for the session cookie (account-creation design.md
 * § API Design, AD-3, BR-A7): `setSessionCookie` must mark the cookie `Secure`
 * when — and only when — `NODE_ENV === "production"`.
 *
 * `sessions.ts` captures `env.NODE_ENV` at module load (env is memoized), so the
 * prod path can't be exercised by the main `sessions.test.ts` (which runs under
 * NODE_ENV=test). This standalone file stubs the env and imports `sessions` fresh
 * per case — isolated here precisely so the module reset never touches the 21
 * DB-backed tests in `sessions.test.ts`. It only calls `setSessionCookie` (cookie
 * I/O), so no Postgres/Testcontainers is needed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// sessions.ts → @/data/db / accounts-repo `import "server-only"` (throws under
// node). Neutralize it; this test never touches the DB.
vi.mock("server-only", () => ({}));

// In-memory cookie jar standing in for next/headers' request-scoped cookies(),
// recording the options each cookie is written with (so we can assert `secure`).
const cookieMock = vi.hoisted(() => {
  const jar = new Map<
    string,
    { value: string; options: Record<string, unknown> }
  >();
  return {
    jar,
    store: {
      set: (
        name: string,
        value: string,
        options: Record<string, unknown> = {},
      ) => {
        jar.set(name, { value, options });
      },
      get: (name: string) => {
        const e = jar.get(name);
        return e === undefined ? undefined : { name, value: e.value };
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    },
  };
});
vi.mock("next/headers", () => ({ cookies: async () => cookieMock.store }));

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  cookieMock.jar.clear();
  vi.unstubAllEnvs();
  vi.resetModules(); // force @/env + sessions to re-parse on the next import
});

describe("setSessionCookie — Secure flag by environment (AD-3, BR-A7)", () => {
  it("sets Secure=true under NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Production also requires a non-default AUTH_SECRET (env superRefine), else
    // parseEnv throws at module load.
    vi.stubEnv("AUTH_SECRET", "prod-strong-secret-not-the-dev-default-0123456789");

    const { setSessionCookie, SESSION_COOKIE } = await import(
      "@/server/auth/sessions"
    );
    await setSessionCookie("tok-prod", Date.now() + THIRTY_DAYS_MS);

    const entry = cookieMock.jar.get(SESSION_COOKIE);
    expect(entry?.options.secure).toBe(true);
    // Still httpOnly + Lax + Path=/ in prod (hardening is additive).
    expect(entry?.options.httpOnly).toBe(true);
    expect(entry?.options.sameSite).toBe("lax");
    expect(entry?.options.path).toBe("/");
  });

  it("leaves Secure=false under NODE_ENV=test (control — guards a tautology)", async () => {
    vi.stubEnv("NODE_ENV", "test");

    const { setSessionCookie, SESSION_COOKIE } = await import(
      "@/server/auth/sessions"
    );
    await setSessionCookie("tok-test", Date.now() + THIRTY_DAYS_MS);

    const entry = cookieMock.jar.get(SESSION_COOKIE);
    expect(entry?.options.secure).toBe(false);
  });
});
