/**
 * `GET /api/sprites` — batch sprite / type / base-stat lookup for the team
 * artifact (detailed team view). Team members carry only a species *slug*, so the
 * client resolves the renderable bits (sprite image, types, base stats — the
 * inputs to the client-side stat readout) here in one query.
 *
 *   ?format=scarlet-violet|champions   (snapshot at open time, BR-AV-7)
 *   ?names=<comma-separated species slugs or display names>
 *
 * Response (always a 200 for in-domain results, mirroring /api/entity):
 *   - 200 { refs: { [requested-name]: SpriteRef } }   (unknown names absent)
 *   - 400 { error } for a malformed/missing param
 *
 * No auth gate — public Pokédex data; works for guests. Never throws for
 * in-domain misses: an unreadable index degrades to `{ refs: {} }`. `@/data/db`
 * (and its repo dependents) import `@/env` at module load, so they are
 * DYNAMICALLY imported inside the handler — keeping `next build` from evaluating
 * `env` (cf. the entity / chat routes).
 */

import { json } from "@/app/api/auth/_lib/http";
import { isFormat, type Format } from "@/data/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cap the batch: a team is ≤6 members, so this is generous abuse-bounding. */
const MAX_NAMES = 24;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const formatParam = url.searchParams.get("format")?.trim() ?? "";
  const names = (url.searchParams.get("names") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, MAX_NAMES);

  if (!isFormat(formatParam)) return json(400, { error: "invalid_format" });
  if (names.length === 0) return json(200, { refs: {} });

  const format = formatParam as Format;

  try {
    const { db } = await import("@/data/db");
    const { spriteRefsByNames } = await import("@/data/repos/pokedex-repo");
    const map = await spriteRefsByNames(names, format, db);
    const refs = Object.fromEntries(map);
    return json(200, { refs });
  } catch (err) {
    // Transport/DB fault — degrade to an empty map (sprites stay absent) rather
    // than a 500, so the viewer renders the team without crashing.
    const { logger } = await import("@/server/logger");
    logger.error({
      event: "sprites_fetch_failed",
      format,
      count: names.length,
      err: err instanceof Error ? err.message : String(err),
    });
    return json(200, { refs: {} });
  }
}
