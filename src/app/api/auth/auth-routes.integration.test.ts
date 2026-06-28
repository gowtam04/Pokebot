/**
 * AUTH-BACKEND-E2E checkpoint — the `/api/auth/*` route handlers exercised
 * end-to-end against a real Testcontainers Postgres + the real console email
 * transport, with NO service/repo/session mocking (account-creation design.md
 * § Build Manifest `integration_checkpoints.after:[p4] auth-backend-e2e`,
 * Phase 7 / p7; AUTH-US-2/US-5, AC-2.1/2.3/2.5/2.6/5.1/5.2, BR-A1/BR-A4/BR-A6).
 *
 * This is the post-Phase-4 integration checkpoint: it proves the four handlers
 * compose into a correct cookie lifecycle and a non-enumerating surface BEFORE
 * any UI exists. Everything below the HTTP edge is REAL — auth-service, the
 * accounts-repo, the session crypto, the in-memory OTP throttle, and the console
 * transport all run for real against an isolated migrated Postgres schema
 * (`@/data/db` singleton installed via installAsSingleton). Only two things are
 * stubbed, both unavoidable outside a Next request:
 *   - `server-only` (throws under the vitest node env), and
 *   - `next/headers` cookies(), replaced by an in-memory jar so the handlers can
 *     read/write cookies. The jar serializes each `cookies().set()`/`.delete()`
 *     into a REAL `Set-Cookie` header that we bridge onto the returned Response
 *     (exactly what the Next runtime does) and then THREAD BY HAND into a
 *     persistent "browser" cookie store fed back into the next request.
 *
 * The OTP code is never hardcoded — it is captured from the console transport's
 * in-memory ring (the only place a plaintext code is observable in dev/test).
 *
 * Harness ordering (mirrors sessions.test.ts / auth-service.test.ts): migrate an
 * isolated schema, installAsSingleton(fix), THEN dynamically import the route
 * modules so their static `import { db }` captures this schema.
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

import { env } from "@/env";

// db.ts / repos / sessions / current-user all `import "server-only"` (throws
// under node). Neutralize it; the real Postgres handle is installed below.
vi.mock("server-only", () => ({}));

// In-memory stand-in for next/headers' request-scoped cookies(). `ctx` is swapped
// per route invocation by callRoute: `incoming` is what the handler reads,
// `setCookies` collects the Set-Cookie strings the handler stages (which callRoute
// then bridges onto the Response). vi.hoisted keeps it referenceable from the
// (hoisted) vi.mock factory.
const cookieMock = vi.hoisted(() => {
  const ctx = {
    incoming: new Map<string, string>(),
    setCookies: [] as string[],
  };
  /**
   * Serialize a cookies().set(name, value, options) into a realistic Set-Cookie
   * header so the bridged Response carries the EXACT attributes the route asked
   * for (HttpOnly / SameSite / Path / Max-Age / Secure-in-prod / Expires).
   */
  function serialize(
    name: string,
    value: string,
    options: Record<string, unknown>,
  ): string {
    const parts = [`${name}=${value}`];
    if (typeof options.path === "string") parts.push(`Path=${options.path}`);
    if (typeof options.maxAge === "number")
      parts.push(`Max-Age=${options.maxAge}`);
    if (options.expires instanceof Date)
      parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options.httpOnly) parts.push("HttpOnly");
    if (options.secure) parts.push("Secure");
    if (typeof options.sameSite === "string") {
      const s = options.sameSite;
      parts.push(`SameSite=${s.charAt(0).toUpperCase()}${s.slice(1)}`);
    }
    return parts.join("; ");
  }
  const store = {
    get(name: string) {
      const value = ctx.incoming.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...ctx.incoming].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string, options: Record<string, unknown> = {}) {
      ctx.setCookies.push(serialize(name, value, options));
    },
    delete(name: string) {
      // Next's cookies().delete(name) clears by writing an expired cookie.
      ctx.setCookies.push(
        serialize(name, "", { path: "/", maxAge: 0, expires: new Date(0) }),
      );
    },
  };
  return { ctx, store };
});

vi.mock("next/headers", () => ({ cookies: async () => cookieMock.store }));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../../test/support/pg";

// ---------------------------------------------------------------------------
// Dynamically-imported subjects (must load AFTER installAsSingleton so their
// `import { db }` binds to this schema).
// ---------------------------------------------------------------------------

