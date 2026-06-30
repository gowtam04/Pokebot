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
 *      to the context budget first), then drive `runOak` with hooks that
 *      stream `tool_activity` events as tools fire and `answer_start`/
 *      `answer_delta` events as the answer_markdown prose is generated.
 *   4. Emit EXACTLY ONE terminal `answer` event carrying the validated
 *      OakAnswer. Every in-domain failure (resolution_failed /
 *      clarification_needed / insufficient_data) rides this normal `answer`
 *      event — `runOak` never throws for those. ONLY a transport/API fault
 *      (an exception out of `runOak` / context assembly) emits an `error`
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
import { proposedTeamSchema, type ProposedTeam } from "@/agent/schemas";
import { modelLabel } from "@/agent/models";
import { ProviderTransportError } from "@/agent/providers/errors";
import type {
  AgentMode,
  ChatMessage,
  ImageAttachment,
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
import { validateImages } from "@/server/image-upload";
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
} from "@/lib/sse/sse-types";

// Node runtime (node-postgres + the Anthropic SDK need it) and never cached /
// statically optimized — this is a live streaming handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap DoS guard: reject by `Content-Length` BEFORE buffering the body. The real
 * per-image/total caps run in `validateImages` on the DECODED bytes; this just
 * stops an absurd payload from being read into memory. Generous headroom over the
 * 10 MiB decoded image total (base64 inflates ~33%, plus JSON + text).
 */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

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

