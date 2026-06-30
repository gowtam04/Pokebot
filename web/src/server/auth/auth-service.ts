/**
 * Auth orchestration for account-creation email-OTP (account-creation design.md
 * § Interface Definitions → `src/server/auth/auth-service.ts`, Phase 3).
 *
 * Owns the two flows the routes adapt over HTTP:
 *
 *   - `requestCode(email, ip)` — the NON-ENUMERATING request side (BR-A1). It
 *     normalizes + syntactically validates the email, applies the in-memory
 *     request throttle (cooldown + per-email/per-IP caps, BR-A5/BR-A6), upserts
 *     a fresh HMAC-hashed code (superseding any prior, BR-A5), and emails it.
 *     CRUCIALLY it never looks up whether the account exists, so its `{ ok: true }`
 *     success is byte-identical for registered and unregistered emails — the
 *     route maps no branch to "account exists" (BR-A1 / AC-2.2).
 *
 *   - `verifyCode(email, code, ip)` — the verify side that decides create-vs-login.
 *     Per-IP verify throttle → load the code → reject missing/expired/consumed
 *     (AC-2.6) and locked-out (BR-A4) codes → constant-time HMAC compare,
 *     incrementing attempts on a miss (AC-2.5) → on a match: consume the code
 *     (single-use, BR-A3), FIND-OR-CREATE the account by email (BR-A1 — exactly
 *     one account per email; unknown → create + `created:true`, known → reuse +
 *     `created:false`), and issue a session.
 *
 * Error style: discriminated-union Results, never thrown in-domain (mirrors
 * RateLimitResult). The only caught throw is the email transport's delivery
 * fault, mapped to `email_failed` (the user can retry — not enumeration). A
 * genuine DB fault still propagates.
 *
 * The plaintext code is never returned, stored, or logged here (the HMAC hash is
 * the only at-rest form; the dev/test console transport logs it, not this layer).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import {
  type Account,
  consumeOtpCode,
  createAccount,
  findAccountByEmail,
  getOtpCode,
  incrementOtpAttempts,
  upsertOtpCode,
} from "@/data/repos/accounts-repo";
import { getEmailTransport } from "@/server/auth/email/transport";
import {
  generateCode,
  hashCode,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  timingSafeEqualHex,
} from "@/server/auth/otp";
import {
  checkRequestThrottle,
  checkVerifyThrottle,
} from "@/server/auth/otp-throttle";
import { issueSession } from "@/server/auth/sessions";
import { logger } from "@/server/logger";

// ---------------------------------------------------------------------------
// Result shapes (§ Interface Definitions — exact discriminants)
// ---------------------------------------------------------------------------

export type RequestCodeResult =
  | { ok: true }
  | { ok: false; reason: "invalid_email" }
  | { ok: false; reason: "throttled"; retryAfterMs: number }
  | { ok: false; reason: "email_failed" };

export type VerifyResult =
  | {
      ok: true;
      account: Account;
      token: string;
      expiresAt: number;
      created: boolean;
    }
  | { ok: false; reason: "invalid_or_expired" }
  | { ok: false; reason: "too_many_attempts" }
  | { ok: false; reason: "invalid_code"; attemptsRemaining: number }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

// ---------------------------------------------------------------------------
// Email normalization + syntactic validation
// ---------------------------------------------------------------------------

/**
 * Normalize an email to its canonical identity form: trim surrounding
 * whitespace and lowercase. The account UNIQUE index, the otp_code PK, and the
 * HMAC binding all key on THIS form (BR-A2), so normalization must happen once,
 * here, before any repo/crypto call.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Cheap syntactic check (AC-2.1) — a single `local@domain.tld` shape with no
 * spaces. Deliberately permissive: real proof of control comes from receiving
 * the code, so this only rejects obviously malformed input, not "deliverable"
 * addresses.
 */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// requestCode — non-enumerating issue + email (BR-A1, BR-A5, BR-A6)
// ---------------------------------------------------------------------------

