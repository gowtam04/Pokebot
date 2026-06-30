/**
 * `POST /api/auth/verify` — verify a code, then create-or-login + set the session
 * cookie (account-creation design.md § API Design "POST /api/auth/verify",
 * Phase 4 / p4; BR-A1, BR-A4, AC-2.3, AC-2.4, AC-2.5, AC-2.6).
 *
 * Thin adapter over `auth-service.verifyCode`. On success it is the SINGLE place
 * the auth surface issues a `Set-Cookie` (the httpOnly 30-day session cookie via
 * `setSessionCookie`); the create-vs-login decision is the service's (`created`
 * flag, AC-2.3/AC-2.4). The conversation `session_id` is untouched, so the
 * on-screen thread survives sign-in (BR-A10/BR-A11). Result → HTTP:
 *
 *   - { ok: true, account, token, expiresAt, created }
 *                                  → 200 { ok: true, email, created } + Set-Cookie
 *   - invalid_code (attemptsRemaining) → 400 invalid_code + attemptsRemaining (AC-2.5)
 *   - invalid_or_expired               → 400 invalid_or_expired             (AC-2.6)
 *   - too_many_attempts                → 400 too_many_attempts              (BR-A4)
 *   - throttled (retryAfterMs)         → 429 rate_limited + Retry-After
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
  if (
    body === null ||
    typeof body.email !== "string" ||
    typeof body.code !== "string"
  ) {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be { email: string, code: string }.",
    );
  }

  // Dynamic imports defer the auth chain's env evaluation past module load so
  // `next build` never evaluates @/env (matches the chat route pattern).
  const { verifyCode } = await import("@/server/auth/auth-service");
  const result = await verifyCode(body.email, body.code, clientIp(req));

  if (result.ok) {
    const { setSessionCookie } = await import("@/server/auth/sessions");
    // The one Set-Cookie on the auth surface: httpOnly, SameSite=Lax,
    // Secure-in-prod, 30-day window (BR-A7). `created` tells the client whether
    // this was a first-time signup (AC-2.3) or a returning login (AC-2.4).
    await setSessionCookie(result.token, result.expiresAt);
    return json(200, {
      ok: true,
      email: result.account.email,
      created: result.created,
    });
  }

  if (result.reason === "invalid_code") {
    // Wrong code: tell the user how many attempts remain before lockout (AC-2.5).
    return jsonError(
      400,
      "invalid_code",
      "That code is incorrect. Please try again.",
      { attemptsRemaining: result.attemptsRemaining },
    );
  }

  if (result.reason === "invalid_or_expired") {
    // Missing / expired / already-used — request a fresh one (AC-2.6).
    return jsonError(
      400,
      "invalid_or_expired",
      "That code is no longer valid. Please request a new one.",
    );
  }

  if (result.reason === "too_many_attempts") {
    // Code locked out after the attempt limit (BR-A4): a new code is required.
    return jsonError(
      400,
      "too_many_attempts",
      "Too many incorrect attempts. Please request a new code.",
    );
  }

  // throttled — per-IP verify cap exceeded.
  return jsonError(
    429,
    "rate_limited",
    "Too many attempts. Please wait a moment and try again.",
    undefined,
    retryAfterHeader(result.retryAfterMs),
  );
}
