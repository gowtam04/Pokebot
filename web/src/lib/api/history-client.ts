/**
 * history-client — typed `fetch` helpers over the `/api/conversations/*` routes
 * (docs/features/chat-history § Interface Definitions, Phase 5).
 *
 * The ONLY thing the history UI / page talk to for conversation data. Mirrors
 * auth-client.ts: helpers NEVER throw — a transport/HTTP failure folds into a
 * safe value (`[]` / `null` / `false`) so the UI always has something to render.
 * The httpOnly session cookie is sent automatically on these same-origin
 * requests (`credentials: "same-origin"`).
 */

import type { ChatTurn } from "@/components/types";

/** List-view summary (no turns). */
export interface ConversationSummary {
  id: string;
  title: string;
  format: string;
  pinned: boolean;
  updatedAt: number;
}

/** Full conversation, turns rehydrated to the same shape the thread renders. */
export interface ConversationDetail {
  id: string;
  title: string;
  format: string;
  pinned: boolean;
  turns: ChatTurn[];
}

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** Best-effort parse of a JSON body; a non-JSON/empty body yields `{}`. */
async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json();
    if (data !== null && typeof data === "object") {
      return data as Record<string, unknown>;
    }
  } catch {
    /* non-JSON or empty body */
  }
  return {};
}

/**
 * `GET /api/conversations` — list the signed-in account's conversations (pinned
 * first, then most-recently-active). `q` filters by title/message text; `format`
 * filters by format. A guest, or any failure, yields `[]`.
 */
export async function listConversations(opts?: {
  q?: string;
  format?: string;
}): Promise<ConversationSummary[]> {
  try {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.format) params.set("format", opts.format);
    const qs = params.toString();
    const res = await fetch(`/api/conversations${qs ? `?${qs}` : ""}`, {
      method: "GET",
      credentials: "same-origin",
    });
    const body = await readJsonBody(res);
    return Array.isArray(body.conversations)
      ? (body.conversations as ConversationSummary[])
      : [];
  } catch {
    return [];
  }
}

/**
 * `GET /api/conversations/[id]` — the full conversation with rehydrated turns,
 * or `null` if missing / not owned / a transport fault (HIST-US-4).
 */
export async function getConversation(
  id: string,
): Promise<ConversationDetail | null> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const body = await readJsonBody(res);
    if (typeof body.id !== "string" || !Array.isArray(body.turns)) return null;
    return body as unknown as ConversationDetail;
  } catch {
    return null;
  }
}

/** Internal: PATCH a conversation; returns whether it succeeded. */
async function patch(
  id: string,
  payload: { title?: string; pinned?: boolean },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** `PATCH` rename (BR-H7). */
export function renameConversation(id: string, title: string): Promise<boolean> {
  return patch(id, { title });
}

/** `PATCH` pin / unpin (HIST-US-9). */
export function setPinned(id: string, pinned: boolean): Promise<boolean> {
  return patch(id, { pinned });
}

/**
 * `DELETE /api/conversations/[id]` — permanent (BR-H8). A 404 (already gone /
 * not found) counts as success for an idempotent delete UX.
 */
export async function deleteConversation(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * `POST /api/conversations/import` — guest→sign-in bulk save (HIST-US-12).
 * Returns the saved conversation id, or `null` (empty thread / refusal / fault).
 */
export async function importConversation(
  sessionId: string,
  championsMode: boolean,
  turns: ChatTurn[],
): Promise<string | null> {
  try {
    const res = await fetch("/api/conversations/import", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({
        session_id: sessionId,
        champions_mode: championsMode,
        turns,
      }),
    });
    if (!res.ok) return null;
    const body = await readJsonBody(res);
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}
