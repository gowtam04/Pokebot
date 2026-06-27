/**
 * import-export.ts — Showdown paste ⇄ {@link TeamMember} mapping (TEAM-US-10/11).
 *
 * Composes the `@pkmn/sets` boundary (`src/data/pkmn/team-paste.ts`, which deals
 * in display names) with name↔slug resolution over the `searchable_names` index
 * to translate between Showdown's `PokemonSet` (display names) and the project's
 * slug-based `TeamMember` (the shape stored in `team.members` and emitted as the
 * agent's `proposed_team`).
 *
 * Two contract rules drive the design:
 *   - **Resolve-or-clarify (BR-T7):** every species/move/ability/item/nature/tera
 *     name that does NOT resolve to a known slug becomes an {@link ImportNote}
 *     and the corresponding member field is left empty (`null`, or dropped from
 *     `moves`) — the import is never aborted wholesale (BR-T11, AC-10.2).
 *   - **Warn-but-allow (BR-T6/T11):** out-of-range EVs/IVs and illegal-but-named
 *     entries are preserved as-is; legality is a separate warn-only concern
 *     (`validate-team.ts`), never enforced here.
 *
 * Boundary notes:
 *   - This module imports `@pkmn` types ONLY via `team-paste` (the `ShowdownSet`
 *     re-export), never `@pkmn/sets` directly — keeping that dependency isolated
 *     to `src/data/pkmn`.
 *   - It reads `searchable_names` through the supplied Drizzle handle (type-only
 *     `PokebotDb` import, like the repos) so it stays exercisable against a
 *     fixture DB without opening its own connection. Natures are not in the
 *     index, so they validate against the fixed 25-nature set below.
 */

import { eq } from "drizzle-orm";

import type { PokebotDb } from "@/data/db";
import type { Format } from "@/data/formats";
import { searchable_names } from "@/data/schema";
import type { StatSpread, TeamMember } from "@/data/teams/team-schema";
import {
  type ShowdownSet,
  parseShowdown,
  serializeShowdown,
} from "@/data/pkmn/team-paste";

/** A resolve-or-clarify note surfaced to the user after an import (BR-T7). */
export interface ImportNote {
  /** 0-based slot the note applies to. */
  slot: number;
  /** What kind of name failed to resolve. */
  kind: "pokemon" | "move" | "ability" | "item" | "nature" | "tera";
  /** The raw text that was in the paste. */
  raw: string;
  /** The slug it was resolved to, when resolution still succeeded fuzzily. */
  resolvedTo?: string;
  /** Human-readable explanation. */
  message: string;
}

/** The `searchable_names.kind` a given import field resolves against. */
type IndexKind = "pokemon" | "move" | "ability" | "item" | "type";

/** The 25 natures (Showdown display names). Not indexed in `searchable_names`. */
const NATURE_SLUGS: ReadonlySet<string> = new Set([
  "hardy", "lonely", "brave", "adamant", "naughty",
  "bold", "docile", "relaxed", "impish", "lax",
  "timid", "hasty", "serious", "jolly", "naive",
  "modest", "mild", "quiet", "bashful", "rash",
  "calm", "gentle", "sassy", "careful", "quirky",
]);

/** Showdown defaults applied when a paste omits a field. */
const DEFAULT_LEVEL = 100; // Showdown omits `Level:` when 100.
const DEFAULT_EV = 0;
const DEFAULT_IV = 31;

const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

/**
 * `@pkmn` display name → legacy PokeAPI-style slug. A local copy of the
 * `gen-provider.ts` `slugify` (kept here to avoid pulling `@pkmn/dex` into the
 * service/test path — this function is pure and imports nothing).
 */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/['.]/g, "") // farfetch'd → farfetchd
    .replace(/[^a-z0-9]+/g, "-") // any other run → single hyphen
    .replace(/^-+|-+$/g, "");
}

