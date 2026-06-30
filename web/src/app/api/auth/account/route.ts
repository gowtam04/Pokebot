/**
 * `DELETE /api/auth/account` — permanently delete the signed-in account and ALL
 * of its data (iphone-app api-design.md "Change 1 — Account deletion"; ADR-2;
 * M-NFR-6, M-ACCT-US-6, M-BR-ACCT-6).
 *
 * Additive endpoint for the native client (and usable by web). Thin adapter:
 * resolve the caller through the single identity seam (`getCurrentAccount`,
 * which accepts the cookie OR an `Authorization: Bearer` token), cascade-delete
 * everything scoped to the account in one transaction (`deleteAccount`), then
 * clear the session cookie the SAME way sign-out does so a cookie-based web
 * session is invalidated alongside the deleted account.
 *
 *   - guest (no valid credential) → 401 unauthorized (nothing deleted)
 *   - signed in                   → 200 { ok: true } + cookie cleared
 *
 * After deletion the caller's token is orphaned (its `auth_session` row is gone),
 * so any subsequent authed call resolves to guest and 401s — the documented
 * post-deletion behavior.
 */

import { json, jsonError } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(): Promise<Response> {
  // Dynamic imports defer the auth chain's env evaluation past module load so
  // `next build` never evaluates @/env (matches the chat / signout route pattern).
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  const account = await getCurrentAccount();
  if (account === null) {
    // Account deletion requires an authenticated caller (BR-A11: guests have no
    // account to delete).
    return jsonError(401, "unauthorized", "You must be signed in.");
  }

  const { deleteAccount } = await import("@/data/repos/accounts-repo");
  await deleteAccount(account.id);

  // Parity with sign-out: drop the cookie so a cookie-based web session reverts
  // to guest immediately (the native client just discards its Keychain token).
  const { clearSessionCookie } = await import("@/server/auth/sessions");
  await clearSessionCookie();

  return json(200, { ok: true });
}
