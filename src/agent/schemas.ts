/**
 * Cross-phase contract surface — Zod schemas (single source of truth, A5).
 *
 * This module is the ONLY definition of:
 *  - the input/output shapes for all 11 tools (T1..T11, tools.md), and
 *  - the `OakAnswer` object emitted by `submit_answer` (T11 / output-formats.md).
 *
 * TS types are inferred from these schemas; the Anthropic SDK tool `input_schema`
 * values and the `submit_answer` JSON Schema are GENERATED from them via
 * zod-to-json-schema (zod@3 + zod-to-json-schema — the supported pairing).
 *
 * Tool names and output field names match tools.md / output-formats.md exactly —
 * the model depends on them; never rename.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { teamMembersSchema } from "@/data/teams/team-schema";
// Type-only — erased at compile, so this shared module never pulls the
// server-only active-team service (or its repos) into a client bundle.
import type { EnrichedActiveTeam } from "@/server/teams/active-team";

// ---------------------------------------------------------------------------
// Shared enums / leaf schemas
// ---------------------------------------------------------------------------

/** The 18 canonical type slugs (output-formats.md `definitions.typeName`). */
export const TYPE_NAMES = [
  "normal",
  "fire",
  "water",
  "electric",
  "grass",
  "ice",
  "fighting",
  "poison",
  "ground",
  "flying",
  "psychic",
  "bug",
  "rock",
  "ghost",
  "dragon",
  "dark",
  "steel",
  "fairy",
] as const;

export const typeNameSchema = z.enum(TYPE_NAMES);

/** Stat keys usable in query_pokedex filters/sort (tools.md T2). */
export const STAT_KEYS = [
  "hp",
  "attack",
  "defense",
  "special_attack",
  "special_defense",
  "speed",
  "base_stat_total",
] as const;

export const statKeySchema = z.enum(STAT_KEYS);

/** Entity kinds resolvable by T1 / present in searchable_names. */
export const ENTITY_KINDS = [
  "pokemon",
  "move",
  "ability",
  "type",
  "item",
] as const;

export const entityKindSchema = z.enum(ENTITY_KINDS);

/** Six-stat block shared by query_pokedex rows and get_pokemon. */
export const baseStatsSchema = z.object({
  hp: z.number().int(),
  attack: z.number().int(),
  defense: z.number().int(),
  special_attack: z.number().int(),
  special_defense: z.number().int(),
  speed: z.number().int(),
});

/**
 * Ability block. `slot1` is always present; `slot2`/`hidden` may be absent (a
 * Pokémon with no second/hidden ability) or omitted entirely (tools.md T2/T3).
 */
export const abilitiesSchema = z.object({
  slot1: z.string(),
  slot2: z.string().nullish(),
  hidden: z.string().nullish(),
});

/**
 * A JSON scalar value (string | number | boolean | null) — the value type for the
 * free-form maps inside `submit_answer` (candidate `key_stats`, `damage_calc`
 * assumptions/result). Closed on purpose: `z.record(z.unknown())` generates an
 * open `additionalProperties: {}` in the tool's JSON Schema, which xAI's
 * always-strict tool-argument validator can reject at stream-open (and the loop's
 * Zod re-emit budget does NOT cover a request-time schema rejection). These maps
 * only ever hold scalars, so a typed value schema keeps them permissive while
 * emitting a concrete `additionalProperties` xAI accepts.
 */
export const jsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// ===========================================================================
// T1 — resolve_entity
// ===========================================================================

export const resolveEntityInputSchema = z.object({
  query: z.string(),
  kind: z
    .enum(["pokemon", "move", "ability", "type", "item", "any"])
    .default("any"),
  limit: z.number().int().min(1).max(10).default(5),
});

export const resolveEntityOutputSchema = z.object({
  matches: z.array(
    z.object({
      kind: entityKindSchema,
      slug: z.string(),
      display_name: z.string(),
      score: z.number(),
    }),
  ),
});

// ===========================================================================
// T2 — query_pokedex (the workhorse)
// ===========================================================================

export const statFilterSchema = z.object({
  stat: statKeySchema,
  op: z.enum([">", ">=", "<", "<=", "=="]),
  value: z.number().int(),
});