/** Humanize a slug back to a display name fallback ("great-tusk" → "Great Tusk"). */
function humanize(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * A per-format name resolver built once from `searchable_names`:
 *   - `forward[kind]`: slugify(name) → canonical slug (keyed by BOTH the slug
 *     and the display name so Showdown forme names and human names both resolve).
 *   - `display[kind]`: slug → display name (for export).
 */
interface Resolver {
  forward: Record<IndexKind, Map<string, string>>;
  display: Record<IndexKind, Map<string, string>>;
}

async function buildResolver(format: Format, db: PokebotDb): Promise<Resolver> {
  const rows = (await db
    .select({
      kind: searchable_names.kind,
      slug: searchable_names.slug,
      display_name: searchable_names.display_name,
    })
    .from(searchable_names)
    .where(eq(searchable_names.format, format))) as Array<{
    kind: string;
    slug: string;
    display_name: string;
  }>;

  const empty = (): Record<IndexKind, Map<string, string>> => ({
    pokemon: new Map(),
    move: new Map(),
    ability: new Map(),
    item: new Map(),
    type: new Map(),
  });

  const forward = empty();
  const display = empty();

  for (const row of rows) {
    const kind = row.kind as IndexKind;
    const fwd = forward[kind];
    if (!fwd) continue; // ignore any kind we don't import (e.g. future kinds)
    // Slug wins on conflict, so register the display-name key first.
    fwd.set(slugify(row.display_name), row.slug);
    fwd.set(slugify(row.slug), row.slug);
    display[kind].set(row.slug, row.display_name);
  }

  return { forward, display };
}

/** Resolve one display name against the index for a kind; null when unknown. */
function resolveSlug(
  resolver: Resolver,
  kind: IndexKind,
  raw: string,
): string | null {
  const key = slugify(raw);
  if (key.length === 0) return null;
  return resolver.forward[kind].get(key) ?? null;
}

/** Coerce a (possibly partial) `@pkmn` stats table to a full StatSpread. */
function toStatSpread(
  table: Partial<Record<string, number>> | undefined,
  fallback: number,
): StatSpread {
  const out = {} as StatSpread;
  for (const k of STAT_KEYS) {
    const v = table?.[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  return out;
}

/** Map a single parsed Showdown set to a TeamMember, collecting notes. */
function mapSet(
  set: ShowdownSet,
  slot: number,
  resolver: Resolver,
  notes: ImportNote[],
): TeamMember {
  // species — required field; unresolved → null + note (rest still imports).
  let species: string | null = null;
  if (set.species && set.species.trim()) {
    species = resolveSlug(resolver, "pokemon", set.species);
    if (species === null) {
      notes.push({
        slot,
        kind: "pokemon",
        raw: set.species,
        message: `Could not resolve Pokémon "${set.species}" — left empty.`,
      });
    }
  }

  // ability
  let ability: string | null = null;
  if (set.ability && set.ability.trim()) {
    ability = resolveSlug(resolver, "ability", set.ability);
    if (ability === null) {
      notes.push({
        slot,
        kind: "ability",
        raw: set.ability,
        message: `Could not resolve ability "${set.ability}" — left empty.`,
      });
    }
  }

  // item
  let item: string | null = null;
  if (set.item && set.item.trim()) {
    item = resolveSlug(resolver, "item", set.item);
    if (item === null) {
      notes.push({
        slot,
        kind: "item",
        raw: set.item,
        message: `Could not resolve item "${set.item}" — left empty.`,
      });
    }
  }

  // moves — drop the unresolved ones, keep the rest (max 4).
  const moves: string[] = [];
  for (const rawMove of set.moves ?? []) {
    if (!rawMove || !rawMove.trim()) continue;
    if (moves.length >= 4) break;
    const moveSlug = resolveSlug(resolver, "move", rawMove);
    if (moveSlug === null) {
      notes.push({
        slot,
        kind: "move",
        raw: rawMove,
        message: `Could not resolve move "${rawMove}" — dropped.`,
      });
      continue;
    }
    moves.push(moveSlug);
  }

  // nature — validated against the fixed 25, not the index.
  let nature: string | null = null;
  if (set.nature && set.nature.trim()) {
    const natureSlug = slugify(set.nature);
    if (NATURE_SLUGS.has(natureSlug)) {
      nature = natureSlug;
    } else {
      notes.push({
        slot,
        kind: "nature",
        raw: set.nature,
        message: `Unknown nature "${set.nature}" — left empty.`,
      });
    }
  }

  // tera type — resolves against the `type` kind in the index.
  let teraType: string | null = null;
  if (set.teraType && set.teraType.trim()) {
    teraType = resolveSlug(resolver, "type", set.teraType);
    if (teraType === null) {
      notes.push({
        slot,
        kind: "tera",
        raw: set.teraType,
        message: `Could not resolve Tera type "${set.teraType}" — left empty.`,
      });
    }
  }

  const member: TeamMember = {
    species,
    ability,
    item,
    moves,
    nature,
    evs: toStatSpread(set.evs, DEFAULT_EV),
    ivs: toStatSpread(set.ivs, DEFAULT_IV),
    tera_type: teraType,
    level:
      typeof set.level === "number" && Number.isFinite(set.level)
        ? set.level
        : DEFAULT_LEVEL,
  };

  // Cosmetics — round-tripped, not competitively significant (BR-T1).
  if (set.name && set.name.trim()) member.nickname = set.name;
  if (set.gender === "M" || set.gender === "F" || set.gender === "N") {
    member.gender = set.gender;
  }
  if (set.shiny === true) member.shiny = true;

  return member;
}

/**
 * Parse a Showdown paste and map it to `TeamMember[]`, never aborting on a bad
 * entry (BR-T11). Unresolved names become {@link ImportNote}s with the matching
 * member field left empty; everything resolvable still imports (AC-10.2).
 * Out-of-range / illegal-but-named values are preserved verbatim (AC-10.3) —
 * legality is `validate-team`'s warn-only concern.
 */
export async function importPaste(
  paste: string,
  format: Format,
  db: PokebotDb,
): Promise<{ members: TeamMember[]; notes: ImportNote[] }> {
  const sets = parseShowdown(paste);
  if (sets.length === 0) return { members: [], notes: [] };

  const resolver = await buildResolver(format, db);
  const notes: ImportNote[] = [];
  const members = sets.map((set, slot) => mapSet(set, slot, resolver, notes));

  return { members, notes };
}

/** Map a TeamMember (slugs) back to a Showdown set (display names) for export. */
function memberToSet(member: TeamMember, resolver: Resolver): ShowdownSet {
  const display = (kind: IndexKind, slug: string | null): string =>
    slug ? resolver.display[kind].get(slug) ?? humanize(slug) : "";

  const set: ShowdownSet = {
    name: member.nickname ?? "",
    species: display("pokemon", member.species),
    item: display("item", member.item),
    ability: display("ability", member.ability),
    moves: member.moves.map((m) => display("move", m)),
    nature: member.nature ? humanize(member.nature) : "",
    gender: member.gender ?? "",
    evs: { ...member.evs },
    ivs: { ...member.ivs },
    level: member.level,
  };

  if (member.tera_type) set.teraType = display("type", member.tera_type);
  if (member.shiny) set.shiny = true;

  return set;
}

/**
 * Serialize `TeamMember[]` to a Showdown paste, round-tripping every represented
 * field including cosmetics (AC-11.1/11.2). Slugs are mapped back to display
 * names via the index (falling back to a humanized slug for anything not in the
 * index, so export never throws on an off-index entry).
 */
export async function exportPaste(
  members: TeamMember[],
  format: Format,
  db: PokebotDb,
): Promise<string> {
  if (!members || members.length === 0) return "";
  const resolver = await buildResolver(format, db);
  const sets = members.map((m) => memberToSet(m, resolver));
  return serializeShowdown(sets);
}