function parseBody(
  value: unknown,
  hasImages: boolean,
): ChatRequestBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { session_id, message, champions_mode } =
    value as Record<string, unknown>;
  if (typeof session_id !== "string" || session_id.length === 0) return null;
  // The message must be a string, but may be EMPTY when one or more images are
  // attached (an image-only "what is this?" upload). Text-only turns still
  // require non-empty text.
  if (typeof message !== "string") return null;
  if (message.length === 0 && !hasImages) return null;
  // Coerce defensively: anything that is not strictly boolean `true` is
  // standard mode (old clients omit the field entirely).
  // The answering model is NOT taken from the body — it is operator-controlled
  // via the ACTIVE_MODEL secret (resolved server-side below). Any `model` field a
  // client happens to send is ignored. Saved teams are referenced by name in
  // chat (resolved live via list_teams/get_team), so the body carries no team id.
  return {
    session_id,
    message,
    champions_mode: champions_mode === true,
  };
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();

  // 0. Cheap size guard BEFORE buffering the body — an image-bearing request can
  //    be several MB of base64; reject an oversized payload by Content-Length so
  //    we never read it into memory (the precise decoded caps run below).
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonError(413, "payload_too_large", "Request body is too large.");
  }

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

  // 1a. Validate + canonicalize any attached images (count + size caps, magic-
  //     byte MIME sniff) before opening the stream — a bad attachment is a real
  //     HTTP status, not a mid-stream error. Returns the sniffed, re-encoded
  //     attachments bound onto the agent context below.
  const imageResult = validateImages(
    (raw as { images?: unknown } | null)?.images,
  );
  if (!imageResult.ok) {
    return jsonError(imageResult.status, imageResult.code, imageResult.message);
  }
  const images: ImageAttachment[] = imageResult.images;

  const body = parseBody(raw, images.length > 0);
  if (body === null) {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be { session_id: string, message: string } — message may be empty only when an image is attached.",
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
    // runOak import below is deferred. A static import would trip
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
      "oak_chat_account_resolve_failed",
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
  //    message is passed to runOak SEPARATELY — it must NOT be in `history`,
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
  // The most recent team the agent proposed in this conversation (structured),
  // bound onto ctx so the agent can act on "save it" / "this team" reliably —
  // history forwards only the markdown, dropping the structured proposal.
  let proposedTeam: ProposedTeam | undefined;
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
        // Walk back to the latest assistant turn carrying a valid proposed_team.
        for (let i = stored.length - 1; i >= 0 && !proposedTeam; i--) {
          const m = stored[i];
          if (m.role !== "assistant" || !m.answerJson) continue;
          try {
            const parsed = JSON.parse(m.answerJson) as {
              proposed_team?: unknown;
            };
            const candidate = proposedTeamSchema.safeParse(parsed.proposed_team);
            if (candidate.success) proposedTeam = candidate.data;
          } catch {
            /* malformed stored answer — skip */
          }
        }
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
        "oak_chat_history_load_failed",
      );
      history = [];
    }
  } else {
    trim(session_id);
    history = [...getHistory(session_id)];
  }

  // 3c. Resolve the operator-selected active model (the ACTIVE_MODEL secret) and
  //     fail fast if its provider isn't configured on this server (its API key is
  //     absent) — a clean 503 BEFORE the stream opens, so the client sees a real
  //     HTTP status rather than a mid-stream error. The default (Grok) is always
  //     configured (XAI_API_KEY is required at boot), so an unset ACTIVE_MODEL
  //     never hits this; it only fires on a deployment misconfig (e.g.
  //     ACTIVE_MODEL=claude with no ANTHROPIC_API_KEY).
  //     Dynamic import defers the factory's env/SDK evaluation to request time
  //     (the same reason the runtime import below is deferred).
  const { activeModelKey, isModelConfigured } = await import(
    "@/agent/providers/factory"
  );
  const activeModel = activeModelKey();
  if (!isModelConfigured(activeModel)) {
    return jsonError(
      503,
      "model_unavailable",
      `The configured model (${modelLabel(activeModel)}) has no provider key on this server. Set ACTIVE_MODEL to a configured model or add the provider's API key.`,
    );
  }

  // 4. Build the SSE stream. Return the Response SYNCHRONOUSLY; emit from the
  //    async task inside start() (never await the whole loop first).
  const encoder = new TextEncoder();

  // SSE lifecycle state shared by `start` (the producer) AND `cancel` (fired when
  // the client disconnects). `closed` makes every subsequent write a no-op once
  // the turn finishes OR the connection is abandoned; `heartbeat` keeps a long,
  // quiet turn alive (see below). Hoisted here so `cancel()` can reach them.
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Single guarded write path: once the client disconnects, the controller is
      // dead and enqueue throws "Invalid state: Controller is already closed". We
      // catch that, flip `closed`, and stop — never letting it become an
      // unhandledRejection out of the detached task below.
      const enqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          stopHeartbeat();
        }
      };

      const send = <K extends SseEventName>(
        event: K,
        data: SseEventDataMap[K],
      ): void => {
        enqueue(formatSseEvent(event, data));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        stopHeartbeat();
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect — nothing to do.
        }
      };

      // Keep-alive heartbeat. A turn can spend 60s+ in silent reasoning before
      // the first tool/answer byte (image turns especially — large input + long
      // thinking, often with NO tool calls), during which no SSE traffic flows.
      // An idle connection gets dropped by the proxy/browser, which surfaces as a
      // `stream_error` and strands the finished answer. An SSE comment every 15s
      // keeps it warm; comment frames are ignored by the client's frame parser.
      heartbeat = setInterval(() => {
        enqueue(": keep-alive\n\n");
      }, 15_000);

      // Detached async task — drives the agent loop and streams events.
      void (async () => {
        try {
          // Dynamic import defers env validation to request time, not build
          // time (runtime.ts evaluates env at module load; a static import at
          // the top of this file would trigger parseEnv() during `next build`
          // even though the route is force-dynamic).
          const { runOak } = await import("@/agent/runtime");

          const ctx = await createAgentContext({
            requestId,
            sessionId: session_id,
            mode,
            // Which LLM answers this turn — the operator-selected active model
            // (ACTIVE_MODEL), resolved above. Server-controlled like `mode`; never
            // taken from the body. History is plain text, so the model in effect
            // can change between turns without correctness risk.
            model: activeModel,
            // Signed-in account id + the conversation's pending proposed team —
            // both server-bound. The account id lets the team tools
            // (list_teams/get_team/save_team) read+write account-scoped teams;
            // the proposed team lets an approval ("save it") persist the EXACT
            // set the user saw.
            accountId: account?.id,
            proposedTeam,
            // Images attached to THIS turn (validated + mime-sniffed above).
            // Consume-on-turn: handed straight to the model in the current user
            // message, never stored in history. `undefined` ⇒ a text-only turn.
            images: images.length > 0 ? images : undefined,
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

          const answer = await runOak(
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
          // If `save_team` (T13) persisted a team this turn, stamp the answer
          // authoritatively from the server-owned result (the model never copies
          // the UUID). This drives the persistent "Saved ✓" card + viewer open,
          // and the active-team persistence below.
          if (ctx.savedTeam) {
            answer.saved_team = ctx.savedTeam;
          }

          // What to store as the user turn's text for FUTURE turns (history) and
          // the conversation title. The current turn already got the real image
          // via ctx.images (consume-on-turn); the raw image is not persisted, so
          // an image-only message (empty text) records a marker instead of a
          // blank turn.
          const userTurnText =
            message.length > 0
              ? message
              : `[image attached${images.length > 1 ? ` ×${images.length}` : ""}]`;

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
                userMessage: userTurnText,
                assistantTurnId: repo.newTurnId(),
                answer,
                now: Date.now(),
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
                "oak_chat_persist_failed",
              );
            }
          } else {
            // GUEST: in-memory session store, exactly as before (byte-identical
            // for text-only turns; image-only turns store the marker text).
            appendTurn(session_id, { role: "user", content: userTurnText });
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

          // Transport/API fault ONLY (runOak never throws for in-domain
          // conditions — those return a OakAnswer with a status). Map to the
          // `error` SSE event per integration.md § Error Surface (last two rows).
          const detail = err instanceof Error ? err.message : String(err);
          logger.error(
            {
              event: "chat_transport_error",
              request_id: requestId,
              session_id,
              model: activeModel,
              err: detail,
            },
            "oak_chat_transport_error",
          );
          // A typed provider fault (xAI/OpenAI 4xx/5xx — bad key, unsupported
          // param, rate limit, unknown model) gets a MODEL-SCOPED message naming
          // the active model + the upstream status. The generic Anthropic/unknown
          // fault keeps the neutral retry message.
          if (err instanceof ProviderTransportError) {
            const statusPart = err.status ? ` (HTTP ${err.status})` : "";
            send("error", {
              code: "model_provider_error",
              message: `${modelLabel(activeModel)} is unavailable right now${statusPart} — please try again, or check the provider key.`,
              ...(err.status !== undefined ? { status: err.status } : {}),
            });
          } else {
            send("error", {
              code: "agent_error",
              message: "The assistant hit a transport error. Please try again.",
            });
          }
        } finally {
          close();
        }
      })();
    },
    cancel() {
      // The client went away (closed the tab, navigated, lost network). Mark the
      // stream closed so the still-running detached task's send()/close() become
      // no-ops instead of enqueuing on a dead controller (the
      // "Controller is already closed" crash). The agent loop independently sees
      // req.signal abort and bails between iterations.
      closed = true;
      stopHeartbeat();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
