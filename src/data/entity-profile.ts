/**
 * src/data/entity-profile.ts — the artifact viewer's full-profile assembler (B-4).
 *
 * `assembleEntityProfile(kind, slug, format, db)` is the single composition point
 * behind `GET /api/entity`. It reads the existing format-scoped index through the
 * repo layer (the sole DB readers, per CLAUDE.md) and assembles the full profile a
 * full-screen artifact needs — data that the `OakAnswer` payload does not
 * carry (BR-AV-3): a Pokémon's combined defensive grid (via the shared
 * `type-chart` formula) and grouped movepool, an ability's roster of holders.
 *
 * It NEVER throws for in-domain failures (BR-AV-5, NFR-2): an empty/unbuilt index
 * → `unavailable`; an unresolved slug → `not_found` (with suggestions); otherwise
 * `ok` with grounding chrome (format/generation tag, fallback flag, citations).
 *
 * `server-only`: it imports the repo layer and must never reach a client bundle.
 */

import "server-only";

import { eq } from "drizzle-orm";

import type { OakDb } from "@/data/db";
import { CHAMPIONS_REGULATION, type Format } from "@/data/formats";
import { ingest_meta } from "@/data/schema";
import type {
  AbilityDetail,
  ItemDetail,
  MoveDetail,
  TypeMatchupsDetail,
} from "@/agent/schemas";
import {
  combineDefensive,
  type DefensiveProfile,
} from "@/agent/formulas/type-chart";
import {
  getPokemon,
  pokemonWithAbility,
} from "@/data/repos/pokedex-repo";
import {
  movesForPokemon,
  type LearnedMove,
} from "@/data/repos/learnset-repo";
import {
  getReference,
  moveSummaries,
  type GetReferenceResult,
  type MoveSummary,
  type RefRecord,
} from "@/data/repos/reference-cache";
import type {
  EntityArtifactResponse,
  EntityKind,
  MovepoolGroup,
  MovepoolMove,
} from "@/lib/entity-artifact";

// ---------------------------------------------------------------------------
// Grounding helpers
// ---------------------------------------------------------------------------

/** Human format/generation tag shown on every artifact (AV-US-9). */
function generationLabel(format: Format): string {
  return format === "champions"
    ? `Champions — ${CHAMPIONS_REGULATION}`
    : "Scarlet/Violet (Gen 9)";
}

/** Short, readable format name for fallback notes. */
function formatName(format: Format): string {
  return format === "champions" ? "Champions" : "Scarlet/Violet";
}

