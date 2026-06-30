/**
 * Parse a `OakAnswer` citation `source` into an openable entity (B-4,
 * AV-US-3 — clicking a Sources entry opens that resource as an entity artifact).
 *
 * `source` is `"<kind>/<slug>"`, e.g. "ability/armor-tail", "pokemon/garchomp",
 * "type/ground", "learnset/will-o-wisp (gen-9)". `learnset` maps to `move` and a
 * trailing parenthetical qualifier is stripped. An unknown prefix returns null
 * (the citation renders as plain, non-clickable text — no crash).
 */

import type { EntityKind } from "@/agent/schemas";

const ENTITY_KINDS = new Set<string>([
  "pokemon",
  "move",
  "ability",
  "item",
  "type",
]);

export function parseCitationSource(
  source: string,
): { kind: EntityKind; q: string } | null {
  const slash = source.indexOf("/");
  if (slash <= 0) return null;

  let prefix = source.slice(0, slash).trim();
  if (prefix === "learnset") prefix = "move";
  if (!ENTITY_KINDS.has(prefix)) return null;

  // Strip a trailing qualifier like " (gen-9)".
  const paren = source.indexOf("(", slash);
  const rawSlug = (paren >= 0 ? source.slice(slash + 1, paren) : source.slice(slash + 1)).trim();
  if (!rawSlug) return null;

  return { kind: prefix as EntityKind, q: rawSlug };
}
