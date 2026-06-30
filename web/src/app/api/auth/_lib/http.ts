/**
 * Shared HTTP helpers for the `/api/auth/*` route adapters
 * (account-creation design.md § API Design, Phase 4 / p4).
 *
 * The four auth routes are THIN adapters over `auth-service` / `sessions`
 * (§ Component Design "Auth API routes … thin HTTP adapters"). Their only job is
 * to: parse the request, derive the source IP for the OTP throttle, hand off to
 * the service, and serialize the returned discriminated-union Result into a
 * plain JSON response. None of these helpers — and none of the routes — throw
 * for in-domain conditions; every documented failure rides a JSON body with a
 * status (mirrors the chat route's `jsonError`, src/app/api/chat/route.ts).
 *
 * This file lives in a Next.js PRIVATE folder (`_lib`, underscore-prefixed) so
 * it is never treated as a routable segment.
 */

/** Serialize a JSON body with an explicit status + optional extra headers. */
export function json(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Error envelope identical to the chat route's `jsonError` ({ code, message }),
 * with an optional `extra` object merged in (e.g. `attemptsRemaining`) and
 * optional extra headers (e.g. `Retry-After`).
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  return json(status, { code, message, ...extra }, extraHeaders);
}

/**
 * Build a `Retry-After` header (whole seconds, floored at 1) from a
 * `retryAfterMs` — mirrors the chat route's 429 path (`Math.ceil(ms / 1000)`).
 */
export function retryAfterHeader(retryAfterMs: number): Record<string, string> {
  return { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
}

/**
 * Derive the client IP used as the OTP-throttle key (design.md § API Design):
 * the first hop of `X-Forwarded-For` under the documented single-reverse-proxy
 * trust model, then `X-Real-IP`, else `"unknown"`. This value keys an
 * abuse-bounding throttle ONLY — it is never trusted for authorization.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

/**
 * Read + shape-check a JSON request body. Returns the parsed object, or `null`
 * for malformed JSON or a non-object body (the caller maps `null` to a 400
 * `invalid_request`). Field-level validation is the caller's.
 */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  return raw as Record<string, unknown>;
}
