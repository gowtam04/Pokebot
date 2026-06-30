/**
 * Route-adapter tests for POST /api/auth/verify (account-creation design.md
 * § API Design; BR-A1, BR-A4, AC-2.3, AC-2.4, AC-2.5, AC-2.6).
 *
 * The route is a THIN adapter; these tests pin the HTTP contract for every
 * `auth-service.verifyCode` discriminant. `verifyCode` and `setSessionCookie`
 * are mocked so each branch is driven deterministically (no DB / next/headers):
 * the success path must emit the session cookie (the one Set-Cookie on the auth
 * surface) and the `{ ok, email, created }` body; every failure branch asserts
 * its status + `code` (and, for invalid_code, `attemptsRemaining`) AND that no
 * cookie was set.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const svc = vi.hoisted(() => ({
  verifyCode:
    vi.fn<(email: string, code: string, ip: string) => Promise<unknown>>(),
}));
const sess = vi.hoisted(() => ({
  setSessionCookie:
    vi.fn<(token: string, expiresAt: number) => Promise<void>>(),
}));
vi.mock("@/server/auth/auth-service", () => ({ verifyCode: svc.verifyCode }));
vi.mock("@/server/auth/sessions", () => ({
  setSessionCookie: sess.setSessionCookie,
}));

import { POST } from "./route";

function makeReq(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ACCOUNT = {
  id: "acct-1",
  email: "ash@pallet.town",
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  svc.verifyCode.mockReset();
  sess.setSessionCookie.mockReset();
  sess.setSessionCookie.mockResolvedValue(undefined);
});

describe("POST /api/auth/verify", () => {
  it("first-time signup → 200 { ok, email, created:true } and sets the session cookie (AC-2.3)", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: true,
      account: ACCOUNT,
      token: "raw-token-abc",
      expiresAt: 2_000_000_000_000,
      created: true,
    });

    const res = await POST(
      makeReq(
        { email: "ash@pallet.town", code: "123456" },
        { "x-forwarded-for": "5.5.5.5" },
      ),
    );

    expect(res.status).toBe(200);
    // The body now ALSO carries the raw token + expiry (ADR-2): the native client
    // stores them in the Keychain and sends the token as `Authorization: Bearer`.
    expect(await res.json()).toEqual({
      ok: true,
      email: "ash@pallet.town",
      created: true,
      token: "raw-token-abc",
      expiresAt: 2_000_000_000_000,
    });
    // The Set-Cookie step: session issued with the raw token + its expiry.
    expect(sess.setSessionCookie).toHaveBeenCalledWith(
      "raw-token-abc",
      2_000_000_000_000,
    );
    // IP forwarded to the per-IP verify throttle.
    expect(svc.verifyCode).toHaveBeenCalledWith(
      "ash@pallet.town",
      "123456",
      "5.5.5.5",
    );
  });

  it("returning login → 200 created:false, no duplicate signalled (AC-2.4)", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: true,
      account: ACCOUNT,
      token: "tok",
      expiresAt: 2_000_000_000_000,
      created: false,
    });

    const res = await POST(makeReq({ email: "ash@pallet.town", code: "123456" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      email: "ash@pallet.town",
      created: false,
      token: "tok",
      expiresAt: 2_000_000_000_000,
    });
    expect(sess.setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("wrong code → 400 invalid_code with attemptsRemaining, no cookie (AC-2.5)", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: false,
      reason: "invalid_code",
      attemptsRemaining: 3,
    });

    const res = await POST(makeReq({ email: "ash@pallet.town", code: "000000" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_code");
    expect(body.attemptsRemaining).toBe(3);
    expect(sess.setSessionCookie).not.toHaveBeenCalled();
  });

  it("expired/used/missing code → 400 invalid_or_expired, no cookie (AC-2.6)", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: false,
      reason: "invalid_or_expired",
    });

    const res = await POST(makeReq({ email: "ash@pallet.town", code: "999999" }));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_or_expired");
    expect(sess.setSessionCookie).not.toHaveBeenCalled();
  });

  it("locked-out code → 400 too_many_attempts, no cookie (BR-A4)", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: false,
      reason: "too_many_attempts",
    });

    const res = await POST(makeReq({ email: "ash@pallet.town", code: "123456" }));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("too_many_attempts");
    expect(sess.setSessionCookie).not.toHaveBeenCalled();
  });

  it("per-IP verify throttle → 429 rate_limited + Retry-After", async () => {
    svc.verifyCode.mockResolvedValue({
      ok: false,
      reason: "throttled",
      retryAfterMs: 30_500,
    });

    const res = await POST(makeReq({ email: "ash@pallet.town", code: "123456" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("31");
    expect((await res.json()).code).toBe("rate_limited");
    expect(sess.setSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects a body missing code with 400 invalid_request and never verifies", async () => {
    const res = await POST(makeReq({ email: "ash@pallet.town" }));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(svc.verifyCode).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400 invalid_request and never verifies", async () => {
    const res = await POST(makeReq("}{", {}));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(svc.verifyCode).not.toHaveBeenCalled();
  });
});
