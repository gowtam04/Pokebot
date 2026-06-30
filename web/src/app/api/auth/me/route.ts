/**
 * `GET /api/auth/me` — report the current auth state (account-creation design.md
 * § API Design "GET /api/auth/me", Phase 4 / p4; AUTH-US-1, AC-1.2).
 *
 * Thin adapter over `current-user.getCurrentAccount`. Lets the (client-rendered)
 * page show "Sign in" vs the signed-in menu on mount. A guest — no cookie, or an
 * expired/unknown/orphaned token — is the first-class `{ signedIn: false }` case
 * (never an error, BR-A11), so this always returns 200.
 *
 *   - account resolved → 200 { signedIn: true, email }
 *   - null (guest)     → 200 { signedIn: false }
 */

import { json } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Dynamic import defers the auth chain's env evaluation to request time, so
  // `next build` page-data collection never evaluates @/env (the AUTH_SECRET
  // prod guard) — mirrors the chat route's deferred runtime import.
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  const account = await getCurrentAccount();
  if (account === null) {
    return json(200, { signedIn: false });
  }
  return json(200, { signedIn: true, email: account.email });
}
