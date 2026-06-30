/**
 * Canonical OakAnswer fixtures for component tests (jsdom project).
 *
 * These are plain-object constants — no server/native imports.  Every field from
 * output-formats.md is represented so leaf-component tests can pick the slices
 * they need without re-building payloads from scratch.
 */

import type {
  OakAnswer,
  Subject,
  Candidates,
  Citation,
  Inference,
  GenerationBasis,
  DamageCalc,
} from "@/components/types";

// ---------------------------------------------------------------------------
// Sub-object building blocks
// ---------------------------------------------------------------------------

export const SUBJECT_GARCHOMP: Subject = {
  name: "Garchomp",
  dex_number: 445,
  sprite_url:
    "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/445.png",
  types: ["dragon", "ground"],
  is_fallback: false,
};

export const SUBJECT_MEWTWO_FALLBACK: Subject = {
  name: "Mewtwo",
  dex_number: 150,
  sprite_url:
    "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/150.png",
  types: ["psychic"],
  is_fallback: true,
  source_generation: "gen-1",
};

export const CITATION_GARCHOMP: Citation = {
  source: "pokemon/garchomp",
  detail: "base speed: 102",
  endpoint_url: "https://pokeapi.co/api/v2/pokemon/garchomp",
};

export const CITATION_EARTHQUAKE: Citation = {
  source: "move/earthquake",
  detail: "power: 100",
};

export const INFERENCE_SPEED: Inference = {
  claim: "Garchomp outspeeds most Ground-type threats in Gen 9.",
  confidence: "high",
  note: "Based on base speed of 102 vs. the Gen 9 Ground-type pool.",
};

export const INFERENCE_LOW_CONFIDENCE: Inference = {
  claim: "The Pokémon likely runs a Choice Scarf.",
  confidence: "low",
};

export const GENERATION_BASIS_GEN9: GenerationBasis = {
  generation: "gen-9",
  fallback: false,
};

export const GENERATION_BASIS_FALLBACK: GenerationBasis = {
  generation: "gen-1",
  fallback: true,
  note: "Mewtwo is not available in Gen 9; data sourced from Gen 1.",
};

export const CANDIDATES_TRUNCATED: Candidates = {
  total_count: 50,
  truncated: true,
  sort: "speed desc",
  shown: [
    {
      name: "Garchomp",
      dex_number: 445,
      sprite_url:
        "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/445.png",
      types: ["dragon", "ground"],
      // Full six stats — rendered in fixed order. key_stats kept to prove that
      // base_stats takes precedence when both are present.
      base_stats: {
        hp: 108,
        attack: 130,
        defense: 95,
        special_attack: 80,
        special_defense: 85,
        speed: 102,
      },
      key_stats: { speed: 102 },
    },
    {
      name: "Dragonite",
      dex_number: 149,
      types: ["dragon", "flying"],
      base_stats: {
        hp: 91,
        attack: 134,
        defense: 95,
        special_attack: 100,
        special_defense: 100,
        speed: 80,
      },
      key_stats: { speed: 80 },
    },
  ],
};

/** A candidate set with only `key_stats` (no `base_stats`) — the fallback path. */
export const CANDIDATES_KEYSTATS_ONLY: Candidates = {
  total_count: 1,
  truncated: false,
  sort: null,
  shown: [
    {
      name: "Garchomp",
      dex_number: 445,
      types: ["dragon", "ground"],
      key_stats: { speed: 102 },
    },
  ],
};

export const CANDIDATES_EXACT: Candidates = {
  total_count: 2,
  truncated: false,
  sort: null,
  shown: [
    {
      name: "Arcanine",
      dex_number: 59,
      types: ["fire"],
      ability: "flash-fire",
    },
    {
      name: "Ninetales",
      dex_number: 38,
      types: ["fire"],
      ability: "drought",
    },
  ],
};

export const DAMAGE_CALC_GARCHOMP: DamageCalc = {
  assumptions: {
    level: 50,
    attacker: "Garchomp",
    move: "earthquake",
    evs: 0,
    ivs: 31,
    nature: "neutral",
  },
  result: { min_damage: 142, max_damage: 168 },
  is_estimate: true,
  breakdown:
    "floor(floor(floor((2*50/5+2)*100*120/65)/50)+2)*1.5*1.0*[0.85..1.0]",
};

