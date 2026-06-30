/**
 * learnset-client — the typed `fetch` helper over `GET /api/learnset`.
 *
 * The team builder calls this once per focused species to get that species'
 * LEGAL movepool (slug + display name) for the active format, then feeds it to
 * the member's Move pickers as a static option list — so the dropdowns only ever
 * offer learnable moves. Mirrors sprites-client.ts / search-client.ts: it NEVER
 * throws — a transport fault, a non-2xx, or a malformed body all fold to `[]`,
 * so the pickers simply show no suggestions rather than erroring.
 */

import type { Format } from "@/data/formats";

/** One legal move as the picker consumes it (structurally a PickerOption). */
export interface LearnsetOption {
  slug: string;
  display_name: string;
}

/** Best-effort narrowing of one move from the JSON body; null if malformed. */
function toOption(value: unknown): LearnsetOption | null {
  if (value === null || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.slug !== "string" || typeof m.display_name !== "string") {
    return null;
  }
  return { slug: m.slug, display_name: m.display_name };
}

/**
 * Resolve the legal movepool for `speciesSlug` in `format` as picker options
 * (slug + display name), sorted by display name. A blank slug or any failure
 * yields `[]`.
 */
export async function fetchLearnset(
  format: Format,
  speciesSlug: string,
): Promise<LearnsetOption[]> {
  const slug = speciesSlug.trim();
  if (slug.length === 0) return [];
  try {
    const params = new URLSearchParams({ format, pokemon: slug });
    const res = await fetch(`/api/learnset?${params.toString()}`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const moves =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).moves
        : null;
    if (!Array.isArray(moves)) return [];
    return moves
      .map(toOption)
      .filter((m): m is LearnsetOption => m !== null);
  } catch {
    return [];
  }
}
