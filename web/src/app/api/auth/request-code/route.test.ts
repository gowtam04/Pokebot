/**
 * Route-adapter tests for POST /api/auth/request-code (account-creation design.md
 * § API Design; BR-A1, BR-A6, AC-2.1, AC-2.2).
 *
 * The route is a THIN adapter, so these tests pin the HTTP contract: each
 * `auth-service.requestCode` discriminant maps to the right status / error code
 * / headers, the success body is the non-enumerating `{ ok: true }`, and the
 * client IP is derived from the first X-Forwarded-For hop. The service itself is
 * mocked (its own branch behavior is covered in auth-service.test.ts), so no DB
 * or transport is needed here. Every negative branch asserts the discriminant
 * (status + `code`) explicitly — not happy-path only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's module graph pulls in `server-only` transitively; neutralize it.
vi.mock("server-only", () => ({}));

const svc = vi.hoisted(() => ({
  requestCode: vi.fn<(email: string, ip: string) => Promise<unknown>>(),
}));
vi.mock("@/server/auth/auth-service", () => ({ requestCode: svc.requestCode }));

import { POST } from "./route";

function makeReq(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/auth/request-code", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  svc.requestCode.mockReset();
});

describe("POST /api/auth/request-code", () => {
  it("returns a byte-identical 200 { ok: true } on success — non-enumerating (BR-A1, AC-2.2)", async () => {
    svc.requestCode.mockResolvedValue({ ok: true });

    const res = await POST(
      makeReq({ email: "ash@pallet.town" }, { "x-forwarded-for": "1.2.3.4, 9.9.9.9" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // IP keyed from the FIRST forwarded hop, passed to the throttle (BR-A6).
    expect(svc.requestCode).toHaveBeenCalledWith("ash@pallet.town", "1.2.3.4");
  });

  it("maps invalid_email → 400 invalid_email (AC-2.1)", async () => {
    svc.requestCode.mockResolvedValue({ ok: false, reason: "invalid_email" });

    const res = await POST(makeReq({ email: "not-an-email" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_email");
  });

  it("maps throttled → 429 rate_limited + Retry-After in seconds (BR-A6)", async () => {
    svc.requestCode.mockResolvedValue({
      ok: false,
      reason: "throttled",
      retryAfterMs: 42_000,
    });

    const res = await POST(makeReq({ email: "ash@pallet.town" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect((await res.json()).code).toBe("rate_limited");
  });

  it("maps email_failed → 502 email_failed (retryable, not enumeration)", async () => {
    svc.requestCode.mockResolvedValue({ ok: false, reason: "email_failed" });

    const res = await POST(makeReq({ email: "ash@pallet.town" }));

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("email_failed");
  });

  it("rejects a malformed JSON body with 400 invalid_request and never calls the service", async () => {
    const res = await POST(makeReq("{ not json", {}));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(svc.requestCode).not.toHaveBeenCalled();
  });

  it("rejects a non-string email with 400 invalid_request and never calls the service", async () => {
    const res = await POST(makeReq({ email: 123 }));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(svc.requestCode).not.toHaveBeenCalled();
  });

  it("falls back to an 'unknown' IP key when no forwarding header is present", async () => {
    svc.requestCode.mockResolvedValue({ ok: true });

    await POST(makeReq({ email: "x@y.zz" }));

    expect(svc.requestCode).toHaveBeenCalledWith("x@y.zz", "unknown");
  });
});
