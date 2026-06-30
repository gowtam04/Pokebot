/**
 * Request-scoped current-account resolution for account-creation email-OTP auth
 * (account-creation design.md § Interface Definitions →
 * `src/server/auth/current-user.ts`, Phase 3).
 *
 * The single seam the rest of the server uses to ask "who is this request?".
 * Every authenticated route (chat's tiered rate-limit key, `/api/auth/me`,
 * conversations, teams, account deletion) resolves identity here, so extending
 * THIS one function lights up the whole authed surface. It is the composition of
 * the session primitives: read the cookie, then resolve its token to an
 * `Account`; if there is no valid cookie session, fall back to a bearer token.
 *
 * Returns `null` for any guest/unauthenticated state — no credential, an
 * expired/unknown token, or an orphaned session — never throwing in-domain
 * (BR-A11: guests are first-class, not an error path).
 */

import "server-only";

import type { Account } from "@/data/repos/accounts-repo";
import {
  readBearerToken,
  readSessionCookie,
  resolveSessionToken,
} from "@/server/auth/sessions";

/**
 * The signed-in `Account` for the current request, or `null` for a guest.
 *
 * Thin by design: `readSessionCookie()` pulls the opaque token from the
 * `oak_session` cookie and `resolveSessionToken()` maps it to its account
 * (treating absent/expired/unknown tokens as `null`).
 *
 * The COOKIE PATH IS TRIED FIRST AND IS UNCHANGED, so web behavior is
 * byte-identical. Only when it yields no account does the resolver consult an
 * `Authorization: Bearer <token>` header (iphone-app ADR-2) — the same opaque
 * token, hashed and looked up identically. The native client (which sends no
 * cookie) is thereby authenticated through the exact same session machinery.
 */
export async function getCurrentAccount(): Promise<Account | null> {
  const cookieAccount = await resolveSessionToken(await readSessionCookie());
  if (cookieAccount !== null) {
    return cookieAccount;
  }
  // Pure fallback: no valid cookie session ⇒ try the bearer credential.
  return resolveSessionToken(await readBearerToken());
}
