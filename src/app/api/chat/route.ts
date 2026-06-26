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
import type {
  AgentMode,
  OnAnswerDelta,
  OnAnswerStart,
  OnProgress,
} from "@/agent/types";
import { logger } from "@/server/logger";
import { checkRateLimit } from "@/server/rate-limit";
import { appendTurn, getHistory, trim } from "@/server/session-store";
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
// Body validation
// ---------------------------------------------------------------------------

function parseBody(value: unknown): ChatRequestBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { session_id, message, champions_mode } = value as Record<
    string,
    unknown
  >;
  if (typeof session_id !== "string" || session_id.length === 0) return null;
  if (typeof message !== "string" || message.length === 0) return null;
  // Coerce defensively: anything that is not strictly boolean `true` is
  // standard mode (old clients omit the field entirely).
  return { session_id, message, champions_mode: champions_mode === true };
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
  // Champions; omitted/false ⇒ today's Gen 9 behavior.
  const mode: AgentMode = body.champions_mode ? "champions" : "standard";

  // 2. Orchestration guardrails — input-length cap + per-session rate limit
  //    (integration.md § Guardrails). Synchronous; runs before the stream opens.
  const gate = checkRateLimit(session_id, message);
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
  //    the user+assistant pair to the store only on a successful answer (below),
  //    so a transport fault leaves the session clean for a retry.
  trim(session_id);
  const history = [...getHistory(session_id)];

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

          // In-domain success (any status). Persist the turn pair for multi-turn
          // refinement, then emit the single terminal answer event.
          appendTurn(session_id, { role: "user", content: message });
          appendTurn(session_id, {
            role: "assistant",
            content: answer.answer_markdown,
          });
          send("answer", { answer });
        } catch (err) {
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
