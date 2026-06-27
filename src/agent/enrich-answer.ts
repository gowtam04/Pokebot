/**
 * Server-side answer enrichment — makes Pokémon sprites/dex MODEL-INDEPENDENT.
 *
 * The agent's `submit_answer` payload carries `sprite_url`/`dex_number` only if
 * the model bothered to copy them out of the tool results; weaker models (e.g.
 * Grok 4.3) omit them, so the answer renders no sprite card and an iconless
 * candidate table. This pass runs AFTER schema validation and backfills
 * `sprite_url` + `dex_number` + `types` into every candidate row and subject from
 * the index for the active format. For a single-entity answer that has no
 * `subjects[]` at all, it synthesizes one subject from the `get_pokemon` profile
 * the turn already fetched (so the sprite card still renders).
 *
 * Provider-agnostic (fixes Grok and GPT-5.5; a no-op for an answer Claude already
 * filled). It NEVER throws and NEVER weakens an answer: any failure — or an
 * enriched payload that fails re-validation — returns the original answer
 * unchanged. It only ADDS missing fields; it never overwrites a value the model
 * supplied (e.g. base_stats copied verbatim).
 */

import { formatForMode, type Format } from "@/data/formats";
import {
  getPokemon,
  spriteRefsByNames,
  type SpriteRef,
} from "@/data/repos/pokedex-repo";
import { resolveEntity } from "@/data/repos/resolve-index";
import type { PokebotDb } from "@/data/db";
import {
  pokebotAnswerSchema,
  TYPE_NAMES,
  type Candidates,
  type PokebotAnswer,
  type PokemonProfile,
  type Subject,
  type TypeName,
} from "@/agent/schemas";
import type { AgentContext } from "@/agent/types";

const TYPE_SET = new Set<string>(TYPE_NAMES);

/** Keep only the 18 canonical type slugs (subjects/candidate rows are enum-typed). */
function asTypeNames(types: string[]): TypeName[] {
  return types.filter((t): t is TypeName => TYPE_SET.has(t));
}

/**
 * Backfill sprites/dex/types into a validated answer and (for a lone-entity
 * answer) synthesize a subject from the turn's looked-up profiles.
 */
export async function enrichAnswer(
  answer: PokebotAnswer,
  ctx: AgentContext,
  lookedUpProfiles: PokemonProfile[],
): Promise<PokebotAnswer> {
  try {
    const format = formatForMode(ctx.mode);
    const db = ctx.db as unknown as PokebotDb;

    const candidateNames = answer.candidates?.shown.map((r) => r.name) ?? [];
    const subjectNames = answer.subjects?.map((s) => s.name) ?? [];
    const names = [...candidateNames, ...subjectNames];

    const refs =
      names.length > 0
        ? await spriteRefsByNames(names, format, db)
        : new Map<string, SpriteRef>();

    // Tier-3: anything the batch query missed → fuzzy resolve + single read.
    for (const name of new Set(names)) {
      if (refs.has(name)) continue;
      const ref = await refByFuzzy(name, format, db);
      if (ref) refs.set(name, ref);
    }

    const candidates = answer.candidates
      ? enrichCandidates(answer.candidates, refs)
      : undefined;

    let subjects = answer.subjects
      ? enrichSubjects(answer.subjects, refs)
      : undefined;

    // Auto-derive subjects[] for a single-entity answer that omitted it (the
    // "Does Fake Out work on Farigiraf?" case): exactly one fetched profile and
    // no candidate list → render its sprite card.
    if (
      (!subjects || subjects.length === 0) &&
      !answer.candidates &&
      lookedUpProfiles.length === 1
    ) {
      subjects = [subjectFromProfile(lookedUpProfiles[0]!)];
    }

    const enriched: PokebotAnswer = { ...answer };
    if (candidates) enriched.candidates = candidates;
    if (subjects && subjects.length > 0) enriched.subjects = subjects;

    // Safety net: only adopt the enriched answer if it still validates.
    return pokebotAnswerSchema.parse(enriched);
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "answer_enrichment_failed",
    );
    return answer;
  }
}

/** Fuzzy fallback: resolve the name to a slug, then read that profile's refs. */
async function refByFuzzy(
  name: string,
  format: Format,
  db: PokebotDb,
): Promise<SpriteRef | null> {
  try {
    const res = await resolveEntity(name, "pokemon", 1, format);
    const slug = res.matches[0]?.slug;
    if (!slug) return null;
    const profile = await getPokemon(slug, format, db);
    if (!profile.found) return null;
    return {
      sprite_url: profile.sprite_url,
      dex_number: profile.national_dex_number,
      types: profile.types,
    };
  } catch {
    return null;
  }
}

function enrichCandidates(
  candidates: Candidates,
  refs: Map<string, SpriteRef>,
): Candidates {
  return {
    ...candidates,
    shown: candidates.shown.map((row) => {
      const ref = refs.get(row.name);
      const next = ref
        ? {
            ...row,
            sprite_url: row.sprite_url ?? ref.sprite_url,
            dex_number: row.dex_number ?? ref.dex_number,
            types: row.types.length > 0 ? row.types : asTypeNames(ref.types),
          }
        : { ...row };
      // Drop the empty key_stats:{} junk some models emit (P4g).
      if (next.key_stats && Object.keys(next.key_stats).length === 0) {
        delete next.key_stats;
      }
      return next;
    }),
  };
}

function enrichSubjects(
  subjects: Subject[],
  refs: Map<string, SpriteRef>,
): Subject[] {
  return subjects.map((s) => {
    const ref = refs.get(s.name);
    if (!ref) return s;
    return {
      ...s,
      sprite_url: s.sprite_url || ref.sprite_url,
      dex_number: s.dex_number ?? ref.dex_number,
      types: s.types.length > 0 ? s.types : asTypeNames(ref.types),
    };
  });
}

function subjectFromProfile(p: PokemonProfile): Subject {
  return {
    name: p.display_name,
    dex_number: p.national_dex_number,
    sprite_url: p.sprite_url,
    types: asTypeNames(p.types),
    is_fallback: !p.is_gen9_native,
    source_generation: p.source_generation ?? undefined,
  };
}
