/**
 * Route-adapter tests for POST /api/auth/signout (account-creation design.md
 * § API Design; AUTH-US-5, AC-5.1, AC-5.2).
 *
 * The route is a THIN adapter; these tests pin the IDEMPOTENT sign-out contract
 * (AC-5.1): with a cookie present it revokes that exact token and clears the
 * cookie; with NO cookie it still returns 200 and still clears the cookie
 * (revoke is a no-op). The `sessions` helpers are mocked so the behavior is
 * driven without a DB / next/headers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sess = vi.hoisted(() => ({
  readSessionCookie: vi.fn<() => Promise<string | undefined>>(),
  revokeSessionToken: vi.fn<(token: string | undefined) => Promise<void>>(),
  clearSessionCookie: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/server/auth/sessions", () => sess);

import { POST } from "./route";

beforeEach(() => {
  sess.readSessionCookie.mockReset();
  sess.revokeSessionToken.mockReset().mockResolvedValue(undefined);
  sess.clearSessionCookie.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/auth/signout", () => {
  it("revokes the current device's session and clears the cookie → 200 (AC-5.1)", async () => {
    sess.readSessionCookie.mockResolvedValue("device-token");

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Only the current token is revoked (other devices untouched — AC-5.2).
    expect(sess.revokeSessionToken).toHaveBeenCalledWith("device-token");
    expect(sess.clearSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: no cookie still returns 200 and clears the cookie (AC-5.1)", async () => {
    sess.readSessionCookie.mockResolvedValue(undefined);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // revoke is still invoked (with undefined → documented no-op), cookie cleared.
    expect(sess.revokeSessionToken).toHaveBeenCalledWith(undefined);
    expect(sess.clearSessionCookie).toHaveBeenCalledTimes(1);
  });
});
