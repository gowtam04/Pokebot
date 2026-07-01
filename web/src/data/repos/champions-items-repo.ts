/**
 * src/data/repos/champions-items-repo.ts — the operator-curated Champions
 * item-availability layer.
 *
 * WHY THIS EXISTS: Pokémon Champions is still rolling out its item pool, and the
 * `@pkmn` data set carries NO per-item Champions legality (the `champions` mod
 * curates the species roster but ships no item data), so the Champions index
 * otherwise treats every Gen-9 item as legal. The operator marks items that are
 * NOT yet in the game from the admin panel; those slugs are stored in
 * `champions_item_exclusion`. The effective Champions item allowlist is
 *   (all Champions items in searchable_names) − (exclusions).
 *
 * READ-TIME, not ingest-time: the exclusion set is consulted where items reach a
 * user — `resolve-index` (picker + the agent's resolve_entity), `validate-team`
 * (item legality), and `get_item` — so an operator toggle takes effect
 * immediately with NO re-ingest. The set is tiny and read fresh each call (no
 * cache to invalidate); the ONLY cache in the path is `resolve-index`'s
 * per-format index, which `setChampionsItemAvailability` resets on write.
 *
 * TWO SURFACES, TWO HANDLE STYLES (mirrors reference-cache):
 *   - The RUNTIME reads (`loadChampionsItemExclusions`) take an optional
 *     `{ db }` ctx — tools/repos forward their bound `ctx.db` (fixture-injectable
 *     in tests); the singleton is the fallback.
 *   - The ADMIN read/write (`listChampionsItemsForAdmin`,
 *     `setChampionsItemAvailability`) use the memoized `@/data/db` singleton
 *     directly, exactly like `admin-content-repo`.
 *
 * WRITE NOTE: this is the FIRST write in the admin surface (the analytics repos
 * are strictly read-only). It only ever touches this one curation table.
 */

import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { OakDb } from "@/data/db";
import { CHAMPIONS_FORMAT } from "@/data/formats";
import { champions_item_exclusion, searchable_names } from "@/data/schema";
import type { AdminChampionsItem } from "@/lib/admin/admin-types";

/** Optional injected handle for the runtime reads (else the @/data/db singleton). */
export interface ChampionsItemsCtx {
  /** The Drizzle handle (a tool's bound `ctx.db`). Defaults to the singleton. */
  db?: OakDb;
}

/** Resolve the Drizzle handle — injected ctx wins; else the lazy singleton. */
async function resolveDb(ctx?: ChampionsItemsCtx): Promise<OakDb> {
  if (ctx?.db) return ctx.db;
  return (await import("@/data/db")).db;
}

/**
 * The set of Champions item slugs the operator has marked UNAVAILABLE. Empty
 * (nothing excluded) both when the table is empty ("pre-select all") and when it
 * cannot be read (pre-migration) — so a missing table degrades to "everything is
 * available" rather than throwing / hiding every item.
 */
export async function loadChampionsItemExclusions(
  ctx?: ChampionsItemsCtx,
): Promise<Set<string>> {
  const db = await resolveDb(ctx);
  try {
    const rows = await db
      .select({ slug: champions_item_exclusion.slug })
      .from(champions_item_exclusion);
    return new Set(rows.map((r) => r.slug));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Admin surface (cross-account; uses the @/data/db singleton like admin repos)
// ---------------------------------------------------------------------------

/**
 * The full Champions held-item universe (from `searchable_names`) with each
 * item's current availability. `available` is `true` unless the slug is
 * excluded — the admin grid's "pre-selected" state.
 */
export async function listChampionsItemsForAdmin(): Promise<AdminChampionsItem[]> {
  const { db } = await import("@/data/db");
  const excluded = await loadChampionsItemExclusions({ db });
  const rows = await db
    .select({
      slug: searchable_names.slug,
      display_name: searchable_names.display_name,
    })
    .from(searchable_names)
    .where(
      and(
        eq(searchable_names.format, CHAMPIONS_FORMAT),
        eq(searchable_names.kind, "item"),
      ),
    )
    .orderBy(asc(searchable_names.display_name));
  return rows.map((r) => ({
    slug: r.slug,
    displayName: r.display_name,
    available: !excluded.has(r.slug),
  }));
}

/**
 * Set one item's Champions availability. `available:false` records an exclusion
 * (idempotent upsert); `available:true` clears it. Resets the Champions resolve
 * index so the picker + the agent's `resolve_entity` reflect the change on the
 * next call (validate-team / get_item read the table fresh and need no reset).
 */
export async function setChampionsItemAvailability(
  slug: string,
  available: boolean,
  excludedBy: string | null,
): Promise<void> {
  const { db } = await import("@/data/db");
  if (available) {
    await db
      .delete(champions_item_exclusion)
      .where(eq(champions_item_exclusion.slug, slug));
  } else {
    await db
      .insert(champions_item_exclusion)
      .values({ slug, excluded_at: Date.now(), excluded_by: excludedBy })
      .onConflictDoNothing();
  }
  // Dynamic import breaks the resolve-index ⇄ champions-items-repo static cycle
  // (resolve-index imports loadChampionsItemExclusions from here).
  const { resetResolveIndex } = await import("@/data/repos/resolve-index");
  resetResolveIndex(CHAMPIONS_FORMAT);
}

/**
 * Bulk-set EVERY Champions item's availability — the "Select all" / "Deselect
 * all" actions. `available:true` clears the whole exclusion table (everything
 * available again); `available:false` excludes every item currently in the
 * Champions item universe (so the operator can start from an empty allowlist and
 * check only the valid items). Returns the number of items now excluded.
 *
 * NOTE: "Deselect all" is a snapshot of the CURRENT item universe — an item
 * added by a later ingest is not retroactively excluded and would default to
 * available, so re-run Deselect all after an ingest that adds items.
 */
export async function setAllChampionsItemsAvailability(
  available: boolean,
  excludedBy: string | null,
): Promise<{ excludedCount: number }> {
  const { db } = await import("@/data/db");
  let excludedCount = 0;
  if (available) {
    await db.delete(champions_item_exclusion);
  } else {
    const rows = await db
      .select({ slug: searchable_names.slug })
      .from(searchable_names)
      .where(
        and(
          eq(searchable_names.format, CHAMPIONS_FORMAT),
          eq(searchable_names.kind, "item"),
        ),
      );
    if (rows.length > 0) {
      const now = Date.now();
      // ~581 items × 3 params is well under Postgres' 65535 bind-param cap.
      await db
        .insert(champions_item_exclusion)
        .values(
          rows.map((r) => ({ slug: r.slug, excluded_at: now, excluded_by: excludedBy })),
        )
        .onConflictDoNothing();
    }
    excludedCount = rows.length;
  }
  const { resetResolveIndex } = await import("@/data/repos/resolve-index");
  resetResolveIndex(CHAMPIONS_FORMAT);
  return { excludedCount };
}