export const queryPokedexInputSchema = z.object({
  types: z.array(z.string()).optional(),
  abilities: z.array(z.string()).optional(),
  moves: z.array(z.string()).optional(),
  stat_filters: z.array(statFilterSchema).optional(),
  sort_by: statKeySchema.or(z.literal("national_dex_number")).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  // Default 50 (was 20): a 20-row default silently truncated common
  // intersection queries (e.g. 23 results → "20 of 23"). Max stays 100.
  limit: z.number().int().min(1).max(100).default(50),
});

/** One row in a query_pokedex result set. */
export const pokedexRowSchema = z.object({
  display_name: z.string(),
  national_dex_number: z.number().int(),
  types: z.array(z.string()),
  abilities: abilitiesSchema,
  base_stats: baseStatsSchema,
  base_stat_total: z.number().int(),
  sprite_url: z.string(),
  is_gen9_native: z.boolean(),
  source_generation: z.string().nullish(),
});

/** Successful query result. */
export const queryPokedexResultSchema = z.object({
  total_count: z.number().int(),
  truncated: z.boolean(),
  sort: z.string().nullable(),
  results: z.array(pokedexRowSchema),
});

/** Full output union: success | index unavailable | unresolved slugs. */
export const queryPokedexOutputSchema = z.union([
  queryPokedexResultSchema,
  z.object({ error: z.literal("index_unavailable") }),
  z.object({ unresolved: z.array(z.string()) }),
]);

// ===========================================================================
// T3 — get_pokemon
// ===========================================================================

export const getPokemonInputSchema = z.object({
  name: z.string(),
});

export const pokemonProfileSchema = z.object({
  found: z.literal(true),
  display_name: z.string(),
  national_dex_number: z.number().int(),
  types: z.array(z.string()),
  abilities: abilitiesSchema,
  base_stats: baseStatsSchema,
  base_stat_total: z.number().int(),
  sprite_url: z.string(),
  artwork_url: z.string(),
  forms: z.array(z.string()),
  is_gen9_native: z.boolean(),
  source_generation: z.string().nullish(),
});

/** Generic "not found, here are close names" miss shape (BR-9). */
export const notFoundSchema = z.object({
  found: z.literal(false),
  suggestions: z.array(z.string()),
});

/** PokeAPI-down miss shape for read-through-cache tools. */
export const upstreamUnavailableSchema = z.object({
  error: z.literal("upstream_unavailable"),
});

export const getPokemonOutputSchema = z.union([
  pokemonProfileSchema,
  notFoundSchema,
]);

// ===========================================================================
// T4 — get_move
// ===========================================================================

export const getMoveInputSchema = z.object({
  name: z.string(),
  include_gen9_learner_count: z.boolean().default(false),
});

export const moveDetailSchema = z.object({
  found: z.literal(true),
  display_name: z.string(),
  type: z.string(),
  damage_class: z.enum(["physical", "special", "status"]),
  power: z.number().int().nullable(),
  accuracy: z.number().int().nullable(),
  pp: z.number().int().nullable(),
  priority: z.number().int(),
  target: z.string(),
  hits_allies: z.boolean().optional(),
  spread_modifier_doubles: z.number().nullable().optional(),
  effect_short: z.string(),
  effect_full: z.string(),
  gen9_learner_count: z.number().int().optional(),
});

export const getMoveOutputSchema = z.union([
  moveDetailSchema,
  notFoundSchema,
  upstreamUnavailableSchema,
]);

// ===========================================================================
// T5 — get_ability
// ===========================================================================

export const getAbilityInputSchema = z.object({
  name: z.string(),
});

export const abilityDetailSchema = z.object({
  found: z.literal(true),
  display_name: z.string(),
  effect_short: z.string(),
  effect_full: z.string(),
});

export const getAbilityOutputSchema = z.union([
  abilityDetailSchema,
  notFoundSchema,
  upstreamUnavailableSchema,
]);

// ===========================================================================
// T6 — get_type_matchups
// ===========================================================================

export const getTypeMatchupsInputSchema = z.object({
  types: z.array(z.string()).min(1).max(2),
});

