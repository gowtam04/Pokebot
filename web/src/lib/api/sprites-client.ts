/**
 * sprites-client — the typed `fetch` helper over `GET /api/sprites`.
 *
 * The team artifact's only call into the batch sprite/type/base-stat read path.
 * Mirrors entity-client.ts: it NEVER throws — a transport fault, a non-2xx, or a
 * malformed body all fold to `{}`, so the team simply renders without sprites /
 * computed stats rather than erroring (sprites are a progressive enhancement of
 * the slug-only member data).
 *
 * `SpriteRef` is imported type-only (fully erased) — no server-only / db / @pkmn
 * runtime code is dragged into the client bundle.
 */

import type { SpriteRef } from "@/data/repos/pokedex-repo";

export type { SpriteRef };

/** Best-effort narrowing of one ref from the JSON body; null if malformed. */
function toRef(value: unknown): SpriteRef | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const bs = r.base_stats;
  if (
    typeof r.display_name !== "string" ||
    typeof r.sprite_url !== "string" ||
    typeof r.dex_number !== "number" ||
    !Array.isArray(r.types) ||
    bs === null ||
    typeof bs !== "object" ||
    // required_item is nullable but, when present, must be a string.
    (r.required_item != null && typeof r.required_item !== "string")
  ) {
    return null;
  }
  return value as SpriteRef;
}

/**
 * Resolve renderable refs (sprite_url, types, base_stats) for a batch of species
 * slugs (or display names) in `format`. Returns a map keyed by the requested
 * name; unknown names are simply absent. Returns `{}` on any failure.
 */
export async function resolveSprites(
  format: string,
  names: string[],
): Promise<Record<string, SpriteRef>> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return {};
  try {
    const params = new URLSearchParams({ format, names: wanted.join(",") });
    const res = await fetch(`/api/sprites?${params.toString()}`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return {};
    const data: unknown = await res.json();
    const refs =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).refs
        : null;
    if (refs === null || typeof refs !== "object") return {};
    const out: Record<string, SpriteRef> = {};
    for (const [key, value] of Object.entries(refs as Record<string, unknown>)) {
      const ref = toRef(value);
      if (ref) out[key] = ref;
    }
    return out;
  } catch {
    return {};
  }
}