// ---------------------------------------------------------------------------
// Canonical full-answer fixture (covers every optional field)
// ---------------------------------------------------------------------------

export const CANONICAL_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown:
    "Garchomp learns Earthquake via TM in Gen 9 and has a base Speed stat of 102.",
  reasoning_markdown:
    "I called query_pokedex with moves=[earthquake] and verified via get_pokemon(garchomp).\nBase speed confirmed at 102 in the Pokédex index.",
  citations: [CITATION_GARCHOMP, CITATION_EARTHQUAKE],
  inferences: [INFERENCE_SPEED],
  generation_basis: GENERATION_BASIS_GEN9,
  subjects: [SUBJECT_GARCHOMP],
  candidates: CANDIDATES_TRUNCATED,
  damage_calc: DAMAGE_CALC_GARCHOMP,
  suggestions: ["Garchomp", "Garchomp (Mega)"],
  uncertainty_flags: ["Result assumes the standard Rough Skin ability"],
};

// ---------------------------------------------------------------------------
// Minimal answered answer (no optional fields)
// ---------------------------------------------------------------------------

export const MINIMAL_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "Yes, Garchomp can learn Earthquake.",
  reasoning_markdown: "Checked Gen-9 learnset.",
  citations: [CITATION_GARCHOMP],
  inferences: [],
  generation_basis: GENERATION_BASIS_GEN9,
};

// ---------------------------------------------------------------------------
// Resolution-failed fixture (triggers SuggestionChips + CaveatStrip)
// ---------------------------------------------------------------------------

export const RESOLUTION_FAILED_ANSWER: OakAnswer = {
  status: "resolution_failed",
  answer_markdown:
    "I couldn't find a Pokémon named 'Garcomp'. Did you mean Garchomp?",
  reasoning_markdown: "Fuzzy search returned no high-confidence matches.",
  citations: [],
  inferences: [],
  generation_basis: GENERATION_BASIS_GEN9,
  suggestions: ["Garchomp", "Gardevoir"],
};

// ---------------------------------------------------------------------------
// Fallback-generation fixture
// ---------------------------------------------------------------------------

export const FALLBACK_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "Mewtwo has a base Speed of 130 (Gen 1 data; not in Gen 9).",
  reasoning_markdown: "Mewtwo is not in Gen 9; falling back to Gen 1 data.",
  citations: [
    {
      source: "pokemon/mewtwo",
      detail: "base speed: 130",
      endpoint_url: "https://pokeapi.co/api/v2/pokemon/mewtwo",
    },
  ],
  inferences: [],
  generation_basis: GENERATION_BASIS_FALLBACK,
  subjects: [SUBJECT_MEWTWO_FALLBACK],
  uncertainty_flags: ["This Pokémon is not available in Gen 9."],
};

// ---------------------------------------------------------------------------
// Clarification-needed fixture
// ---------------------------------------------------------------------------

export const CLARIFICATION_ANSWER: OakAnswer = {
  status: "clarification_needed",
  answer_markdown:
    "There are multiple Tauros forms in Gen 9. Which one do you mean?",
  reasoning_markdown:
    "Detected three Paldean Tauros forms; need disambiguation.",
  citations: [],
  inferences: [],
  generation_basis: GENERATION_BASIS_GEN9,
  suggestions: [
    "Tauros (Paldean Combat)",
    "Tauros (Paldean Aqua)",
    "Tauros (Paldean Blaze)",
  ],
};

// ---------------------------------------------------------------------------
// Stop-and-ask fixture — clarification_needed with structured question.options
// (the "ask the user" affordance → QuestionOptions). One option carries a
// description, one does not, to exercise both render paths.
// ---------------------------------------------------------------------------

export const QUESTION_ANSWER: OakAnswer = {
  status: "clarification_needed",
  answer_markdown:
    "Trick Room teams differ a lot by format — are you building for Singles or Doubles?",
  reasoning_markdown:
    "Format materially changes the recommended setters and abusers; asking before building.",
  citations: [],
  inferences: [],
  generation_basis: GENERATION_BASIS_GEN9,
  question: {
    options: [
      { label: "Singles", description: "6v6, one Pokémon active per side" },
      { label: "Doubles" },
    ],
  },
};
