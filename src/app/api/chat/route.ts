/**
 * `POST /api/chat` — the SSE chat endpoint (design.md § API Design, § Component
 * Design "Web API"; agent-design/integration.md § Invocation Signature, § Error
 * Surface, § Guardrails Outside the Agent). Phase 6 / API assembly seam.
 *
 * Responsibilities (orchestration, NOT agent internals):
 *   1. Parse + validate the request body ({ session_id, message }).
 *   2. Apply the two orchestration guardrails BEFORE streaming: the input-length
 *      cap and the per-session rate limit (integration.md § Guardrails). These
 *      reject with a plain JSON HTTP error (413 / 429) — they are not in-domain
 *      answer conditions, and rejecting before the stream opens lets the client
 *      see a real HTTP status.
 *   3. Resolve the prior in-session history from the session store (trimming it
 *      to the context budget first), then drive `runPokebot` with hooks that
 *      stream `tool_activity` events as tools fire and `answer_start`/
 *      `answer_delta` events as the answer_markdown prose is generated.
 *   4. Emit EXACTLY ONE terminal `answer` event carrying the validated
 *      PokebotAnswer. Every in-domain failure (resolution_failed /
 *      clarification_needed / insufficient_data) rides this normal `answer`
 *      event — `runPokebot` never throws for those. ONLY a transport/API fault
 *      (an exception out of `runPokebot` / context assembly) emits an `error`
 *      event (integration.md § Error Surface, last two rows).
 *   5. On success, record the user + assistant turn pair in the session store so
 *      multi-turn refinement works (US-10). On a transport fault we append
 *      nothing, leaving the session clean for a retry.
 *
 * Streaming contract (RISK DIRECTIVE — SSE route): `runtime = "nodejs"` and
 * `dynamic = "force-dynamic"`; the `Response(stream)` is returned SYNCHRONOUSLY
 * (we never await the agent loop before returning) and events are emitted from
 * an async task inside `start()`; SSE headers are text/event-stream +
 * Cache-Control: no-cache, no-transform + X-Accel-Buffering: no; each frame is
 * `event: <name>\ndata: <single-line JSON>\n\n` via `formatSseEvent`.
 */

import { randomUUID } from "node:crypto";

import { createAgentContext } from "@/agent/context";
import {
  DEFAULT_MODEL_KEY,
  isModelKey,
  type ModelKey,
} from "@/agent/models";
import type {
  AgentMode,
  ChatMessage,
  OnAnswerDelta,
  OnAnswerStart,
  OnProgress,
} from "@/agent/types";
import type { Account } from "@/data/repos/accounts-repo";
import { formatForMode, modeForFormat, type Format } from "@/data/formats";
import { logger } from "@/server/logger";
import {
  checkRateLimit,
  GUEST_CONFIG,
  SIGNED_IN_CONFIG,
} from "@/server/rate-limit";
import {
  appendTurn,
  getHistory,
  trim,
  trimMessages,
} from "@/server/session-store";
import {
  formatSseEvent,
  type ChatRequestBody,
  type SseEventDataMap,
  type SseEventName,
} from "@/lib/sse-types";

// Node runtime (node-postgres + the Anthropic SDK need it) and never cached /
// statically optimized — this is a live streaming handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SSE response headers (RISK DIRECTIVE — SSE route)
// ---------------------------------------------------------------------------

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable proxy buffering (nginx etc.) so events flush immediately.
  "X-Accel-Buffering": "no",
};

// ---------------------------------------------------------------------------
// Small JSON-error helper for the pre-stream rejection paths
// ---------------------------------------------------------------------------

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// Guest IP derivation (account-creation design.md § API Design)
// ---------------------------------------------------------------------------

/**
 * Derive the guest rate-limit identity from the request.  Per the design's
 * documented trust assumption (a single reverse proxy in front of the app on the
 * hobby deploy), the client IP is the FIRST hop of `X-Forwarded-For`, falling
 * back to `X-Real-IP`, then to a constant when neither header is present (the
 * Web `Request` exposes no socket address). The constant simply means all such
 * header-less guests share one bucket — acceptable abuse-bounding at this tier.
 */
function clientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

/**
 * The parsed body, widened with the team-builder's optional `active_team_id`
 * (kept LOCAL — `ChatRequestBody` lives in `@/lib/sse-types`, outside this
 * phase's edit scope). Always present after parsing: a non-empty string id or
 * `null` (guests / old clients / explicit deselect).
 */
