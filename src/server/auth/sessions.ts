/**
 * Opaque cookie-session lifecycle for account-creation email-OTP auth
 * (account-creation design.md § Interface Definitions → `src/server/auth/sessions.ts`,
 * Phase 3; AD-3, BR-A2, BR-A7).
 *
 * A session is a 256-bit random token handed to the browser in an httpOnly
 * cookie. The token is NEVER stored server-side — only its SHA-256 hash lands in
 * `auth_session.token_hash` (AD-3 / BR-A2). On each request the cookie's token is
 * re-hashed and looked up; a 30-day fixed window (no sliding expiry in v1) bounds
 * its life (BR-A7). Sign-out deletes the row (idempotent).
 *
 * Layering:
 *   - All DB writes/reads go through `accounts-repo` (the sole auth Postgres
 *     reader) — issue/resolve/revoke wrap `insertSession` /
 *     `findSessionByTokenHash` / `deleteSessionByTokenHash`.
 *   - EXCEPTION: resolving a session to a full `Account` needs an account-by-id
 *     read, which the pinned `accounts-repo` interface does not expose
 *     (design.md § Interface Definitions lists only `findAccountByEmail`). The
 *     single `account`-by-id lookup here therefore reads the memoized
 *     `@/data/db` singleton directly — exactly the pattern resolve-index.ts and
 *     accounts-repo.ts use — rather than inventing a repo function outside this
 *     phase's owned surface. It is the only direct DB touch in this file.
 *   - Cookie I/O uses Next's async `cookies()` (`next/headers`); these helpers are
 *     `Promise`-returning so they compose in route handlers.
 *
 * Error style: in-domain misses return `null` / are no-ops (never throw); only a
 * genuine DB/transport fault propagates (mirrors the repo).
 */

import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

import { db } from "@/data/db";
import {
  type Account,
  type AuthSession,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  insertSession,
} from "@/data/repos/accounts-repo";
import { account } from "@/data/schema";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie carrying the opaque session token (httpOnly; § API Design). */
export const SESSION_COOKIE = "oak_session";

/** Session lifetime: 30 days, fixed window from issuance (BR-A7, AD-3). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/** Token entropy: 256 bits (32 bytes) of CSPRNG output (AD-3). */
const TOKEN_BYTES = 32;

/** `Max-Age` for the cookie, in seconds (cookies use seconds, not ms). */
const COOKIE_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 (hex) of an opaque session token — the at-rest representation stored
 * in `auth_session.token_hash`. A plain digest is sufficient here (unlike the
 * HMAC used for the low-entropy 6-digit OTP): a 256-bit random token is not
 * brute-forceable, so no server secret is needed (AD-3). The raw token never
 * leaves this module except as the cookie value.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Session create / resolve / revoke
// ---------------------------------------------------------------------------

/**
 * Issue a new device session for `accountId` (called after a successful verify).
 *
 * Mints a fresh 256-bit token, persists ONLY its SHA-256 hash, and returns the
 * RAW token — this is the single place the token exists in plaintext, so the
 * caller (the verify route) can drop it straight into `Set-Cookie`. The window
 * is fixed at {@link SESSION_TTL_MS} from now (BR-A7).
 */
export async function issueSession(
  accountId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  const row: AuthSession = {
    id: randomUUID(),
    tokenHash: hashToken(token),
    accountId,
    createdAt: now,
    expiresAt,
  };
  await insertSession(row);

  return { token, expiresAt };
}

/**
 * Resolve a cookie token to its owning `Account`, or `null` when the token is
 * absent, unknown, expired, or orphaned (§ Interface Definitions).
 *
 * An EXPIRED row is treated as absent (BR-A7 / AC-4.2) and best-effort deleted
 * (lazy cleanup — no cron/worker); the delete is swallowed so a housekeeping
 * failure never blocks the (still-unauthenticated) result. No sliding expiry: a
 * live token does not extend its window.
 */
export async function resolveSessionToken(
  token: string | undefined,
): Promise<Account | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const session = await findSessionByTokenHash(tokenHash);
  if (session === null) {
    return null;
  }

  // Expiry is applied here (the repo deliberately does not): an at-or-past
  // expiry reads as absent and the dead row is best-effort removed.
  if (session.expiresAt <= Date.now()) {
    await deleteSessionByTokenHash(tokenHash).catch(() => {});
    return null;
  }

  return findAccountById(session.accountId);
}

/**
 * Revoke a session by its cookie token (sign-out, AC-5.1). Idempotent: a missing
 * or already-revoked token is a no-op, never an error — only the current
 * device's row is removed, so other devices stay signed in (AC-5.2 / BR-A7).
 */
export async function revokeSessionToken(
  token: string | undefined,
): Promise<void> {
  if (!token) {
    return;
  }
  await deleteSessionByTokenHash(hashToken(token));
}

/**
 * Account-by-id read for {@link resolveSessionToken}. Reads the `@/data/db`
 * singleton directly (see the module header) because the pinned accounts-repo
 * exposes no by-id lookup. Returns `null` if the account row has vanished
 * (orphaned session) so resolution degrades cleanly to "guest".
 */
async function findAccountById(id: string): Promise<Account | null> {
  const rows = await db
    .select({
      id: account.id,
      email: account.email,
      createdAt: account.created_at,
    })
    .from(account)
    .where(eq(account.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cookie helpers (next/headers cookies())
// ---------------------------------------------------------------------------

/**
 * Write the session cookie. `httpOnly` (no JS access), `SameSite=Lax` (sent on
 * top-level navigations, blocks CSRF on cross-site POSTs), `Secure` ONLY in
 * production (so http://localhost dev still works), `Path=/`, and a 30-day
 * `Max-Age` (BR-A7; § API Design). `expires` mirrors the server-side row so the
 * browser drops the cookie in lockstep with the session.
 */
export async function setSessionCookie(
  token: string,
  expiresAt: number,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
    expires: new Date(expiresAt),
  });
}

/** Clear the session cookie (sign-out / expired resolve). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Read the raw session token from the request cookie, or `undefined`. */
export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