/** Title-case a slug ("rough-skin" → "Rough Skin", "ground" → "Ground"). */
function titleCase(slug: string): string {
  return slug
    .split(/[-\s]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function isFoundRecord(ref: GetReferenceResult): ref is RefRecord {
  return "found" in ref && ref.found === true;
}

function suggestionsOf(ref: GetReferenceResult): string[] {
  return "suggestions" in ref ? ref.suggestions : [];
}

// ---------------------------------------------------------------------------
// Movepool grouping (level-up / TM / tutor / other)
// ---------------------------------------------------------------------------

const METHOD_LABEL: Record<string, string> = {
  "level-up": "Level-up",
  machine: "TM/HM",
  tutor: "Tutor",
};
/** Display order of the known learn methods; unknown labels sort after, alpha. */
const METHOD_ORDER = ["Level-up", "TM/HM", "Tutor"];

function methodLabel(method: string | null): string {
  if (!method) return "Other";
  return METHOD_LABEL[method] ?? titleCase(method);
}

function groupMovepool(
  learned: LearnedMove[],
  summaries: Map<string, MoveSummary>,
): MovepoolGroup[] {
  const byMethod = new Map<string, MovepoolMove[]>();
  for (const { moveSlug, method } of learned) {
    const label = methodLabel(method);
    const summary = summaries.get(moveSlug);
    const move: MovepoolMove = {
      slug: moveSlug,
      display_name: summary?.displayName ?? titleCase(moveSlug),
      type: summary?.type ?? "",
    };
    const bucket = byMethod.get(label);
    if (bucket) bucket.push(move);
    else byMethod.set(label, [move]);
  }

  const extraLabels = [...byMethod.keys()]
    .filter((l) => !METHOD_ORDER.includes(l))
    .sort();
  const groups: MovepoolGroup[] = [];
  for (const label of [...METHOD_ORDER, ...extraLabels]) {
    const moves = byMethod.get(label);
    if (!moves || moves.length === 0) continue;
    moves.sort((a, b) => a.display_name.localeCompare(b.display_name));
    groups.push({ method: label, moves });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Index availability
// ---------------------------------------------------------------------------

/**
 * Whether the index for `format` has been built (an `ingest_meta` row exists) —
 * the same signal `query_pokedex` uses. A missing row or unreadable table reads
 * as unavailable (→ `unavailable` envelope, never a thrown error).
 */
export async function isIndexAvailable(
  format: Format,
  db: OakDb,
): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(ingest_meta)
      .where(eq(ingest_meta.format, format))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the full entity-detail artifact for `(kind, slug)` in `format`.
 * `slug` is expected to be canonical (the route resolves the user's query via
 * `resolveEntity` first). Returns `ok` | `not_found` | `unavailable`.
 */
export async function assembleEntityProfile(
  kind: EntityKind,
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  if (!(await isIndexAvailable(format, db))) {
    return { status: "unavailable", kind, format };
  }
  switch (kind) {
    case "pokemon":
      return assemblePokemon(slug, format, db);
    case "move":
      return assembleMove(slug, format, db);
    case "ability":
      return assembleAbility(slug, format, db);
    case "item":
      return assembleItem(slug, format, db);
    case "type":
      return assembleType(slug, format, db);
  }
}

async function assemblePokemon(
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  const profile = await getPokemon(slug, format, db);
  if (!profile.found) {
    return {
      status: "not_found",
      kind: "pokemon",
      format,
      query: slug,
      suggestions: profile.suggestions,
    };
  }

  // Combined defensive grid from each of the species' types (shared formula).
  const defensives: DefensiveProfile[] = [];
  for (const t of profile.types) {
    const ref = await getReference("type", t, format, { db });
    if (isFoundRecord(ref) && "defensive" in ref) {
      defensives.push((ref as TypeMatchupsDetail).defensive);
    }
  }
  const matchups = combineDefensive(defensives);

  // Full movepool, grouped by learn method, names/types hydrated in one read.
  const learned = await movesForPokemon(slug, format, db);
  const summaries = await moveSummaries(
    learned.map((m) => m.moveSlug),
    format,
    db,
  );
  const movepool = groupMovepool(learned, summaries);

  const { found: _found, ...rest } = profile;
  const isFallback = !profile.is_gen9_native;

  return {
    status: "ok",
    kind: "pokemon",
    format,
    resolved: { slug, display_name: profile.display_name },
    generation: generationLabel(format),
    is_fallback: isFallback,
    ...(isFallback
      ? {
          fallback_note: `Not native to ${formatName(format)}; showing ${
            profile.source_generation ?? "earlier-generation"
          } data.`,
        }
      : {}),
    citations: [
      {
        source: `pokemon/${slug}`,
        detail: "Typing, base stats, abilities, sprite, and learnset.",
      },
    ],
    data: { ...rest, matchups, movepool },
  };
}

async function assembleMove(
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  const ref = await getReference("move", slug, format, { db });
  if (!isFoundRecord(ref)) {
    return {
      status: "not_found",
      kind: "move",
      format,
      query: slug,
      suggestions: suggestionsOf(ref),
    };
  }
  const { found: _found, ...data } = ref as MoveDetail;
  return {
    status: "ok",
    kind: "move",
    format,
    resolved: { slug, display_name: (ref as MoveDetail).display_name },
    generation: generationLabel(format),
    is_fallback: false,
    citations: [
      {
        source: `move/${slug}`,
        detail: "Type, category, power, accuracy, PP, priority, and effect.",
      },
    ],
    data,
  };
}

async function assembleAbility(
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  const ref = await getReference("ability", slug, format, { db });
  if (!isFoundRecord(ref)) {
    return {
      status: "not_found",
      kind: "ability",
      format,
      query: slug,
      suggestions: suggestionsOf(ref),
    };
  }
  const { found: _found, ...base } = ref as AbilityDetail;
  const holders = await pokemonWithAbility(slug, format, db);
  return {
    status: "ok",
    kind: "ability",
    format,
    resolved: { slug, display_name: (ref as AbilityDetail).display_name },
    generation: generationLabel(format),
    is_fallback: false,
    citations: [{ source: `ability/${slug}`, detail: "Effect text." }],
    data: {
      ...base,
      learned_by: holders.map((h) => ({
        slug: h.slug,
        display_name: h.displayName,
      })),
    },
  };
}

async function assembleItem(
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  const ref = await getReference("item", slug, format, { db });
  if (!isFoundRecord(ref)) {
    return {
      status: "not_found",
      kind: "item",
      format,
      query: slug,
      suggestions: suggestionsOf(ref),
    };
  }
  const { found: _found, ...data } = ref as ItemDetail;
  return {
    status: "ok",
    kind: "item",
    format,
    resolved: { slug, display_name: (ref as ItemDetail).display_name },
    generation: generationLabel(format),
    is_fallback: false,
    citations: [{ source: `item/${slug}`, detail: "Held-item effect." }],
    data,
  };
}

async function assembleType(
  slug: string,
  format: Format,
  db: OakDb,
): Promise<EntityArtifactResponse> {
  const ref = await getReference("type", slug, format, { db });
  if (!isFoundRecord(ref) || !("defensive" in ref)) {
    return {
      status: "not_found",
      kind: "type",
      format,
      query: slug,
      suggestions: suggestionsOf(ref),
    };
  }
  const { found: _found, ...data } = ref as TypeMatchupsDetail;
  return {
    status: "ok",
    kind: "type",
    format,
    resolved: { slug, display_name: titleCase(slug) },
    generation: generationLabel(format),
    is_fallback: false,
    citations: [
      {
        source: `type/${slug}`,
        detail: "Offensive and defensive type matchups.",
      },
    ],
    data,
  };
}