type RequestCodeRoute = typeof import("./request-code/route");
type VerifyRoute = typeof import("./verify/route");
type SignoutRoute = typeof import("./signout/route");
type MeRoute = typeof import("./me/route");
type ConsoleTransport = typeof import("@/server/auth/email/console-transport");
type Throttle = typeof import("@/server/auth/otp-throttle");
type Repo = typeof import("@/data/repos/accounts-repo");

let fix: PgFixture;
let requestCodeRoute: RequestCodeRoute;
let verifyRoute: VerifyRoute;
let signoutRoute: SignoutRoute;
let meRoute: MeRoute;
let consoleTransport: ConsoleTransport;
let throttle: Throttle;
let repo: Repo;

// ---------------------------------------------------------------------------
// Cookie threading + HTTP harness
// ---------------------------------------------------------------------------

/** Persistent "browser" cookie store, threaded by hand across requests. */
const browser = new Map<string, string>();

/** The Cookie header a real browser would send for the current jar state. */
function cookieHeader(): string | undefined {
  if (browser.size === 0) return undefined;
  return [...browser].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Build a POST Request, attaching the current browser cookies + an IP. */
function makeReq(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  // The handlers read cookies via next/headers (the in-memory jar), not from
  // this header; we still attach it so the Request mirrors a real round-trip.
  const cookie = cookieHeader();
  if (cookie !== undefined) headers["cookie"] = cookie;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface Captured {
  status: number;
  bodyText: string;
  /** The Set-Cookie strings the handler staged (bridged onto `res`). */
  setCookies: string[];
  /** All response headers EXCEPT Set-Cookie, for the no-leak scan. */
  headerDump: string;
  res: Response;
}

/**
 * Invoke a route handler with the current browser cookies visible to
 * next/headers, bridge any staged Set-Cookie onto the Response (what Next does),
 * and thread those cookies back into the browser jar for the next request.
 */
async function callRoute(run: () => Promise<Response>): Promise<Captured> {
  cookieMock.ctx.incoming = new Map(browser);
  cookieMock.ctx.setCookies = [];

  const res = await run();

  const setCookies = [...cookieMock.ctx.setCookies];
  for (const sc of setCookies) res.headers.append("set-cookie", sc);
  applySetCookies(setCookies);

  const bodyText = await res.text();
  const headerLines: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headerLines.push(`${key}: ${value}`);
  });

  return {
    status: res.status,
    bodyText,
    setCookies,
    headerDump: headerLines.join("\n"),
    res,
  };
}

/** Thread Set-Cookie directives into the browser jar (set, or clear on Max-Age=0). */
function applySetCookies(setCookies: string[]): void {
  for (const sc of setCookies) {
    const semi = sc.indexOf(";");
    const pair = semi === -1 ? sc : sc.slice(0, semi);
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const cleared = value === "" || /;\s*Max-Age=0\b/i.test(sc);
    if (cleared) browser.delete(name);
    else browser.set(name, value);
  }
}

/** Parse a captured JSON body (implicit any — mirrors `await res.json()`). */
function bodyJson(cap: Captured) {
  return JSON.parse(cap.bodyText);
}

/**
 * Assert no plaintext secret leaks into a response body or any NON-Set-Cookie
 * header. The session token is allowed to appear in the Set-Cookie value (that
 * IS the cookie) — `headerDump` excludes Set-Cookie, so the token must not show
 * up anywhere else. Empty/undefined secrets are skipped (every string contains
 * "").
 */
function assertNoSecretLeak(
  cap: Captured,
  secrets: ReadonlyArray<string | undefined>,
): void {
  const haystack = `${cap.bodyText}\n${cap.headerDump}`;
  for (const secret of secrets) {
    if (secret) {
      expect(
        haystack,
        "no raw code/token/secret may appear in a response body or non-Set-Cookie header",
      ).not.toContain(secret);
    }
  }
}

/** Live auth_session row count (proves server-side revocation, not just cookie). */
async function sessionCount(): Promise<number> {
  const res = await fix.db.execute(
    sql`SELECT count(*)::int AS n FROM auth_session`,
  );
  return (res.rows[0] as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  requestCodeRoute = await import("./request-code/route");
  verifyRoute = await import("./verify/route");
  signoutRoute = await import("./signout/route");
  meRoute = await import("./me/route");
  consoleTransport = await import("@/server/auth/email/console-transport");
  throttle = await import("@/server/auth/otp-throttle");
  repo = await import("@/data/repos/accounts-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE account, auth_session, otp_code RESTART IDENTITY`,
  );
  throttle._resetForTests();
  consoleTransport.clearSentOtpEmails();
  browser.clear();
  vi.restoreAllMocks();
});