export const typeMatchupsDetailSchema = z.object({
  found: z.literal(true),
  types: z.array(z.string()),
  // Offensive profile is present for a single type; omitted for a two-type
  // combined defensive request (tools.md T6).
  offensive: z
    .object({
      super_effective_against: z.array(z.string()),
      not_very_effective_against: z.array(z.string()),
      no_effect_against: z.array(z.string()),
    })
    .optional(),
  defensive: z.object({
    weak_to: z.array(z.string()),
    resists: z.array(z.string()),
    immune_to: z.array(z.string()),
  }),
});

export const getTypeMatchupsOutputSchema = z.union([
  typeMatchupsDetailSchema,
  notFoundSchema,
  upstreamUnavailableSchema,
]);

// ===========================================================================
// T7 — get_evolution_chain
// ===========================================================================

export const getEvolutionChainInputSchema = z.object({
  species: z.string(),
});

/**
 * One evolution edge. `trigger` is always present; the remaining condition
 * fields vary by trigger (item, min_happiness, time_of_day, min_level, …), so
 * additional keys are allowed (tools.md T7 — "as provided by PokeAPI").
 */
export const evolutionConditionSchema = z
  .object({ trigger: z.string() })
  .passthrough();

export const evolutionChainDetailSchema = z.object({
  found: z.literal(true),
  chain: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      conditions: z.array(evolutionConditionSchema),
    }),
  ),
});

export const getEvolutionChainOutputSchema = z.union([
  evolutionChainDetailSchema,
  notFoundSchema,
  upstreamUnavailableSchema,
]);

// ===========================================================================
// T8 — get_item
// ===========================================================================

export const getItemInputSchema = z.object({
  name: z.string(),
});

export const itemDetailSchema = z.object({
  found: z.literal(true),
  display_name: z.string(),
  effect_short: z.string(),
  effect_full: z.string(),
  held_by_wild: z
    .array(
      z.object({
        pokemon: z.string(),
        rarity_percent: z.number(),
      }),
    )
    .optional(),
});

export const getItemOutputSchema = z.union([
  itemDetailSchema,
  notFoundSchema,
  upstreamUnavailableSchema,
]);

// ===========================================================================
// T9 — compute_stat
// ===========================================================================

export const computeStatInputSchema = z.object({
  base_stat: z.number().int(),
  is_hp: z.boolean().default(false),
  iv: z.number().int().min(0).max(31).default(31),
  ev: z.number().int().min(0).max(252).default(0),
  level: z.number().int().min(1).max(100).default(50),
  nature_effect: z.enum(["boosted", "neutral", "hindered"]).default("neutral"),
});

export const invalidInputSchema = z.object({
  error: z.literal("invalid_input"),
  detail: z.string(),
});

export const computeStatResultSchema = z.object({
  value: z.number().int(),
  breakdown: z.string(),
  inputs_echo: z.record(z.unknown()),
});

export const computeStatOutputSchema = z.union([
  computeStatResultSchema,
  invalidInputSchema,
]);

// ===========================================================================
// T10 — estimate_damage
// ===========================================================================

export const estimateDamageInputSchema = z.object({
  level: z.number().int().default(50),
  power: z.number().int(),
  attack_stat: z.number().int(),
  defense_stat: z.number().int(),
  stab: z.boolean().default(false),
  type_effectiveness: z.number().default(1),
  other_modifier: z.number().default(1),
});

export const estimateDamageResultSchema = z.object({
  min_damage: z.number().int(),
  max_damage: z.number().int(),
  is_estimate: z.literal(true),
  breakdown: z.string(),
  inputs_echo: z.record(z.unknown()),
});

export const estimateDamageOutputSchema = z.union([
  estimateDamageResultSchema,
  invalidInputSchema,
]);

// ===========================================================================
// T11 — submit_answer / OakAnswer (output-formats.md)
// ===========================================================================

// OakAnswer sub-objects are `.strict()` so runtime validation rejects
// unknown keys — mirroring `additionalProperties: false` in the generated JSON
// Schema (output-formats.md). Free-form objects (assumptions/result/key_stats)
// stay open via z.record.
export const citationSchema = z
  .object({
    source: z.string(),
    detail: z.string(),
    endpoint_url: z.string().optional(),
  })
  .strict();

