/**
 * `GET /api/conversations` — list the signed-in account's conversations
 * (docs/features/chat-history § API Design; HIST-US-3, HIST-US-10, HIST-US-11,
 * BR-H11).
 *
 *   - signed in → 200 { conversations: ConversationSummary[] } — pinned first,
 *     then most-recently-active. `?q=` filters by title OR message text; the
 *     optional `?format=` filters by format.
 *   - guest     → 200 { conversations: [] } (graceful, mirrors GET /api/auth/me).
 *
 * Isolation (BR-H1): the repo scopes every row to the resolved account.id.
 */

import { json } from "@/app/api/auth/_lib/http";
import { isFormat } from "@/data/formats";
import { currentAccount, conversationRepo } from "./_lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const account = await currentAccount();
  if (account === null) {
    // Guests have no server-side history (BR-H1) — empty list, never an error.
    return json(200, { conversations: [] });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const formatParam = url.searchParams.get("format")?.trim();
  const format = formatParam && isFormat(formatParam) ? formatParam : undefined;

  const repo = await conversationRepo();
  const conversations = await repo.listConversations(account.id, { q, format });
  return json(200, { conversations });
}
