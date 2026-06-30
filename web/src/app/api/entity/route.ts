/**
 * `GET /api/entity` — the artifact viewer's entity-detail read endpoint (B-4,
 * TD-1). Resolves a clicked entity's name/slug to a canonical slug and composes
 * the full profile the artifact needs through the repo layer (the sole DB
 * readers) — the agent's fixed 11-tool contract and tool-loop are untouched.
 *
 *   ?kind=pokemon|move|ability|item|type   (always known at the click site)
 *   ?q=<display name or canonical slug>
 *   ?format=scarlet-violet|champions        (snapshot at open time, BR-AV-7)
 *
 * Responses (all valid envelopes ride a 200, mirroring the app's "in-domain
 * failure is a normal response" philosophy — the client switches on `status`):
 *   - 200 EntityArtifactResponse { status: "ok" | "not_found" | "unavailable" }
 *   - 400 { error } for a malformed/missing param (NOT an artifact envelope)
 *
 * No auth gate — public Pokédex data; works for guests. Never throws for
 * in-domain misses (BR-AV-5, NFR-2): an unreadable index degrades to
 * `unavailable`. `@/data/db` (and its repo dependents) import `@/env` at module
 * load, so they are DYNAMICALLY imported inside the handler — keeping `next
 * build` from evaluating `env` (cf. the chat route).
 */

import { json } from "@/app/api/auth/_lib/http";
import { isFormat, type Format } from "@/data/formats";
import { ENTITY_KINDS, type EntityKind } from "@/agent/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<string>(ENTITY_KINDS);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const formatParam = url.searchParams.get("format")?.trim() ?? "";

  // --- Param validation (pure; a bad param is a real 4xx, not an envelope) ---
  if (!KINDS.has(kindParam)) return json(400, { error: "invalid_kind" });
  if (q.length === 0) return json(400, { error: "missing_query" });
  if (!isFormat(formatParam)) return json(400, { error: "invalid_format" });

  const kind = kindParam as EntityKind;
  const format = formatParam as Format;

  try {
    const { db } = await import("@/data/db");
    const { assembleEntityProfile, isIndexAvailable } = await import(
      "@/data/entity-profile"
    );

    if (!(await isIndexAvailable(format, db))) {
      return json(200, { status: "unavailable", kind, format });
    }

    const { resolveEntity } = await import("@/data/repos/resolve-index");
    const { matches } = await resolveEntity(q, kind, 5, format);
    if (matches.length === 0) {
      return json(200, {
        status: "not_found",
        kind,
        format,
        query: q,
        suggestions: [],
      });
    }

    const result = await assembleEntityProfile(kind, matches[0]!.slug, format, db);
    return json(200, result);
  } catch (err) {
    // Transport/DB fault — degrade to a clear "couldn't load" envelope (NFR-2)
    // rather than a 500, so the viewer shows an honest state, not a crash.
    const { logger } = await import("@/server/logger");
    logger.error({
      event: "entity_fetch_failed",
      kind,
      query: q,
      format,
      err: err instanceof Error ? err.message : String(err),
    });
    return json(200, { status: "unavailable", kind, format });
  }
}