export const inferenceSchema = z
  .object({
    claim: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    note: z.string().optional(),
  })
  .strict();

export const generationBasisSchema = z
  .object({
    generation: z.string(),
    fallback: z.boolean(),
    note: z.string().optional(),
  })
  .strict();

export const subjectSchema = z
  .object({
    name: z.string(),
    dex_number: z.number().int().optional(),
    sprite_url: z.string(),
    types: z.array(typeNameSchema),
    is_fallback: z.boolean(),
    source_generation: z.string().optional(),
  })
  .strict();

export const candidateRowSchema = z
  .object({
    name: z.string(),
    dex_number: z.number().int().optional(),
    sprite_url: z.string().optional(),
    types: z.array(typeNameSchema),
    // The full six-stat block, copied verbatim from the query_pokedex result.
    // Rendered in fixed order (HP, Attack, Defense, SpA, SpD, Speed). Optional +
    // strict keeps older `key_stats`-only payloads valid (CandidateTable falls
    // back to key_stats when base_stats is absent).
    base_stats: baseStatsSchema.optional(),
    key_stats: z.record(jsonScalarSchema).optional(),
    ability: z.string().optional(),
  })
  .strict();

export const candidatesSchema = z
  .object({
    total_count: z.number().int(),
    truncated: z.boolean(),
    sort: z.string().nullable().optional(),
    shown: z.array(candidateRowSchema),
  })
  .strict();

export const damageCalcSchema = z
  .object({
    assumptions: z.record(jsonScalarSchema),
    result: z.record(jsonScalarSchema),
    is_estimate: z.literal(true),
    breakdown: z.string().optional(),
  })
  .strict();

// A single selectable option in a `question` (the "ask the user" affordance).
// `label` is sent verbatim as the next user message when the option is clicked,
// so it must read as the user's reply (e.g. "Singles", "Doubles"). `description`
// is optional helper text shown under the label.
export const questionOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();

// Present on a `clarification_needed` answer when the agent stops to ask a
// focused question. The UI renders `options` as clickable buttons; the
// always-present composer covers the free-text path. 2-4 mutually-exclusive
// choices keep the affordance meaningful (a wider/narrower set is a prompt bug).
export const questionSchema = z
  .object({
    options: z.array(questionOptionSchema).min(2).max(4),
  })
  .strict();

// The agent's proposed team (TEAM-AD-6) — a buildable team the user can Apply.
// Extracted as a named schema so the `proposed_team` answer field, the
// `save_team` tool input, and `ctx.proposedTeam` all share one definition.
export const proposedTeamSchema = z
  .object({
    name: z.string(),
    format: z.enum(["scarlet-violet", "champions"]),
    members: teamMembersSchema,
  })
  .strict();

// A reference to a team the agent SAVED this turn via `save_team` (T13). The
// route stamps this onto the answer authoritatively (server-owned id), so the
// UI can render a persistent "Saved ✓ — open in viewer" card and the model
// never has to copy a UUID.
export const savedTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    format: z.enum(["scarlet-violet", "champions"]),
  })
  .strict();

export const oakAnswerSchema = z
  .object({
    status: z.enum([
      "answered",
      "clarification_needed",
      "resolution_failed",
      "insufficient_data",
    ]),
    answer_markdown: z.string(),
    reasoning_markdown: z.string(),
    citations: z.array(citationSchema),
    inferences: z.array(inferenceSchema),
    generation_basis: generationBasisSchema,
    subjects: z.array(subjectSchema).optional(),
    candidates: candidatesSchema.optional(),
    damage_calc: damageCalcSchema.optional(),
    suggestions: z.array(z.string()).optional(),
    question: questionSchema.optional(),
    uncertainty_flags: z.array(z.string()).optional(),
    // The agent's proposed team (TEAM-AD-6). ADDITIVE optional field: previously
    // stored answer_json (no `proposed_team` key) stays valid under `.strict()`,
    // and a new answer carries a buildable team the user can Apply (save-new /
    // apply-existing via the Teams API) OR approve in chat (the agent then calls
    // `save_team`, T13, to persist it — TEAM-AD-7).
    proposed_team: proposedTeamSchema.optional(),
    // The team the agent SAVED this turn (T13). ADDITIVE optional field, stamped
    // by the route from `ctx.savedTeam` after a successful `save_team` call —
    // never emitted by the model. Drives the persistent "Saved ✓" card.
    saved_team: savedTeamSchema.optional(),
  })
  .strict();