/**
 * Issue (and email) a one-time code for `email`, requested from `ip`.
 *
 * Order is deliberate: validate → throttle → upsert → send. A refused throttle
 * never consumes work or sends mail; a fresh code is upserted BEFORE the send so
 * a slow/failed delivery still leaves a valid code the user can verify if it
 * arrives late (NFR: a delivery delay must not corrupt the flow). The success
 * shape carries NO account information, keeping the flow non-enumerating (BR-A1).
 */
export async function requestCode(
  email: string,
  ip: string,
): Promise<RequestCodeResult> {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ok: false, reason: "invalid_email" };
  }

  const throttle = checkRequestThrottle(normalized, ip);
  if (!throttle.allowed) {
    return { ok: false, reason: "throttled", retryAfterMs: throttle.retryAfterMs };
  }

  const code = generateCode();
  const now = Date.now();
  // Upsert by email PK supersedes any prior code and resets attempts/consumed
  // (BR-A5). Only the HMAC hash is persisted — never the plaintext.
  await upsertOtpCode({
    email: normalized,
    codeHash: hashCode(normalized, code),
    createdAt: now,
    expiresAt: now + OTP_TTL_MS,
  });

  try {
    await getEmailTransport().sendOtpEmail(normalized, code);
  } catch (err) {
    // A genuine delivery fault — surfaced to the user as retryable, NOT as an
    // enumeration signal. The code stays valid until expiry. (No code logged.)
    logger.warn({ event: "otp_email_failed", err }, "OTP email delivery failed");
    return { ok: false, reason: "email_failed" };
  }

  logger.info({ event: "otp_requested" }, "OTP code requested");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// verifyCode — lockout/expiry/single-use → create-or-login → session
// ---------------------------------------------------------------------------

/**
 * Verify a submitted `code` for `email` (attempt from `ip`) and, on success,
 * sign the user in — creating the account on first verify (BR-A1).
 *
 * Branch order matches § API Design:
 *   1. per-IP verify throttle (bounds online brute force across codes);
 *   2. missing / expired / consumed code → `invalid_or_expired` (AC-2.6);
 *   3. attempts already at the lockout threshold → `too_many_attempts` (BR-A4)
 *      — this gate sits BEFORE the compare, so even the CORRECT code fails once
 *      a code is locked out (the user must request a new one);
 *   4. HMAC mismatch → increment attempts, `invalid_code` + remaining (AC-2.5);
 *   5. match → consume (single-use, BR-A3), find-or-create the account, issue a
 *      session, return the raw token for the route to set as a cookie.
 */
export async function verifyCode(
  email: string,
  code: string,
  ip: string,
): Promise<VerifyResult> {
  const normalized = normalizeEmail(email);

  const throttle = checkVerifyThrottle(ip);
  if (!throttle.allowed) {
    return { ok: false, reason: "throttled", retryAfterMs: throttle.retryAfterMs };
  }

  const row = await getOtpCode(normalized);
  const now = Date.now();

  // (2) missing / expired / consumed — all read to the user as "no longer valid,
  // request a new one" (AC-2.6). Expiry boundary is inclusive (>= now is dead).
  if (
    row === null ||
    row.expiresAt <= now ||
    row.consumedAt !== null
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  // (3) locked out — checked before the compare so a correct code post-lockout
  // still fails (BR-A4).
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  // (4) constant-time compare of the submitted code's HMAC against the stored
  // hash. A miss costs one attempt; once it reaches the threshold the NEXT call
  // hits gate (3).
  if (!timingSafeEqualHex(hashCode(normalized, code), row.codeHash)) {
    const attempts = await incrementOtpAttempts(normalized);
    return {
      ok: false,
      reason: "invalid_code",
      attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
    };
  }

  // (5) success: consume first (single-use, BR-A3), then resolve the account.
  await consumeOtpCode(normalized, now);

  const existing = await findAccountByEmail(normalized);
  let account: Account;
  let created: boolean;
  if (existing !== null) {
    account = existing;
    created = false;
  } else {
    // find-then-create: the UNIQUE index is the backstop on a genuine race
    // (BR-A1 — exactly one account per email).
    account = await createAccount(normalized, randomUUID(), now);
    created = true;
  }

  const { token, expiresAt } = await issueSession(account.id);
  logger.info({ event: "otp_verified", created }, "OTP verified, session issued");
  return { ok: true, account, token, expiresAt, created };
}
