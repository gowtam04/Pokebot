/**
 * In-memory request/verify throttle for account-creation email-OTP auth
 * (account-creation design.md § Interface Definitions →
 * `src/server/auth/otp-throttle.ts`, AD-5; BR-A5, BR-A6).
 *
 * This guards the *request* side of the OTP flow (abuse-bounding) — distinct
 * from the durable per-code lifecycle (expiry / single-use / 5-attempt lockout)
 * which lives on the `otp_code` row. Three independent gates compose here:
 *
 *  - **Resend cooldown (60s, per email)** — a fresh code may be requested for an
 *    email only once every 60 seconds (BR-A5). Boundary is exclusive: a request
 *    exactly 60_000ms after the previous one is allowed; 59_999ms is refused.
 *  - **Per-email hourly cap (5 / hour)** — at most 5 codes per email per rolling
 *    fixed window (BR-A6, anti email-bombing).
 *  - **Per-IP hourly cap (20 / hour)** — at most 20 code requests per source IP
 *    per fixed window (BR-A6, anti enumeration / distribution across emails).
 *
 * A separate **per-IP verify cap (20 / 10 min)** bounds online brute force of
 * codes across the IP.
 *
 * Like `src/server/rate-limit.ts`, state is a process-local `Map` of fixed
 * windows; a restart resets all counters (acceptable for a single-instance hobby
 * deploy — AD-5). `now` is injectable for deterministic tests, and
 * `_resetForTests()` wipes all state between cases. There is no I/O and no
 * async: call these synchronously at the top of the route handler.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum gap between successive code requests for one email (BR-A5). */
const COOLDOWN_MS = 60_000;

/** One-hour fixed window for the request caps. */
const HOUR_MS = 60 * 60_000;

/** Max code requests per email per {@link HOUR_MS} window (BR-A6). */
const EMAIL_HOURLY_CAP = 5;

/** Max code requests per source IP per {@link HOUR_MS} window (BR-A6). */
const IP_HOURLY_CAP = 20;

/** Fixed window for the per-IP verify cap. */
const VERIFY_WINDOW_MS = 10 * 60_000;

/** Max verify attempts per source IP per {@link VERIFY_WINDOW_MS} window. */
const IP_VERIFY_CAP = 20;

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

/**
 * Outcome of a throttle check. When `allowed` is false, `retryAfterMs` is the
 * (positive) wait until the blocking gate clears — surfaced to the client as a
 * `Retry-After`. When allowed, `retryAfterMs` is 0.
 */
export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number;
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

interface WindowState {
  count: number;
  windowStart: number;
}

/** email → timestamp of its most recent accepted request (cooldown gate). */
const emailLastRequest = new Map<string, number>();
/** email → hourly request counter. */
const emailHourly = new Map<string, WindowState>();
/** ip → hourly request counter. */
const ipHourly = new Map<string, WindowState>();
/** ip → verify-attempt counter. */
const ipVerify = new Map<string, WindowState>();

// ---------------------------------------------------------------------------
// Pure gate evaluators (non-mutating)
// ---------------------------------------------------------------------------

/**
 * Evaluate a fixed-window cap without mutating state. A missing or expired
 * window is a fresh window (allowed). Within an open window, `count >= cap` is
 * refused with the remaining time until the window resets.
 */
function evalWindow(
  state: WindowState | undefined,
  now: number,
  windowMs: number,
  cap: number,
): ThrottleResult {
  if (state === undefined || now - state.windowStart >= windowMs) {
    return { allowed: true, retryAfterMs: 0 };
  }
  if (state.count >= cap) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, windowMs - (now - state.windowStart)),
    };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Commit one accepted hit to a fixed-window counter (mirrors
 * `rate-limit.ts`): start a new window or increment the open one.
 */
function commitWindow(
  map: Map<string, WindowState>,
  key: string,
  now: number,
  windowMs: number,
): void {
  const state = map.get(key);
  if (state === undefined || now - state.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: now });
  } else {
    state.count += 1;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a code request for `email` from `ip` is allowed (BR-A5, BR-A6).
 *
 * Gates are evaluated in order — cooldown, then per-email hourly cap, then
 * per-IP hourly cap — and the first failure short-circuits with its
 * `retryAfterMs`. No counter is mutated unless **every** gate passes, so a
 * refused request never consumes quota.
 */
export function checkRequestThrottle(
  email: string,
  ip: string,
  now: number = Date.now(),
): ThrottleResult {
  // 1. Resend cooldown (per email). Exclusive boundary at COOLDOWN_MS.
  const lastAt = emailLastRequest.get(email);
  if (lastAt !== undefined) {
    const elapsed = now - lastAt;
    if (elapsed < COOLDOWN_MS) {
      return { allowed: false, retryAfterMs: COOLDOWN_MS - elapsed };
    }
  }

  // 2. Per-email hourly cap.
  const emailCap = evalWindow(
    emailHourly.get(email),
    now,
    HOUR_MS,
    EMAIL_HOURLY_CAP,
  );
  if (!emailCap.allowed) {
    return emailCap;
  }

  // 3. Per-IP hourly cap.
  const ipCap = evalWindow(ipHourly.get(ip), now, HOUR_MS, IP_HOURLY_CAP);
  if (!ipCap.allowed) {
    return ipCap;
  }

  // All gates clear → record the accepted request across all three counters.
  emailLastRequest.set(email, now);
  commitWindow(emailHourly, email, now, HOUR_MS);
  commitWindow(ipHourly, ip, now, HOUR_MS);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Check whether a verify attempt from `ip` is allowed (per-IP cap, 20 / 10 min).
 *
 * Bounds cross-code online brute force from one source. The counter is consumed
 * only when the attempt is allowed.
 */
export function checkVerifyThrottle(
  ip: string,
  now: number = Date.now(),
): ThrottleResult {
  const cap = evalWindow(ipVerify.get(ip), now, VERIFY_WINDOW_MS, IP_VERIFY_CAP);
  if (!cap.allowed) {
    return cap;
  }
  commitWindow(ipVerify, ip, now, VERIFY_WINDOW_MS);
  return { allowed: true, retryAfterMs: 0 };
}

// ---------------------------------------------------------------------------
// Test helper (not part of the public surface — test files only)
// ---------------------------------------------------------------------------

/**
 * Wipe all throttle state. Call in `beforeEach` / `afterEach` to isolate cases.
 *
 * @internal
 */
export function _resetForTests(): void {
  emailLastRequest.clear();
  emailHourly.clear();
  ipHourly.clear();
  ipVerify.clear();
}