// ===========================================================================
// T12 — get_active_team (inlined team-builder internal; reconciled in Phase 11)
// ===========================================================================

// Input takes NO team-selecting argument: the active team is server-bound onto
// AgentContext (the exact analogue of `mode`), so the model has no parameter to
// widen scope. `.strict()` rejects any stray key the model might invent.
export const getActiveTeamInputSchema = z.object({}).strict();

/**
 * Output of `get_active_team`: `{ active: false }` when no team is bound for the
 * turn, else the enriched team view (display names + computed warnings). Hand-
 * authored as a discriminated union — the enriched shape is owned by the
 * active-team service, not re-derived here.
 */
export type GetActiveTeamInput = z.infer<typeof getActiveTeamInputSchema>;
export type GetActiveTeamOutput =
  | { active: false }
  | { active: true; team: EnrichedActiveTeam };

// ===========================================================================
// T13 — save_team (conversational save; TEAM-AD-7)
// ===========================================================================

// Persists a team to the user's saved Teams on explicit user approval. Prefers
// the server-bound proposed team for the turn (`ctx.proposedTeam`, the exact set
// the user saw) so EVs/IVs/moves are never re-typed by the model; `team` is the
// fallback for a build-AND-save in one message (no prior proposal in context).
// `name` optionally overrides the saved team's name. `.strict()` rejects strays.
export const saveTeamInputSchema = z
  .object({
    name: z.string().optional(),
    team: proposedTeamSchema.optional(),
  })
  .strict();

export type SaveTeamInput = z.infer<typeof saveTeamInputSchema>;
/**
 * Output of `save_team`: the saved team's id + name + format on success, else a
 * structured miss (`not_signed_in` — guest; `no_team` — nothing to save;
 * `index_unavailable` — write fault). Never throws in-domain (tool contract).
 */
export type SaveTeamOutput =
  | { saved: true; team_id: string; name: string; format: string }
  | {
      saved: false;
      reason: "not_signed_in" | "no_team" | "index_unavailable";
    };

// ===========================================================================
// Inferred TypeScript types
// ===========================================================================

export type ResolveEntityInput = z.infer<typeof resolveEntityInputSchema>;
export type ResolveEntityOutput = z.infer<typeof resolveEntityOutputSchema>;
export type QueryPokedexInput = z.infer<typeof queryPokedexInputSchema>;
export type QueryPokedexResult = z.infer<typeof queryPokedexResultSchema>;
export type QueryPokedexOutput = z.infer<typeof queryPokedexOutputSchema>;
export type PokedexRow = z.infer<typeof pokedexRowSchema>;
export type GetPokemonInput = z.infer<typeof getPokemonInputSchema>;
export type PokemonProfile = z.infer<typeof pokemonProfileSchema>;
export type GetPokemonOutput = z.infer<typeof getPokemonOutputSchema>;
export type GetMoveInput = z.infer<typeof getMoveInputSchema>;
export type MoveDetail = z.infer<typeof moveDetailSchema>;
export type GetMoveOutput = z.infer<typeof getMoveOutputSchema>;
export type GetAbilityInput = z.infer<typeof getAbilityInputSchema>;
export type AbilityDetail = z.infer<typeof abilityDetailSchema>;
export type GetAbilityOutput = z.infer<typeof getAbilityOutputSchema>;
export type GetTypeMatchupsInput = z.infer<typeof getTypeMatchupsInputSchema>;
export type TypeMatchupsDetail = z.infer<typeof typeMatchupsDetailSchema>;
export type GetTypeMatchupsOutput = z.infer<typeof getTypeMatchupsOutputSchema>;
export type GetEvolutionChainInput = z.infer<
  typeof getEvolutionChainInputSchema
>;
export type EvolutionChainDetail = z.infer<typeof evolutionChainDetailSchema>;
export type GetEvolutionChainOutput = z.infer<
  typeof getEvolutionChainOutputSchema
