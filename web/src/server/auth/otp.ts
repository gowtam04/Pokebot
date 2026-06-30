/**
 * One-time-code crypto helpers for account-creation email-OTP auth
 * (account-creation design.md § Interface Definitions → `src/server/auth/otp.ts`,
 * Phase 3; BR-A3, BR-A4, AD-4).
 *
 * Pure, synchronous helpers — no I/O, no DB. They cover three concerns:
 *
 *  1. `generateCode()` — a fresh 6-digit numeric code (BR-A3). Uses
 *     `crypto.randomInt` (CSPRNG, rejection-sampled internally) over the full
 *     `[0, 1_000_000)` range and zero-pads, so every value `000000`…`999999` is
 *     equiprobable and the string is always exactly six characters.
 *
 *  2. `hashCode(email, code)` — the at-rest representation of a code
 *     (`otp_code.code_hash`). It is an **HMAC-SHA256 keyed by `AUTH_SECRET`**,
 *     NOT a plain SHA-256: a 6-digit code has only 10⁶ values, so a bare digest
 *     in a DB leak is trivially reversible by precomputation; the server secret
 *     defeats that (AD-4). The plaintext code is never stored or logged.
 *
 *  3. `timingSafeEqualHex(a, b)` — a constant-time comparison of two hex digests
 *     that is length-guarded so it returns `false` (never throws) when the
 *     operands differ in length. Used to compare a submitted code's HMAC against
 *     the stored hash without leaking match progress via timing.
 */

import { createHmac, timingSafeEqual, randomInt } from "node:crypto";

import { env } from "@/env";

/** Code lifetime: ~10 minutes from issuance (BR-A3). */
export const OTP_TTL_MS = 10 * 60_000;

/** Wrong-attempt lockout threshold for a single code (BR-A4). */
export const OTP_MAX_ATTEMPTS = 5;

/** Number of decimal digits in a code; the only place "6" is defined. */
const CODE_DIGITS = 6;

/** Exclusive upper bound for the code value (10 ** CODE_DIGITS). */
const CODE_RANGE = 1_000_000;

/**
 * Generate a fresh single-use code (BR-A3).
 *
 * Returns a string of exactly {@link CODE_DIGITS} decimal digits, left-padded
 * with zeros (e.g. `"000042"`). `crypto.randomInt(0, CODE_RANGE)` draws a
 * cryptographically-secure, uniformly-distributed integer in `[0, 999999]`.
 */
export function generateCode(): string {
  return String(randomInt(0, CODE_RANGE)).padStart(CODE_DIGITS, "0");
}

/**
 * HMAC-SHA256 of `${email}:${code}` keyed by `AUTH_SECRET`, hex-encoded (AD-4).
 *
 * This is deliberately an HMAC and not a plain digest — see the module header.
 * `email` is assumed already normalized by the caller (`auth-service`); the
 * binding of email into the MAC means a stolen hash for one address cannot be
 * replayed against another.
 */
export function hashCode(email: string, code: string): string {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(`${email}:${code}`)
    .digest("hex");
}

/**
 * Constant-time equality for two hex-encoded digests.
 *
 * `crypto.timingSafeEqual` throws on buffers of differing length, which would
 * both crash the caller and leak length via the exception. We instead guard the
 * lengths up front and return `false` — first on the raw string length (the
 * common, fast path), then on the decoded byte length (defends against
 * odd-length / non-hex input where `Buffer.from(_, "hex")` silently truncates).
 * Only equal-length buffers reach `timingSafeEqual`.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
