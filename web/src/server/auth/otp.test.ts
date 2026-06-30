import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { env } from "@/env";
import {
  generateCode,
  hashCode,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  timingSafeEqualHex,
} from "@/server/auth/otp";

// ---------------------------------------------------------------------------
// Constants (BR-A3, BR-A4)
// ---------------------------------------------------------------------------

describe("OTP constants", () => {
  it("expires codes ~10 minutes after issuance (BR-A3)", () => {
    expect(OTP_TTL_MS).toBe(10 * 60_000);
  });

  it("locks out after 5 wrong attempts (BR-A4)", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// generateCode — 6-digit numeric, zero-padded, in range (BR-A3)
// ---------------------------------------------------------------------------

describe("generateCode (BR-A3)", () => {
  it("always returns exactly six decimal digits", () => {
    for (let i = 0; i < 5_000; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(code).toHaveLength(6);
    }
  });

  it("stays within the [0, 999999] range", () => {
    for (let i = 0; i < 5_000; i++) {
      const value = Number(generateCode());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(999_999);
    }
  });

  it("zero-pads small values to six characters", () => {
    // Over many draws we WILL hit values below 100000 (each ~10% likely); every
    // such value must still be length 6 — i.e. left-padded with zeros rather
    // than emitted as a short string. We assert padding was actually exercised.
    let observedPadded = false;
    for (let i = 0; i < 20_000; i++) {
      const code = generateCode();
      expect(code).toHaveLength(6);
      if (Number(code) < 100_000) {
        observedPadded = true;
        // A padded code's leading char(s) are '0' while its numeric value is
        // smaller than its digit count would otherwise imply.
        expect(code.startsWith("0")).toBe(true);
      }
    }
    expect(observedPadded).toBe(true);
  });

  it("produces varied codes (not a constant)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(generateCode());
    }
    // 200 CSPRNG draws over 10^6 values are overwhelmingly distinct.
    expect(seen.size).toBeGreaterThan(150);
  });
});

// ---------------------------------------------------------------------------
// hashCode — HMAC-SHA256 keyed by AUTH_SECRET, NOT a plain digest (AD-4)
// ---------------------------------------------------------------------------

describe("hashCode (AD-4)", () => {
  const email = "trainer@example.com";
  const code = "012345";

  it("is HMAC-SHA256(AUTH_SECRET, `${email}:${code}`) in hex", () => {
    const expected = createHmac("sha256", env.AUTH_SECRET)
      .update(`${email}:${code}`)
      .digest("hex");
    expect(hashCode(email, code)).toBe(expected);
  });

  it("is NOT a plain SHA-256 of the same payload (keyed, not bare)", () => {
    const plain = createHash("sha256")
      .update(`${email}:${code}`)
      .digest("hex");
    expect(hashCode(email, code)).not.toBe(plain);
  });

  it("depends on the secret (HMAC key changes the digest)", () => {
    const withOtherKey = createHmac("sha256", "some-other-secret")
      .update(`${email}:${code}`)
      .digest("hex");
    // If hashCode were unkeyed, it would equal a digest computed with any/no
    // key; binding to AUTH_SECRET makes it differ from a foreign-key HMAC.
    expect(hashCode(email, code)).not.toBe(withOtherKey);
  });

  it("emits a 64-char (32-byte) hex digest", () => {
    expect(hashCode(email, code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same (email, code)", () => {
    expect(hashCode(email, code)).toBe(hashCode(email, code));
  });

  it("binds the email — same code under a different email differs", () => {
    expect(hashCode("a@example.com", code)).not.toBe(
      hashCode("b@example.com", code),
    );
  });

  it("changes when the code changes", () => {
    expect(hashCode(email, "012345")).not.toBe(hashCode(email, "543210"));
  });
});

// ---------------------------------------------------------------------------
// timingSafeEqualHex — constant-time, length-guarded (false, never throws)
// ---------------------------------------------------------------------------

describe("timingSafeEqualHex", () => {
  const a = hashCode("trainer@example.com", "000111");
  const b = hashCode("trainer@example.com", "000111"); // equal value
  const c = hashCode("trainer@example.com", "999888"); // different value

  it("returns true for two equal hex digests", () => {
    expect(timingSafeEqualHex(a, b)).toBe(true);
  });

  it("returns false for two distinct equal-length hex digests", () => {
    expect(timingSafeEqualHex(a, c)).toBe(false);
  });

  it("returns false (does not throw) on a length mismatch", () => {
    const shorter = a.slice(0, 32); // half-length hex string
    // The key guarantee: a length mismatch is a clean `false`, never the throw
    // that bare crypto.timingSafeEqual raises on unequal buffer lengths.
    expect(() => timingSafeEqualHex(a, shorter)).not.toThrow();
    expect(timingSafeEqualHex(a, shorter)).toBe(false);
    expect(timingSafeEqualHex(shorter, a)).toBe(false);
  });

  it("returns false when one operand is empty", () => {
    expect(timingSafeEqualHex(a, "")).toBe(false);
    expect(timingSafeEqualHex("", a)).toBe(false);
  });

  it("does not throw on odd-length / non-hex equal-length input", () => {
    // Equal string length but not valid even-length hex — must still be safe.
    expect(() => timingSafeEqualHex("abc", "abd")).not.toThrow();
  });
});