>;
export type GetItemInput = z.infer<typeof getItemInputSchema>;
export type ItemDetail = z.infer<typeof itemDetailSchema>;
export type GetItemOutput = z.infer<typeof getItemOutputSchema>;
export type ComputeStatInput = z.infer<typeof computeStatInputSchema>;
export type ComputeStatOutput = z.infer<typeof computeStatOutputSchema>;
export type EstimateDamageInput = z.infer<typeof estimateDamageInputSchema>;
export type EstimateDamageOutput = z.infer<typeof estimateDamageOutputSchema>;
export type NotFound = z.infer<typeof notFoundSchema>;
export type UpstreamUnavailable = z.infer<typeof upstreamUnavailableSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Inference = z.infer<typeof inferenceSchema>;
export type GenerationBasis = z.infer<typeof generationBasisSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type Candidates = z.infer<typeof candidatesSchema>;
export type DamageCalc = z.infer<typeof damageCalcSchema>;
export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type ProposedTeam = z.infer<typeof proposedTeamSchema>;
export type SavedTeam = z.infer<typeof savedTeamSchema>;
export type TypeName = z.infer<typeof typeNameSchema>;
export type StatKey = z.infer<typeof statKeySchema>;
export type EntityKind = z.infer<typeof entityKindSchema>;

/** The single structured output the agent emits per turn (T11). */
export type OakAnswer = z.infer<typeof oakAnswerSchema>;

// ===========================================================================
// JSON-Schema generation for the Anthropic SDK
// ===========================================================================

/** A generated JSON Schema object (always `{ type: "object", ... }`). */
export type JsonSchema = Record<string, unknown>;

/**
 * Convert a Zod schema to a JSON Schema suitable for an Anthropic tool
 * `input_schema` / the `submit_answer` schema.
 *
 * Follows the project Zod->JSON-Schema directive:
 *  - `$refStrategy: "none"` so the result is fully inlined (no `$ref`/`$defs`),
 *  - `additionalProperties: false` is preserved (zod-to-json-schema default),
 *  - the `$schema` key is stripped,
 *  - the root is guaranteed to be `{ type: "object", ... }`.
 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const generated = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  delete generated.$schema;

  if (generated.type !== "object") {
    throw new Error(
      `toJsonSchema expected an object root, got: ${String(generated.type)}`,
    );
  }

  return generated;
}

/** Tool name -> input JSON Schema, in the T1..T11 order of tools.md. */
export const toolInputJsonSchemas: Record<string, JsonSchema> = {
  resolve_entity: toJsonSchema(resolveEntityInputSchema),
  query_pokedex: toJsonSchema(queryPokedexInputSchema),
  get_pokemon: toJsonSchema(getPokemonInputSchema),
  get_move: toJsonSchema(getMoveInputSchema),
  get_ability: toJsonSchema(getAbilityInputSchema),
  get_type_matchups: toJsonSchema(getTypeMatchupsInputSchema),
  get_evolution_chain: toJsonSchema(getEvolutionChainInputSchema),
  get_item: toJsonSchema(getItemInputSchema),
  compute_stat: toJsonSchema(computeStatInputSchema),
  estimate_damage: toJsonSchema(estimateDamageInputSchema),
  // submit_answer's input IS the OakAnswer object.
  submit_answer: toJsonSchema(oakAnswerSchema),
  // T12 — no team-selecting argument (server-bound active team).
  get_active_team: toJsonSchema(getActiveTeamInputSchema),
  // T13 — save a proposed team to the user's Teams on approval.
  save_team: toJsonSchema(saveTeamInputSchema),
};

/** The generated `submit_answer` (OakAnswer) JSON Schema. */
export const oakAnswerJsonSchema: JsonSchema =
  toolInputJsonSchemas.submit_answer;

/** Canonical tool name list (T1..T12), in order. */
export const TOOL_NAMES = [
  "resolve_entity",
  "query_pokedex",
  "get_pokemon",
  "get_move",
  "get_ability",
  "get_type_matchups",
  "get_evolution_chain",
  "get_item",
  "compute_stat",
  "estimate_damage",
  "submit_answer",
  "get_active_team",
  "save_team",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
