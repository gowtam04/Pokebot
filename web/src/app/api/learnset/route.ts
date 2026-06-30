/**
 * `GET /api/learnset` — the team builder's per-species legal-movepool lookup.
 *
 * A team member's Move pickers must offer ONLY the moves that member's species
 * can actually learn in the active format (not the whole move index). The client
 * resolves that movepool here, once per focused species, and feeds it to the
 * pickers as a static option list.
 *
 *   ?pokemon=<species slug>                (e.g. "swampert-mega")
 *   ?format=scarlet-violet|champions        (snapshot at open time, BR-AV-7)
 *
 * Response (always a 200 for in-domain results, mirroring /api/sprites):
 *   - 200 { moves: { slug, display_name }[] }   (unknown species ⇒ empty list)
 *   - 400 { error } for a malformed/missing param
 *
 * No auth gate — public Pokédex data; works for guests. Never throws for
 * in-domain misses: an unreadable index degrades to `{ moves: [] }`. `@/data/db`
 * (and its repo dependents) import `@/env` at module load, so they are
 * DYNAMICALLY imported inside the handler — keeping `next build` from evaluating
 * `env` (cf. the sprites / entity / chat routes).
 */

import { json } from "@/app/api/auth/_lib/http";
import { isFormat, type Format } from "@/data/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get("pokemon")?.trim() ?? "";
  const formatParam = url.searchParams.get("format")?.trim() ?? "";

  if (slug.length === 0) return json(400, { error: "missing_pokemon" });
  if (!isFormat(formatParam)) return json(400, { error: "invalid_format" });

  const format = formatParam as Format;

  try {
    const { db } = await import("@/data/db");
    const { movesForPokemon } = await import("@/data/repos/learnset-repo");
    const { moveSummaries } = await import("@/data/repos/reference-cache");

    const learned = await movesForPokemon(slug, format, db);
    const summaries = await moveSummaries(
      learned.map((m) => m.moveSlug),
      format,
      db,
    );
    // Hydrate display names (fall back to the slug), then sort by display name
    // for a stable, friendly dropdown order.
    const moves = learned
      .map((m) => ({
        slug: m.moveSlug,
        display_name: summaries.get(m.moveSlug)?.displayName ?? m.moveSlug,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    return json(200, { moves });
  } catch (err) {
    // Transport/DB fault — degrade to an empty list (the pickers stay usable,
    // just unfiltered-empty) rather than a 500.
    const { logger } = await import("@/server/logger");
    logger.error({
      event: "learnset_fetch_failed",
      pokemon: slug,
      format,
      err: err instanceof Error ? err.message : String(err),
    });
    return json(200, { moves: [] });
  }
}
