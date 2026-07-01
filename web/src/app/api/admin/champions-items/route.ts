/**
 * `/api/admin/champions-items` — the operator-curated Champions item allowlist.
 *
 *   GET  → ChampionsItemsResponse { items: AdminChampionsItem[] }
 *          The full Champions held-item universe, each flagged `available`
 *          (true unless the operator excluded it). "Pre-select all": a fresh
 *          install has nothing excluded, so every item is available.
 *   POST → ChampionsItemToggleResponse { slug, available }
 *          Body { slug, available } toggles one item's availability
 *          (available:false records an exclusion; available:true clears it).
 *
 * The POST is the FIRST WRITE in the `/api/admin/*` surface (every other admin
 * route is read-only, ADMIN-BR-2). It only ever touches the one curation table.
 *
 * Gating (ADMIN-AC-1.4): `requireAdminRequest` runs FIRST on BOTH verbs — 401 (no
 * session) / 403 (non-admin) / pass. The guard + repo are reached via DYNAMIC
 * import inside the handler so `next build`'s page-data collection never eagerly
 * evaluates the env/db-touching chain (CLAUDE.md "API ROUTES").
 */

import { json, jsonError, readJsonObject } from "@/app/api/auth/_lib/http";
import type {
  ChampionsItemsBulkResponse,
  ChampionsItemsResponse,
  ChampionsItemToggleResponse,
} from "@/lib/admin/admin-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { requireAdminRequest } = await import("../_lib/guard");
  const guard = await requireAdminRequest(req);
  if ("response" in guard) return guard.response;

  const { listChampionsItemsForAdmin } = await import(
    "@/data/repos/champions-items-repo"
  );
  const items = await listChampionsItemsForAdmin();
  const body: ChampionsItemsResponse = { items };
  return json(200, body);
}

export async function POST(req: Request): Promise<Response> {
  const { requireAdminRequest } = await import("../_lib/guard");
  const guard = await requireAdminRequest(req);
  if ("response" in guard) return guard.response;

  const raw = await readJsonObject(req);
  const available = raw?.available;
  if (typeof available !== "boolean") {
    return jsonError(
      400,
      "invalid_request",
      "Body must be { slug, available } or { all: true, available }.",
    );
  }

  const repo = await import("@/data/repos/champions-items-repo");

  // Bulk: { all: true, available } — Select all / Deselect all.
  if (raw?.all === true) {
    await repo.setAllChampionsItemsAvailability(available, guard.account.email);
    const body: ChampionsItemsBulkResponse = { all: true, available };
    return json(200, body);
  }

  // Single: { slug, available }.
  const slug = typeof raw?.slug === "string" ? raw.slug.trim() : "";
  if (slug === "") {
    return jsonError(
      400,
      "invalid_request",
      "Body must be { slug, available } or { all: true, available }.",
    );
  }
  await repo.setChampionsItemAvailability(slug, available, guard.account.email);
  const body: ChampionsItemToggleResponse = { slug, available };
  return json(200, body);
}