type ParsedChatBody = ChatRequestBody & {
  active_team_id: string | null;
  /** Always a resolved registry key — never the raw client string. */
  model: ModelKey;
};

function parseBody(value: unknown): ParsedChatBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { session_id, message, champions_mode, active_team_id, model } =
    value as Record<string, unknown>;
  if (typeof session_id !== "string" || session_id.length === 0) return null;
  if (typeof message !== "string" || message.length === 0) return null;
  // Coerce defensively: anything that is not strictly boolean `true` is
  // standard mode (old clients omit the field entirely).
  // `active_team_id` is optional; anything that is not a non-empty string means
  // "no active team" (null) — guests/old clients omit it, the toggle deselects
  // by sending null. Authorization + format gating happens later via
  // resolveActiveTeam (server-controlled, never trusted from the body alone).
  const teamId =
    typeof active_team_id === "string" && active_team_id.length > 0
      ? active_team_id
      : null;
  // Whitelist-validate the model against the registry: an unknown/missing/non-
  // string key falls back to the default (Claude). Never forward the raw client
  // string downstream — the runtime keys the provider off this resolved value.
  const modelKey: ModelKey = isModelKey(model) ? model : DEFAULT_MODEL_KEY;
  return {
    session_id,
    message,
    champions_mode: champions_mode === true,
    active_team_id: teamId,
    model: modelKey,
  };
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();

  // 1. Parse + validate the body (Next 15: await req.json()). A malformed body
  //    is a client error, surfaced as a plain 400 before any streaming.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be valid JSON.",
    );
  }

  const body = parseBody(raw);
  if (body === null) {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be { session_id: string, message: string } with non-empty values.",
    );
  }

  const { session_id, message } = body;

  // Server-controlled query scope for the turn — derived here, threaded onto the
  // AgentContext, never an LLM-visible tool field. ON ⇒ every query is scoped to
  // Champions; omitted/false ⇒ today's Gen 9 behavior. For a RESUMED signed-in
  // conversation this is overridden below from the stored format (BR-H6); hence
  // `let`, not `const`.
  let mode: AgentMode = body.champions_mode ? "champions" : "standard";

  // 2. Orchestration guardrails — input-length cap + TIERED rate limit
  //    (integration.md § Guardrails; account-creation design.md § API Design
  //    "POST /api/chat (modified)", BR-A8 / AUTH-US-7). Resolve the account from
  //    the session cookie BEFORE the gate, then key + configure by auth tier:
  //      signed in → `acct:<id>` + SIGNED_IN_CONFIG (60/60s).
  //      guest     → `ip:<clientIp>` + GUEST_CONFIG (20/60s).
  //    The two pools never share a key, so guest sessions can't pool into the
  //    account allowance (AC-7.3). The conversation `session_id` is intentionally
  //    NOT the rate-limit key — identity ≠ conversation (AD-2), so the on-screen
  //    thread survives sign-in unchanged (BR-A10). Synchronous gate; the only
  //    await before it is the cookie resolution.
  // Resolve identity defensively: a session-resolution fault (e.g. a DB blip
  // reading the cookie's session) must NOT 500 the chat — it degrades to the
  // guest tier (BR-A11: guests are first-class, never an error path).
  let account: Account | null = null;
  try {
    // Dynamic import defers the auth chain's env evaluation (current-user →
    // sessions → @/env) to request time, not build time — the same reason the
    // runPokebot import below is deferred. A static import would trip
    // `next build` (env's AUTH_SECRET prod guard throws at page-data collection).
    const { getCurrentAccount } = await import("@/server/auth/current-user");
    account = await getCurrentAccount();
  } catch (err) {
    logger.warn(
      {
        event: "chat_account_resolve_failed",
        request_id: requestId,
        session_id,
        err: err instanceof Error ? err.message : String(err),
      },
      "pokebot_chat_account_resolve_failed",
    );
  }

  const rateLimitKey = account
    ? `acct:${account.id}`
    : `ip:${clientIp(req)}`;
  const rateLimitConfig = account ? SIGNED_IN_CONFIG : GUEST_CONFIG;

  const gate = checkRateLimit(rateLimitKey, message, rateLimitConfig);
  if (!gate.allowed) {
    if (gate.reason === "input_too_long") {
      return jsonError(
        413,
        "input_too_long",
        `Message exceeds the ${gate.maxLength}-character limit (got ${gate.actualLength}).`,
      );
    }
    // rate_limited
    return jsonError(
      429,
      "rate_limited",
      "Too many requests. Please wait a moment and try again.",
      { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
    );
  }

  // 3. Resolve the prior history (trim to the context budget first). The current
  //    message is passed to runPokebot SEPARATELY — it must NOT be in `history`,
  //    which holds only prior turns (integration.md § Input Contract). We commit
  //    the user+assistant pair only on a successful answer (below), so a
  //    transport fault leaves the conversation clean for a retry.
  //
  //    SIGNED IN: the durable DB is the source of truth (chat-history HIST-AD-4).
  //    Load the conversation + its turns, derive the model history from the
  //    stored text, trim it, and override `mode` from the stored format (BR-H6).
  //    A DB blip here degrades gracefully to an empty history (never a 500),
  //    consistent with the guest-first stance for account resolution.
  //    GUEST: the in-memory session store, exactly as before.
  let history: ChatMessage[];
  if (account) {
    try {
      const repo = await import("@/data/repos/conversation-repo");
      const conv = await repo.getConversation(account.id, session_id);
      if (conv) {
        mode = modeForFormat(conv.format as Format); // BR-H6 — fixed per conversation
        const stored = await repo.getMessages(account.id, session_id);
        history = trimMessages(
          stored.map((m) => ({ role: m.role, content: m.textContent })),
        );
      } else {
        history = []; // new conversation; mode stays body-derived
      }
    } catch (err) {
      logger.warn(
        {
          event: "chat_history_load_failed",
          request_id: requestId,
          account_id: account.id,
          session_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "pokebot_chat_history_load_failed",
      );
      history = [];
    }
  } else {
    trim(session_id);
    history = [...getHistory(session_id)];
  }

  // 3b. Resolve + authorize the conversation's ACTIVE TEAM before opening the
  //    stream — the exact analogue of `mode`: server-controlled, never an
  //    LLM-visible tool input (BR-T9 / TEAM-AD-1). Gated on a signed-in account
  //    (guests have no saved teams). Gated on a non-empty `active_team_id` too:
  //    with no id there is nothing to resolve, so we skip the import entirely and
  //    leave `activeTeam` null (a not-owned team or a format mismatch still yield
  //    `null` — BR-T3, AC-8.3). `resolveActiveTeam` binds the team ONLY when it is
  //    account-owned AND `team.format === formatForMode(mode)`. It runs AFTER the
  //    history block so `mode` is already finalized from the stored conversation
  //    format on a resume. The resolved team is bound onto `ctx.activeTeam` (below)
  //    and persisted last-selected-wins. A DB blip degrades to no active team
  //    rather than a 500 (guest-first stance).
  let activeTeam:
    | import("@/server/teams/active-team").ActiveTeam
    | null = null;
  if (account && body.active_team_id) {
    try {
      const [{ resolveActiveTeam }, { db }] = await Promise.all([
        import("@/server/teams/active-team"),
        import("@/data/db"),
      ]);
      activeTeam = await resolveActiveTeam(
        account.id,
        body.active_team_id,
        mode,
        db,
      );
    } catch (err) {
      logger.warn(
        {
          event: "chat_active_team_resolve_failed",
          request_id: requestId,
          account_id: account.id,
          session_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "pokebot_chat_active_team_resolve_failed",
      );
    }
  }

  // 3c. Fail fast if the selected model's provider isn't configured on this
  //     server (its API key is absent) — a clean 503 BEFORE the stream opens, so
  //     the client sees a real HTTP status rather than a mid-stream error. The
  //     default (Claude) is always configured, so old clients never hit this.
  //     Dynamic import defers the factory's env/SDK evaluation to request time
  //     (the same reason the runtime import below is deferred). `body.model` is
  //     already a validated registry key.
  {
    const { isModelConfigured } = await import("@/agent/providers/factory");
    if (!isModelConfigured(body.model)) {
      return jsonError(
        503,
        "model_unavailable",
        "The selected model isn't configured on this server. Pick a different model and try again.",
      );
    }
  }

  // 4. Build the SSE stream. Return the Response SYNCHRONOUSLY; emit from the
  //    async task inside start() (never await the whole loop first).
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = <K extends SseEventName>(
        event: K,
        data: SseEventDataMap[K],
      ): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(formatSseEvent(event, data)));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      // Detached async task — drives the agent loop and streams events.
      void (async () => {
        try {
          // Dynamic import defers env validation to request time, not build
          // time (runtime.ts evaluates env at module load; a static import at
          // the top of this file would trigger parseEnv() during `next build`
          // even though the route is force-dynamic).
          const { runPokebot } = await import("@/agent/runtime");

          const ctx = await createAgentContext({
            requestId,
            sessionId: session_id,
            mode,
            // Which LLM answers this turn — validated registry key, authoritative
            // for guests and signed-in users every turn (unlike `mode`, NOT
            // overridden from the stored conversation; history is plain text, so
            // switching models per turn is correctness-safe).
            model: body.model,
            // Server-bound active team (already resolved + authorized above).
            // `undefined` ⇒ no team is bound; the model only ever sees it via the
            // arg-less `get_active_team` tool, never as an input it can widen.
            activeTeam: activeTeam ?? undefined,
            // Forward the inbound abort signal so a client disconnect (the user
            // pressed Stop) tears down the Anthropic stream immediately and the
            // loop bails between iterations — no wasted tokens.
            signal: req.signal,
          });

          // Stream one tool_activity event per tool call as the loop runs.
          const onProgress: OnProgress = (e) => {
            send("tool_activity", { tool: e.tool, label: e.label });
          };

          // Stream the answer_markdown prose token-by-token. answer_start resets
          // the client's in-flight buffer (handles a re-emitted answer); the
          // terminal `answer` event below stays authoritative.
          const onAnswerStart: OnAnswerStart = () => {
            send("answer_start", {});
          };
          const onAnswerDelta: OnAnswerDelta = (text) => {
            send("answer_delta", { text });
          };

          const answer = await runPokebot(
            message,
            history,
            ctx,
            onProgress,
            onAnswerStart,
            onAnswerDelta,
          );

          // If the client disconnected mid-flight (user pressed Stop) the turn is
          // interrupted: do NOT persist it (keeps the session store consistent
          // with the wiped/undone UI) and do NOT emit — the connection is gone.
          if (req.signal.aborted) {
            return;
          }

          // In-domain success (any status). Persist the turn pair for multi-turn
          // refinement, then emit the single terminal answer event.
          if (account) {
            // SIGNED IN: durable, account-scoped persistence (chat-history
            // HIST-AD-3/BR-H2). Deliver the answer FIRST, then write — keeping
            // the DB round-trip off the SSE critical path. The write carries no
            // client turn ids (the chat body has none), so we mint fresh server
            // UUIDs. A persistence failure is LOGGED but never surfaces as an SSE
            // error: the answer is already delivered (BR-H2, off critical path).
            send("answer", { answer });
            try {
              const repo = await import("@/data/repos/conversation-repo");
              await repo.appendTurnPair({
                accountId: account.id,
                conversationId: session_id,
                format: formatForMode(mode),
                userTurnId: repo.newTurnId(),
                userMessage: message,
                assistantTurnId: repo.newTurnId(),
                answer,
                now: Date.now(),
                // Persist the conversation's active team last-selected-wins
                // (TEAM-US-8): the RESOLVED id when one bound, else `null` (no
                // selection / not-owned / format mismatch) so resume restores
                // exactly what was in effect this turn (BR-T9).
                activeTeamId: activeTeam?.id ?? null,
              });
            } catch (err) {
              logger.error(
                {
                  event: "chat_persist_failed",
                  request_id: requestId,
                  account_id: account.id,
                  session_id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "pokebot_chat_persist_failed",
              );
            }
          } else {
            // GUEST: in-memory session store, exactly as before (byte-identical).
            appendTurn(session_id, { role: "user", content: message });
            appendTurn(session_id, {
              role: "assistant",
              content: answer.answer_markdown,
            });
            send("answer", { answer });
          }
        } catch (err) {
          // A client abort (user pressed Stop) surfaces as an AbortError out of
          // the runtime; it is not a transport fault, and the SSE connection is
          // already closed — swallow it quietly and just close the stream.
          if (req.signal.aborted) {
            return;
          }

          // Transport/API fault ONLY (runPokebot never throws for in-domain
          // conditions — those return a PokebotAnswer with a status). Map to the
          // `error` SSE event per integration.md § Error Surface (last two rows).
          const detail = err instanceof Error ? err.message : String(err);
          logger.error(
            {
              event: "chat_transport_error",
              request_id: requestId,
              session_id,
              err: detail,
            },
            "pokebot_chat_transport_error",
          );
          send("error", {
            code: "agent_error",
            message: "The assistant hit a transport error. Please try again.",
          });
        } finally {
          close();
        }
      })();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
