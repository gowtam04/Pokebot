/**
 * build-names.ts — searchable_names rows from a FormatSource + DS-2 rows.
 *
 * Backs resolve_entity (T1, BR-9). Five entity kinds per format:
 *   pokemon  — from the already-built PokemonRows (rich display names).
 *   move / ability / item — from the format's @pkmn collections.
 *   type     — the 18 battle types.
 */

import type { Format } from "@/data/formats";
import { slugFor, slugify, type FormatSource } from "@/data/pkmn/gen-provider";

export type NameKind = "pokemon" | "move" | "ability" | "type" | "item";

export interface NameRow {
  format: Format;
  kind: NameKind;
  /** Canonical slug, e.g. "will-o-wisp", "tauros-paldea-aqua". */
  slug: string;
  /** Human-readable label, e.g. "Will-O-Wisp", "Tauros (Paldean Aqua)". */
  display_name: string;
}

/** Source rows needed from the Pokédex build (id + rich display name). */
export interface PokemonNameSource {
  id: string;
  display_name: string;
}

/**
 * Capitalize each hyphen-separated word of a slug: "will-o-wisp" → "Will-O-Wisp".
 * (Matches the legacy display style for non-Pokémon entities.)
 */
export function slugToDisplayName(slug: string): string {
  if (!slug) return slug;
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("-");
}

/**
 * Build all searchable_names rows for one format.
 *
 * @param source       The resolved @pkmn FormatSource (moves/abilities/items/types).
 * @param pokemonRows  The DS-2 rows for this format (Pokémon names + display).
 */
export function buildNames(
  source: FormatSource,
  pokemonRows: PokemonNameSource[],
): NameRow[] {
  const { format } = source;
  const rows: NameRow[] = [];

  for (const p of pokemonRows) {
    rows.push({ format, kind: "pokemon", slug: p.id, display_name: p.display_name });
  }

  for (const m of source.moves) {
    const slug = slugFor(m.id, m.name);
    rows.push({ format, kind: "move", slug, display_name: slugToDisplayName(slug) });
  }

  for (const a of source.abilities) {
    const slug = slugFor(a.id, a.name);
    rows.push({ format, kind: "ability", slug, display_name: slugToDisplayName(slug) });
  }

  for (const i of source.items) {
    const slug = slugFor(i.id, i.name);
    rows.push({ format, kind: "item", slug, display_name: slugToDisplayName(slug) });
  }

  for (const t of source.types) {
    const slug = slugify(t.name);
    rows.push({ format, kind: "type", slug, display_name: slugToDisplayName(slug) });
  }

  // Dedupe by (kind, slug) — formes/aliases can collide on a slug.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.kind}/${r.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
