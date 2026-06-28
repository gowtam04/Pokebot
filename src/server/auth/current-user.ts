/**
 * Request-scoped current-account resolution for account-creation email-OTP auth
 * (account-creation design.md § Interface Definitions →
 * `src/server/auth/current-user.ts`, Phase 3).
 *
 * The single seam the rest of the server uses to ask "who is this request?".
 * Both the chat route (tiered rate-limit key — guest vs account) and the
 * `/api/auth/me` route call this. It is the composition of the two session
 * primitives: read the cookie, then resolve its token to an `Account`.
 *
 * Returns `null` for any guest/unauthenticated state — no cookie, an
 * expired/unknown token, or an orphaned session — never throwing in-domain
 * (BR-A11: guests are first-class, not an error path).
 */

import "server-only";

import type { Account } from "@/data/repos/accounts-repo";
import { readSessionCookie, resolveSessionToken } from "@/server/auth/sessions";

/**
 * The signed-in `Account` for the current request, or `null` for a guest.
 *
 * Thin by design: `readSessionCookie()` pulls the opaque token from the
 * `oak_session` cookie and `resolveSessionToken()` maps it to its account
 * (treating absent/expired/unknown tokens as `null`).
 */
export async function getCurrentAccount(): Promise<Account | null> {
  const token = await readSessionCookie();
  return resolveSessionToken(token);
}
