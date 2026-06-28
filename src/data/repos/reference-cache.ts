/**
 * src/data/repos/reference-cache.ts — DS-4 reference reader (pure DB read).
 *
 * Since the @pkmn migration, reference detail (move/ability/type/evolution/item)
 * is pre-built per format at ingest (src/ingest/build-reference.ts) from local
 * @pkmn data — there is no upstream and no TTL. `getReference` simply reads the
 * stored, normalized payload for the active format:
 *
 *   1. Look up reference_cache by (format, resource_key).
 *   2. HIT → return the parsed normalized payload (tools.md T4–T8 shape).
 *   3. MISS → { found: false, suggestions } from the format's searchable_names.
 *
 * `upstream_unavailable` is retained in the return union (the detail tools still
 * accept it) but is never produced now — local data can't be "unavailable".
 *
 * node-postgres is asynchronous — the DB reads here are awaited.
 */

import "server-only";

import { and, eq, ilike, inArray } from "drizzle-orm";

import type { OakDb } from "@/data/db";
import type { Format } from "@/data/formats";
import { reference_cache, searchable_names } from "@/data/schema";
import type {
  MoveDetail,
  AbilityDetail,
  TypeMatchupsDetail,
  EvolutionChainDetail,
  ItemDetail,
} from "@/agent/schemas";

/** The five reference-cache resource kinds (data-sources.md DS-4). */
export type RefKind = "move" | "ability" | "type" | "evolution" | "item";

/**
 * The normalized success payload — the discriminated union of the five detail
 * shapes (all carry `found: true`). Exactly what the detail tool returns.
 */
export type RefRecord =
  | MoveDetail
  | AbilityDetail
  | TypeMatchupsDetail
  | EvolutionChainDetail
  | ItemDetail;

/** Full return union of `getReference` (never throws for in-domain failures). */
export type GetReferenceResult =
  | RefRecord
  | { found: false; suggestions: string[] }
  | { error: "upstream_unavailable" };

/**
 * Optional overrides for `getReference`. Production uses the @/data/db
 * singleton; tests inject a fixture DB. (The old client/baseUrl/ttl fields are
 * gone — reference data is local now.)
 */
export interface ReferenceCacheCtx {
  /** The Drizzle handle (DbCtx.db). Defaults to the @/data/db singleton. */
  db?: OakDb;
}

/** Canonical reference_cache key — must match the keys build-reference writes. */
function resourceKey(kind: RefKind, slug: string): string {
  return kind === "evolution" ? `evolution-chain/${slug}` : `${kind}/${slug}`;
}

/** Resolve the Drizzle handle — injected ctx wins; else the lazy singleton. */
async function resolveDb(ctx?: ReferenceCacheCtx): Promise<OakDb> {
  if (ctx?.db) return ctx.db;
  const mod = await import("@/data/db");
  return mod.db;
}

/** Parse a stored payload back into a RefRecord; null if corrupt. */
function parsePayload(payload: string): RefRecord | null {
  try {
    return JSON.parse(payload) as RefRecord;
  } catch {
    return null;
  }
}

/** Cheap candidate slugs for a miss (full fuzzy ranking is resolve_entity's job). */
async function suggestSlugs(
  db: OakDb,
  kind: RefKind,
  slug: string,
  format: Format,
): Promise<string[]> {
  // evolution chains key off a species name -> search the pokemon name set.
  const searchKind = kind === "evolution" ? "pokemon" : kind;
  // ilike: SQLite LIKE was case-insensitive by default; Postgres LIKE is not.
  const rows = await db
    .select({ slug: searchable_names.slug })
    .from(searchable_names)
    .where(
      and(
        eq(searchable_names.format, format),
        eq(searchable_names.kind, searchKind),
        ilike(searchable_names.slug, `%${slug}%`),
      ),
    )
    .limit(5);
  return rows.map((r) => r.slug);
}

/**
 * Read one reference resource for the active format from the pre-built index.
 *
 * @param kind   move | ability | type | evolution | item.
 * @param slug   Canonical slug (resolve_entity first if unsure). For evolution
 *               this is the species slug, e.g. "eevee".
 * @param format The active data scope.
 * @param ctx    Optional injected DB (production uses the singleton).
 */
export async function getReference(
  kind: RefKind,
  slug: string,
  format: Format,
  ctx?: ReferenceCacheCtx,
): Promise<GetReferenceResult> {
  const db = await resolveDb(ctx);
  const key = resourceKey(kind, slug);

  let cached: { payload: string } | undefined;
  try {
    const rows = await db
      .select({ payload: reference_cache.payload })
      .from(reference_cache)
      .where(
        and(
          eq(reference_cache.format, format),
          eq(reference_cache.resource_key, key),
        ),
      )
      .limit(1);
    cached = rows[0];
  } catch {
    // Table missing (migrations not applied) — treat as a miss.
    return { found: false, suggestions: [] };
  }

  if (cached) {
    const record = parsePayload(cached.payload);
    if (record) return record;
  }
  return {
    found: false,
    suggestions: await suggestSlugs(db, kind, slug, format),
  };
}

/** Minimal move facts for hydrating a movepool list (B-4). */
export interface MoveSummary {
  displayName: string;
  type: string;
}

/**
 * Batched read of `{ displayName, type }` for a set of move slugs in `format`,
 * to hydrate a Pokémon's movepool (B-4) without N per-move `getReference` calls.
 * Reads the pre-built `move/<slug>` reference rows and pulls the two display
 * fields off each normalized `MoveDetail` payload. Slugs with no reference row
 * (or a corrupt payload) are simply absent from the map — the caller falls back
 * to the slug. Returns an empty map for an empty input or an unreadable index.
 *
 * @param moveSlugs canonical move slugs to hydrate.
 * @param format    the active data scope ("scarlet-violet" | "champions").
 * @param db        the Drizzle handle (from the request's DbCtx / fixture).
 */
export async function moveSummaries(
  moveSlugs: string[],
  format: Format,
  db: OakDb,
): Promise<Map<string, MoveSummary>> {
  const out = new Map<string, MoveSummary>();
  const distinct = [...new Set(moveSlugs)];
  if (distinct.length === 0) return out;

  const keys = distinct.map((slug) => resourceKey("move", slug));
  let rows: { resource_key: string; payload: string }[];
  try {
    rows = await db
      .select({
        resource_key: reference_cache.resource_key,
        payload: reference_cache.payload,
      })
      .from(reference_cache)
      .where(
        and(
          eq(reference_cache.format, format),
          inArray(reference_cache.resource_key, keys),
        ),
      );
  } catch {
    // Table missing (migrations not applied) — no summaries rather than throwing.
    return out;
  }

  for (const row of rows) {
    const record = parsePayload(row.payload);
    if (!record || !("display_name" in record)) continue;
    const move = record as MoveDetail;
    // resource_key is "move/<slug>" — strip the prefix back to the slug.
    const slug = row.resource_key.slice("move/".length);
    out.set(slug, { displayName: move.display_name, type: move.type });
  }
  return out;
}
