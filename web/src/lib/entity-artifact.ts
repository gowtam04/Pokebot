/**
 * Shared contract for the artifact viewer's entity-detail fetch (B-4, AV-US-1/3).
 *
 * `GET /api/entity` returns an `EntityArtifactResponse`; the client viewer reads
 * the same type. This module is the ONE definition both sides build to — it is
 * CLIENT-SAFE (pure Zod + inferred types, no `server-only`, no db/repos) so the
 * provider and renderers can import it under jsdom.
 *
 * Per-kind `data` shapes are COMPOSED from the existing entity schemas in
 * `@/agent/schemas` (the single source of truth for entity fields) — the `found`
 * discriminant is dropped (the envelope's `status` carries it) and the extra
 * fields a full profile needs (a Pokémon's combined defensive matchups + grouped
 * movepool, an ability's `learned_by`) are layered on (BR-AV-3, BR-AV-6).
 */

import { z } from "zod";

import {
  abilityDetailSchema,
  citationSchema,
  entityKindSchema,
  itemDetailSchema,
  moveDetailSchema,
  pokemonProfileSchema,
  typeMatchupsDetailSchema,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Scope + shared leaf shapes
// ---------------------------------------------------------------------------

/** Data scope, mirroring `Format` in `@/data/formats` (kept inline so this stays client-safe). */
export const formatSchema = z.enum(["scarlet-violet", "champions"]);

/** A combined (or single-type) defensive profile — reused for the Pokémon grid. */
export const defensiveProfileSchema = typeMatchupsDetailSchema.shape.defensive;

/** One move in a Pokémon's movepool — clickable, with its type badge (AV-US-5). */
export const movepoolMoveSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  type: z.string(),
});

/** Movepool grouped by learn method (level-up / machine / tutor / egg). */
export const movepoolGroupSchema = z.object({
  method: z.string(),
  moves: z.array(movepoolMoveSchema),
});

/** One species that has a given ability (ability artifact's `learned_by`). */
export const abilityHolderSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
});

// ---------------------------------------------------------------------------
// Per-kind `data` shapes (composed from @/agent/schemas, `found` dropped)
// ---------------------------------------------------------------------------

export const pokemonArtifactDataSchema = pokemonProfileSchema
  .omit({ found: true })
  .extend({
    /** Combined defensive matchups for the species' actual type(s). */
    matchups: defensiveProfileSchema,
    /** Full movepool for the active format, grouped by learn method. */
    movepool: z.array(movepoolGroupSchema),
  });

export const moveArtifactDataSchema = moveDetailSchema.omit({ found: true });

export const abilityArtifactDataSchema = abilityDetailSchema
  .omit({ found: true })
  .extend({ learned_by: z.array(abilityHolderSchema) });

export const itemArtifactDataSchema = itemDetailSchema.omit({ found: true });

export const typeArtifactDataSchema = typeMatchupsDetailSchema.omit({
  found: true,
});

// ---------------------------------------------------------------------------
// Response envelope (ok | not_found | unavailable)
// ---------------------------------------------------------------------------

/** Grounding chrome present on every `ok` artifact (BR-AV-6, AV-US-9/10). */
const okBaseSchema = z.object({
  status: z.literal("ok"),
  format: formatSchema,
  resolved: z.object({ slug: z.string(), display_name: z.string() }),
  generation: z.string(),
  is_fallback: z.boolean(),
  fallback_note: z.string().optional(),
  citations: z.array(citationSchema),
});

/** The `ok` envelope, discriminated by entity `kind` so `data` is type-safe. */
export const entityArtifactOkSchema = z.discriminatedUnion("kind", [
  okBaseSchema.extend({
    kind: z.literal("pokemon"),
    data: pokemonArtifactDataSchema,
  }),
  okBaseSchema.extend({
    kind: z.literal("move"),
    data: moveArtifactDataSchema,
  }),
  okBaseSchema.extend({
    kind: z.literal("ability"),
    data: abilityArtifactDataSchema,
  }),
  okBaseSchema.extend({
    kind: z.literal("item"),
    data: itemArtifactDataSchema,
  }),
  okBaseSchema.extend({
    kind: z.literal("type"),
    data: typeArtifactDataSchema,
  }),
]);

/** Resolution miss — the entity could not be resolved (AV-US-11, BR-AV-5). */
export const entityArtifactNotFoundSchema = z.object({
  status: z.literal("not_found"),
  kind: entityKindSchema,
  format: formatSchema,
  query: z.string(),
  suggestions: z.array(z.string()),
});

/** Index unavailable — honest failure, never fabricated data (BR-AV-5, NFR-2). */
export const entityArtifactUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  kind: entityKindSchema,
  format: formatSchema,
});

/** The full response union returned by `GET /api/entity`. */
export const entityArtifactResponseSchema = z.union([
  entityArtifactOkSchema,
  entityArtifactNotFoundSchema,
  entityArtifactUnavailableSchema,
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** The five entity kinds an artifact can show (re-export from schemas). */
export type EntityKind = z.infer<typeof entityKindSchema>;
export type ArtifactFormat = z.infer<typeof formatSchema>;

export type MovepoolMove = z.infer<typeof movepoolMoveSchema>;
export type MovepoolGroup = z.infer<typeof movepoolGroupSchema>;
export type AbilityHolder = z.infer<typeof abilityHolderSchema>;

export type PokemonArtifactData = z.infer<typeof pokemonArtifactDataSchema>;
export type MoveArtifactData = z.infer<typeof moveArtifactDataSchema>;
export type AbilityArtifactData = z.infer<typeof abilityArtifactDataSchema>;
export type ItemArtifactData = z.infer<typeof itemArtifactDataSchema>;
export type TypeArtifactData = z.infer<typeof typeArtifactDataSchema>;

export type EntityArtifactOk = z.infer<typeof entityArtifactOkSchema>;
export type EntityArtifactNotFound = z.infer<
  typeof entityArtifactNotFoundSchema
>;
export type EntityArtifactUnavailable = z.infer<
  typeof entityArtifactUnavailableSchema
>;
export type EntityArtifactResponse = z.infer<
  typeof entityArtifactResponseSchema
>;

/** Narrow an `ok` envelope to a specific kind (handy for renderer dispatch). */
export type EntityArtifactOkOf<K extends EntityKind> = Extract<
  EntityArtifactOk,
  { kind: K }
>;
