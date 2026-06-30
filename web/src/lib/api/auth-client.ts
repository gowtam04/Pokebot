/**
 * auth-client — typed `fetch` helpers over the `/api/auth/*` routes
 * (account-creation design.md § Interface Definitions "src/lib/api/auth-client.ts",
 * Phase 6 / p6).
 *
 * These are the ONLY thing the auth UI talks to — `AuthDialog` / `AuthMenu`
 * never call `fetch` directly. Each helper normalizes the route's JSON contract
 * (the `{ code, message, … }` error envelope from `src/app/api/auth/_lib/http.ts`
 * and the `Retry-After` header) into the small shapes the components branch on:
 *
 *   - the route's error `code` field → `error` (a discriminant string)
 *   - the `Retry-After` header (whole seconds) → `retryAfterMs`
 *   - `attemptsRemaining` / `created` pass straight through from the body
 *
 * Helpers NEVER throw: a transport/network failure is folded into the same
 * result union as an HTTP error (`{ ok: false, status: 0, error: "network_error" }`)
 * so the dialog always has a branch to render. The session cookie is httpOnly +
 * SameSite=Lax and is sent automatically on these same-origin requests; the
 * client never sees it (BR-A2 — raw token never client-visible).
 */

export interface RequestCodeResult {
  ok: boolean;
  status: number;
  error?: string;
  retryAfterMs?: number;
}

export interface VerifyCodeResult {
  ok: boolean;
  status: number;
  created?: boolean;
  error?: string;
  attemptsRemaining?: number;
}

export interface MeResult {
  signedIn: boolean;
  email?: string;
}

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** Best-effort parse of a JSON body; a non-JSON/empty body yields `{}`. */
async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json();
    if (data !== null && typeof data === "object") {
      return data as Record<string, unknown>;
    }
  } catch {
    /* non-JSON or empty body — treat as no fields */
  }
  return {};
}

/** Convert the route's `Retry-After` header (whole seconds) into ms, if present. */
function retryAfterMsFrom(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, seconds) * 1000;
}

/**
 * `POST /api/auth/request-code` — issue + email a one-time code. The response is
 * deliberately NON-ENUMERATING (BR-A1 / AC-2.2): a registered and an unregistered
 * email both come back `{ ok: true }`, so this helper exposes no "account exists"
 * signal. Failures map: 400 `invalid_email`/`invalid_request`, 429 `rate_limited`
 * (+ `retryAfterMs`), 502 `email_failed`.
 */
export async function requestCode(email: string): Promise<RequestCodeResult> {
  try {
    const res = await fetch("/api/auth/request-code", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
    const body = await readJsonBody(res);
    return {
      ok: res.ok,
      status: res.status,
      error: typeof body.code === "string" ? body.code : undefined,
      retryAfterMs: retryAfterMsFrom(res),
    };
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
}

/**
 * `POST /api/auth/verify` — verify a code and (server-side) create-or-login. On
 * success the route sets the session cookie and returns `{ ok, email, created }`;
 * `created` distinguishes first-time signup (AC-2.3) from a returning login
 * (AC-2.4). Failures map: 400 `invalid_code` (+ `attemptsRemaining`, AC-2.5),
 * 400 `invalid_or_expired` (AC-2.6), 400 `too_many_attempts` (BR-A4), 429
 * `rate_limited` (+ `retryAfterMs`).
 */
export async function verifyCode(
  email: string,
  code: string,
): Promise<VerifyCodeResult> {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ email, code }),
    });
    const body = await readJsonBody(res);
    return {
      ok: res.ok,
      status: res.status,
      created: typeof body.created === "boolean" ? body.created : undefined,
      error: typeof body.code === "string" ? body.code : undefined,
      attemptsRemaining:
        typeof body.attemptsRemaining === "number"
          ? body.attemptsRemaining
          : undefined,
    };
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
}

/**
 * `POST /api/auth/signout` — end the current device's session (AUTH-US-5). The
 * route is idempotent and always 200s; this helper is best-effort (a network
 * failure is swallowed) because the UI reverts to the guest experience either
 * way — the caller flips local auth state after it resolves.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/signout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    /* best-effort sign-out — UI still reverts to guest */
  }
}

/**
 * `GET /api/auth/me` — resolve the current auth state on mount so the page can
 * render guest vs signed-in (AC-1.2). A guest, an unknown/expired cookie, or any
 * transport fault all resolve to `{ signedIn: false }` (BR-A11 — guests are
 * first-class, never an error path).
 */
export async function fetchMe(): Promise<MeResult> {
  try {
    const res = await fetch("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
    });
    const body = await readJsonBody(res);
    if (body.signedIn === true && typeof body.email === "string") {
      return { signedIn: true, email: body.email };
    }
    return { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}