// ===========================================================================
// The ordered checkpoint: request-code → verify → me → signout → me
// ===========================================================================

describe("auth-backend-e2e (Phase 4 checkpoint)", () => {
  it("walks the full cookie lifecycle in order with no secret leaks", async () => {
    const email = "ash@pallet.town";
    const ip = "203.0.113.7";

    // --- 1. request-code → 200, capture the code from the console ring -------
    const reqCap = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq("/api/auth/request-code", { email }, { "x-forwarded-for": ip }),
      ),
    );
    expect(reqCap.status).toBe(200);
    expect(bodyJson(reqCap)).toEqual({ ok: true });
    // request-code never establishes a session.
    expect(reqCap.setCookies).toHaveLength(0);

    const sent = consoleTransport.getLastSentOtpEmail();
    expect(sent?.to).toBe(email);
    const code = sent?.code;
    expect(code).toMatch(/^\d{6}$/);

    // --- 2. verify → 200 {created:true} + hardened Set-Cookie ---------------
    const verifyCap = await callRoute(() =>
      verifyRoute.POST(
        makeReq(
          "/api/auth/verify",
          { email, code },
          { "x-forwarded-for": ip },
        ),
      ),
    );
    expect(verifyCap.status).toBe(200);
    expect(bodyJson(verifyCap)).toEqual({ ok: true, email, created: true });

    expect(verifyCap.setCookies).toHaveLength(1);
    const setCookie = verifyCap.setCookies[0]!;
    expect(setCookie).toMatch(/^oak_session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000"); // 30 days in seconds
    // No `Secure` in the test env (NODE_ENV=test) so http://localhost works.
    expect(setCookie).not.toMatch(/secure/i);

    const sessionToken = setCookie
      .slice("oak_session=".length)
      .split(";")[0]!;
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
    // The session row is real and exactly one.
    expect(await sessionCount()).toBe(1);
    // Cookie was threaded into the browser jar.
    expect(browser.get("oak_session")).toBe(sessionToken);

    // --- 3. me → signed in --------------------------------------------------
    const meIn = await callRoute(() => meRoute.GET());
    expect(meIn.status).toBe(200);
    expect(bodyJson(meIn)).toEqual({ signedIn: true, email });

    // --- 4. signout → 200, clears the cookie --------------------------------
    const signoutCap = await callRoute(() => signoutRoute.POST());
    expect(signoutCap.status).toBe(200);
    expect(bodyJson(signoutCap)).toEqual({ ok: true });
    expect(signoutCap.setCookies).toHaveLength(1);
    const clearCookie = signoutCap.setCookies[0]!;
    expect(clearCookie).toMatch(/^oak_session=;/); // empty value
    expect(clearCookie).toContain("Max-Age=0");
    // Threaded out of the browser jar.
    expect(browser.has("oak_session")).toBe(false);

    // --- 5. me → signed out; the ROW is gone, not merely the cookie ---------
    const meOut = await callRoute(() => meRoute.GET());
    expect(meOut.status).toBe(200);
    expect(bodyJson(meOut)).toEqual({ signedIn: false });
    // Server-side revocation: the auth_session row was deleted.
    expect(await sessionCount()).toBe(0);

    // Replay the OLD token (as a client that kept the cookie would): still
    // signed out, because the session was revoked server-side — not just locally.
    browser.set("oak_session", sessionToken);
    const meReplay = await callRoute(() => meRoute.GET());
    expect(bodyJson(meReplay)).toEqual({ signedIn: false });
    browser.delete("oak_session");

    // --- no raw code / token / secret in any response body or header --------
    const secrets = [code, sessionToken, env.AUTH_SECRET];
    for (const cap of [reqCap, verifyCap, meIn, signoutCap, meOut, meReplay]) {
      assertNoSecretLeak(cap, secrets);
    }
  });

  // -------------------------------------------------------------------------
  // 400 — wrong code, with attemptsRemaining and no session (AC-2.5, BR-A4)
  // -------------------------------------------------------------------------
  it("rejects a wrong code with 400 invalid_code + attemptsRemaining and no cookie (AC-2.5)", async () => {
    const email = "wrong-code@test.com";
    const ip = "198.51.100.5";

    const reqCap = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq("/api/auth/request-code", { email }, { "x-forwarded-for": ip }),
      ),
    );
    expect(reqCap.status).toBe(200);
    const realCode = consoleTransport.getLastSentOtpEmail()!.code;

    // A definitely-different 6-digit code.
    const wrong = realCode === "000000" ? "111111" : "000000";
    const vc = await callRoute(() =>
      verifyRoute.POST(
        makeReq(
          "/api/auth/verify",
          { email, code: wrong },
          { "x-forwarded-for": ip },
        ),
      ),
    );

    expect(vc.status).toBe(400);
    const body = bodyJson(vc);
    expect(body.code).toBe("invalid_code");
    expect(typeof body.attemptsRemaining).toBe("number");
    expect(body.attemptsRemaining).toBe(4); // OTP_MAX_ATTEMPTS(5) - 1
    // A failed verify never issues a session.
    expect(vc.setCookies).toHaveLength(0);
    expect(await sessionCount()).toBe(0);
    // The real code must not be echoed back.
    assertNoSecretLeak(vc, [realCode, env.AUTH_SECRET]);
  });

  // -------------------------------------------------------------------------
  // 429 — request throttle (cooldown) with a NUMERIC Retry-After (BR-A6)
  // -------------------------------------------------------------------------
  it("throttles a too-soon resend with 429 rate_limited + a numeric Retry-After (BR-A6)", async () => {
    const email = "throttled@test.com";
    const ip = "198.51.100.9";

    const first = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq("/api/auth/request-code", { email }, { "x-forwarded-for": ip }),
      ),
    );
    expect(first.status).toBe(200);

    // Immediate re-request for the same email is inside the 60s cooldown.
    const second = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq("/api/auth/request-code", { email }, { "x-forwarded-for": ip }),
      ),
    );
    expect(second.status).toBe(429);
    expect(bodyJson(second).code).toBe("rate_limited");

    const retryAfter = second.res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    // Whole seconds, parseable as a positive integer.
    expect(String(retryAfter)).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 502 — email delivery fault is surfaced (NOT a 200) — retryable (NFR)
  // -------------------------------------------------------------------------
  it("maps an email delivery fault to 502 email_failed (not 200)", async () => {
    const email = "bounce@test.com";
    const ip = "198.51.100.20";

    // Force the (real) console transport to throw a delivery fault exactly once.
    const spy = vi
      .spyOn(consoleTransport.consoleEmailTransport, "sendOtpEmail")
      .mockRejectedValueOnce(new Error("transport 500"));

    const cap = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq("/api/auth/request-code", { email }, { "x-forwarded-for": ip }),
      ),
    );

    expect(cap.status).toBe(502);
    expect(cap.status).not.toBe(200);
    expect(bodyJson(cap).code).toBe("email_failed");
    expect(spy).toHaveBeenCalledTimes(1);
    // No session is established on a failed request.
    expect(cap.setCookies).toHaveLength(0);
    spy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // BR-A1 — non-enumerating: known vs unknown email are byte-identical
  // -------------------------------------------------------------------------
  it("returns identical 200 responses for a registered vs unregistered email (BR-A1, AC-2.2)", async () => {
    const known = "known@test.com";
    const unknown = "unknown@test.com";
    const ip = "198.51.100.30";

    // Pre-register exactly one of the two emails.
    await repo.createAccount(known, randomUUID(), Date.now());

    // Distinct emails (so per-email cooldown can't differ) + same IP under the
    // per-IP cap (2 < 20): the ONLY difference between the calls is registration.
    const knownCap = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq(
          "/api/auth/request-code",
          { email: known },
          { "x-forwarded-for": ip },
        ),
      ),
    );
    const unknownCap = await callRoute(() =>
      requestCodeRoute.POST(
        makeReq(
          "/api/auth/request-code",
          { email: unknown },
          { "x-forwarded-for": ip },
        ),
      ),
    );

    expect(knownCap.status).toBe(200);
    expect(unknownCap.status).toBe(200);
    // The defining BR-A1 assertion: byte-identical bodies.
    expect(bodyJson(knownCap)).toEqual(bodyJson(unknownCap));
    expect(bodyJson(knownCap)).toEqual({ ok: true });
    // Neither leaks registration via a cookie or a differing content-type.
    expect(knownCap.setCookies).toEqual(unknownCap.setCookies);
    expect(knownCap.setCookies).toHaveLength(0);
    expect(knownCap.res.headers.get("content-type")).toBe(
      unknownCap.res.headers.get("content-type"),
    );
  });
});
