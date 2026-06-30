/**
 * `POST /api/auth/request-code` — issue + email a one-time code (account-creation
 * design.md § API Design "POST /api/auth/request-code", Phase 4 / p4; BR-A1,
 * BR-A6, AC-2.1, AC-2.2).
 *
 * Thin adapter over `auth-service.requestCode`. The defining property is that it
 * is NON-ENUMERATING (BR-A1 / AC-2.2): for any accepted email the response is a
 * byte-identical `200 { ok: true }` whether or not that email is registered —
 * the route never inspects account existence and never maps a branch to
 * "account exists". The service's discriminated Result is mapped to HTTP:
 *
 *   - { ok: true }                      → 200 { ok: true }       (advance to code step)
 *   - invalid_email                     → 400 invalid_email      (AC-2.1)
 *   - throttled (retryAfterMs)          → 429 rate_limited + Retry-After (BR-A6)
 *   - email_failed                      → 502 email_failed       (retryable, NOT enumeration)
 */

import {
  clientIp,
  json,
  jsonError,
  readJsonObject,
  retryAfterHeader,
} from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null || typeof body.email !== "string") {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be { email: string }.",
    );
  }

  // Dynamic import defers the auth chain's env evaluation past module load so
  // `next build` never evaluates @/env (matches the chat route pattern).
  const { requestCode } = await import("@/server/auth/auth-service");
  const result = await requestCode(body.email, clientIp(req));

  if (result.ok) {
    // Non-enumerating success (BR-A1, AC-2.2): identical for registered and
    // unregistered emails. The body carries NO account information.
    return json(200, { ok: true });
  }

  if (result.reason === "invalid_email") {
    return jsonError(400, "invalid_email", "Enter a valid email address.");
  }

  if (result.reason === "throttled") {
    return jsonError(
      429,
      "rate_limited",
      "Too many code requests. Please wait a moment and try again.",
      undefined,
      retryAfterHeader(result.retryAfterMs),
    );
  }

  // email_failed — the code was still issued and stays valid; the user can retry.
  return jsonError(
    502,
    "email_failed",
    "We couldn't send your code right now. Please try again.",
  );
}
