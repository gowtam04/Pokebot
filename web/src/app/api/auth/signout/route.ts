/**
 * `POST /api/auth/signout` — end the current device's session (account-creation
 * design.md § API Design "POST /api/auth/signout", Phase 4 / p4; AUTH-US-5,
 * AC-5.1, AC-5.2).
 *
 * Thin adapter over `sessions`. IDEMPOTENT (AC-5.1): it reads the cookie token,
 * revokes the matching `auth_session` row, and clears the cookie — but a missing
 * or already-invalid cookie is NOT an error, it still returns `200 { ok: true }`
 * (`revokeSessionToken(undefined)` is a documented no-op). Only the current
 * device's row is removed, so other devices stay signed in (AC-5.2 / BR-A7).
 */

import { json } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  // Dynamic import defers the auth chain's env evaluation past module load so
  // `next build` never evaluates @/env (matches the chat route pattern).
  const { clearSessionCookie, readSessionCookie, revokeSessionToken } =
    await import("@/server/auth/sessions");
  const token = await readSessionCookie();
  // Revoke the server-side row (no-op when token is undefined) then drop the
  // cookie so the browser reverts to the guest experience.
  await revokeSessionToken(token);
  await clearSessionCookie();
  return json(200, { ok: true });
}
