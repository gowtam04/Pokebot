/**
 * display-names — small, shared slug/format → label helpers for the team
 * builder UI. Consolidates what used to be nearly-identical `titleize()` and
 * `formatLabel()` copies scattered across several team components.
 */

/** Title-case a slug for display ("great-tusk" → "Great Tusk"). */
export function titleizeSlug(value: string | null, empty = "Empty"): string {
  if (!value) return empty;
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Human-friendly format label ("champions" → "Champions"). */
export function formatLabel(format: string): string {
  if (format === "champions") return "Champions";
  if (format === "scarlet-violet") return "Scarlet/Violet";
  return format;
}
