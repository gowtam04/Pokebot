/**
 * Keyed rate limiter and input-length cap (design.md § Component Design,
 * integration.md § Guardrails Outside the Agent, Phase 6; account-creation
 * design.md § API Design "POST /api/chat (modified)", Phase 5 — tiered limits).
 *
 * Two independent checks are composed here:
 *  1. Input-length cap  — reject messages that exceed maxInputLength characters.
 *  2. Per-key fixed-window counter — reject requests that exceed
 *     maxRequestsPerWindow within the current windowMs window.
 *
 * The state lives in-process (a Map keyed by an opaque string).  Callers choose
 * the key namespace: the chat route keys signed-in users by `acct:<id>` and
 * guests by `ip:<addr>` so the two tiers count independently (BR-A8 — guest
 * sessions cannot pool into the account allowance).  A server restart resets all
 * counters — intentional for a single-instance hobby app.  Entries are evicted
 * lazily whenever their window resets, keeping the map small.
 *
 * There is no I/O and no async — call checkRateLimit synchronously at the top
 * of the request handler before any awaits.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum number of characters allowed in the user message. */
  maxInputLength: number;
  /** Maximum number of requests allowed from one session per window. */
  maxRequestsPerWindow: number;
  /** Length of the fixed time window in milliseconds. */
  windowMs: number;
}

/**
 * Default limits (conservative but generous for a single user).
 *  - 2 000-character messages cover any realistic Pokémon question and block
 *    accidental/adversarial prompt-injection spam.
 *  - 20 requests / 60 s bounds runaway loops or UI bugs that hammer the API.
 */
export const DEFAULT_CONFIG: RateLimitConfig = {
  maxInputLength: 2_000,
  maxRequestsPerWindow: 20,
  windowMs: 60_000,
};

/**
 * Tiered chat configs (account-creation design.md § API Design, § Interface
 * Definitions; BR-A8 / AUTH-US-7 / AC-7.1).  Both keep the 2 000-char input cap
 * (unchanged from DEFAULT_CONFIG — BR-A11).  The request allowances differ:
 *  - GUEST_CONFIG     — 20 / 60 s (today's guest value; AC-1.3).
 *  - SIGNED_IN_CONFIG — 60 / 60 s (the more generous signed-in tier; AC-7.1).
 *
 * The chat route picks one of these (and the matching key namespace) per request
 * from the resolved auth state; the two pools never share a key, so guests can't
 * exceed the account tier by spawning sessions (AC-7.3).
 */
export const GUEST_CONFIG: RateLimitConfig = {
  maxInputLength: 2_000,
  maxRequestsPerWindow: 20,
  windowMs: 60_000,
};

export const SIGNED_IN_CONFIG: RateLimitConfig = {
  maxInputLength: 2_000,
  maxRequestsPerWindow: 60,
  windowMs: 60_000,
};

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by checkRateLimit.  The caller maps the
 * `allowed: false` branches to the appropriate HTTP response / error event
 * (integration.md § Guardrails).
 */
export type RateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "input_too_long";
      maxLength: number;
      actualLength: number;
    }
  | {
      allowed: false;
      reason: "rate_limited";
      /** Milliseconds until the current window expires. */
      retryAfterMs: number;
    };

// ---------------------------------------------------------------------------
// In-process window state
// ---------------------------------------------------------------------------

interface WindowState {
  count: number;
  windowStart: number;
}

/** Module-level store.  Use _resetStoreForTests() to clear between test cases. */
const store = new Map<string, WindowState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the request keyed by `key` carrying `message` should be
 * allowed through.
 *
 * Checks are applied in order: input-length first (cheap string check), then
 * the rate-window counter.
 *
 * @param key        The rate-limit bucket key.  The chat route passes an
 *                   auth-derived namespace (`acct:<id>` for signed-in users,
 *                   `ip:<addr>` for guests) so the tiers count independently.
 * @param message    The raw user message string from the POST body.
 * @param config     Optional overrides; defaults to DEFAULT_CONFIG.
 * @param now        Injectable clock (epoch ms) for deterministic testing.
 *                   Defaults to Date.now() in production.
 */
export function checkRateLimit(
  key: string,
  message: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): RateLimitResult {
  // ------------------------------------------------------------------
  // 1. Input-length cap
  // ------------------------------------------------------------------
  if (message.length > config.maxInputLength) {
    return {
      allowed: false,
      reason: "input_too_long",
      maxLength: config.maxInputLength,
      actualLength: message.length,
    };
  }

  // ------------------------------------------------------------------
  // 2. Per-key fixed-window counter
  // ------------------------------------------------------------------
  const state = store.get(key);

  // No prior state, or the window has expired → fresh window.
  if (state === undefined || now - state.windowStart >= config.windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  // Window still open but limit already hit.
  if (state.count >= config.maxRequestsPerWindow) {
    const retryAfterMs = config.windowMs - (now - state.windowStart);
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterMs: Math.max(0, retryAfterMs),
    };
  }

  // Within window and under the cap — increment and allow.
  state.count += 1;
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Test helper (not part of the public surface — test files only)
// ---------------------------------------------------------------------------

/**
 * Wipe all per-session window state.  Call this in `beforeEach` / `afterEach`
 * to isolate test cases from each other.
 *
 * @internal
 */
export function _resetStoreForTests(): void {
  store.clear();
}
