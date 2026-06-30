/**
 * `POST /api/conversations/import` — the guest→sign-in bulk save
 * (docs/features/chat-history § API Design; HIST-US-12, BR-H10, AC-12.1, AC-12.2).
 *
 * At sign-in the on-screen thread's full-fidelity turns live only on the client,
 * so this is the ONE client-driven write path (HIST-AD-3). It validates every
 * assistant turn's `answer` against `oakAnswerSchema` before storing
 * (malformed → 400 `invalid_turns`), then upserts the conversation and inserts
 * the rows idempotently (ON CONFLICT keyed by the client turn ids).
 *
 *   - empty turns → 200 { id: null } (creates nothing, AC-12.2)
 *   - else        → 200 { id }
 *   - guest       → 401
 */

import { json, jsonError, readJsonObject } from "@/app/api/auth/_lib/http";
import { oakAnswerSchema } from "@/agent/schemas";
import { formatForMode } from "@/data/formats";
import type { ChatTurn } from "@/components/types";
import { currentAccount, conversationRepo } from "../_lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Validate the client-sent turns into a clean ChatTurn[] (dropping any extra
 * fields), or return `null` if any turn is malformed. Assistant answers are
 * validated against the canonical OakAnswer schema (BR-H3).
 */
function validateTurns(raw: unknown): ChatTurn[] | null {
  if (!Array.isArray(raw)) return null;
  const turns: ChatTurn[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.length === 0) return null;

    if (t.role === "user") {
      if (typeof t.content !== "string") return null;
      turns.push({ id: t.id, role: "user", content: t.content });
    } else if (t.role === "assistant") {
      const parsed = oakAnswerSchema.safeParse(t.answer);
      if (!parsed.success) return null;
      turns.push({ id: t.id, role: "assistant", answer: parsed.data });
    } else {
      return null;
    }
  }
  return turns;
}

export async function POST(req: Request): Promise<Response> {
  const account = await currentAccount();
  if (account === null) {
    return jsonError(401, "unauthorized", "You must be signed in.");
  }

  const body = await readJsonObject(req);
  if (
    body === null ||
    typeof body.session_id !== "string" ||
    body.session_id.length === 0
  ) {
    return jsonError(
      400,
      "invalid_request",
      "Request body must be { session_id, champions_mode, turns }.",
    );
  }

  const turns = validateTurns(body.turns);
  if (turns === null) {
    return jsonError(
      400,
      "invalid_turns",
      "One or more turns are malformed.",
    );
  }

  // Empty thread imports nothing (AC-12.2) — no DB row created.
  if (turns.length === 0) {
    return json(200, { id: null });
  }

  const championsMode = body.champions_mode === true;
  const format = formatForMode(championsMode ? "champions" : "standard");

  const repo = await conversationRepo();
  const id = await repo.importConversation({
    accountId: account.id,
    id: body.session_id,
    format,
    turns,
    now: Date.now(),
  });

  return json(200, { id });
}
