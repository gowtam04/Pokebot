/**
 * Contracts gate.
 *
 * Takes the CANONICAL SAMPLE PAYLOADS verbatim from the design docs and asserts
 * they validate against the generated Zod schemas / JSON Schemas. If a downstream
 * phase changes a shape the model depends on, this test breaks first.
 *
 * Samples:
 *  - Garchomp query_pokedex output  (tools.md T2)
 *  - Farigiraf get_pokemon output   (tools.md T3)
 *  - OakAnswer Examples A..E     (prompts.md few-shot / output-formats.md)
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_NAMES,
  computeStatInputSchema,
  getPokemonOutputSchema,
  oakAnswerJsonSchema,
  oakAnswerSchema,
  queryPokedexOutputSchema,
  resolveEntityInputSchema,
  toJsonSchema,
  toolInputJsonSchemas,
  type OakAnswer,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Canonical tool-output samples (verbatim from tools.md)
// ---------------------------------------------------------------------------

// tools.md T2 — query_pokedex output sample (Garchomp).
const GARCHOMP_QUERY_POKEDEX = {
  total_count: 7,
  truncated: false,
  sort: "speed desc",
  results: [
    {
      display_name: "Garchomp",
      national_dex_number: 445,
      types: ["dragon", "ground"],
      abilities: { slot1: "sand-veil", hidden: "rough-skin" },
      base_stats: {
        hp: 108,
        attack: 130,
        defense: 95,
        special_attack: 80,
        special_defense: 85,
        speed: 102,
      },
      base_stat_total: 600,
      sprite_url: "https://.../445.png",
      is_gen9_native: true,
      source_generation: null,
    },
  ],
};

// tools.md T3 — get_pokemon output sample (Farigiraf).
const FARIGIRAF_GET_POKEMON = {
  found: true,
  display_name: "Farigiraf",
  national_dex_number: 981,
  types: ["normal", "psychic"],
  abilities: {
    slot1: "cud-chew",
    slot2: "armor-tail",
    hidden: "sap-sipper",
  },
  base_stats: {
    hp: 120,
    attack: 90,
    defense: 70,
    special_attack: 110,
    special_defense: 70,
    speed: 60,
  },
  base_stat_total: 520,
  sprite_url: "https://.../981.png",
  artwork_url: "https://.../981_official.png",
  forms: ["farigiraf"],
  is_gen9_native: true,
  source_generation: null,
};

// ---------------------------------------------------------------------------
// Canonical OakAnswer samples (prompts.md few-shot Examples A..E)
// ---------------------------------------------------------------------------

// Example A — mechanics interaction with a conditional (US-7, BR-3).
const EXAMPLE_A: OakAnswer = {
  status: "answered",
  answer_markdown:
    "It depends on Farigiraf's ability.\n\n- **If it has Armor Tail:** Fake Out **fails**.\n- **Otherwise:** Fake Out **works** normally.",
  reasoning_markdown:
    "Fake Out is a +3 priority move. Armor Tail blocks moves with increased priority, so the outcome is conditional on Farigiraf's ability.",
  subjects: [
    {
      name: "Farigiraf",
      dex_number: 981,
      sprite_url: "...",
      types: ["normal", "psychic"],
      is_fallback: false,
    },
  ],
  citations: [
    { source: "move/fake-out", detail: "priority: 3; damage_class: physical" },
    {
      source: "ability/armor-tail",
      detail: "Prevents the holder from being hit by increased-priority moves.",
    },
    {
      source: "pokemon/farigiraf",
      detail: "abilities: cud-chew, armor-tail, sap-sipper",
    },
  ],
  inferences: [
    {
      claim:
        "Armor Tail negates Fake Out specifically because Fake Out has +3 priority.",
      confidence: "high",
      note: "Direct application of Armor Tail's effect text to Fake Out's priority value.",
    },
  ],
  generation_basis: { generation: "gen-9", fallback: false },
};

// Example B — multi-move intersection filter (US-1, BR-7).
const EXAMPLE_B: OakAnswer = {
  status: "answered",
  answer_markdown:
    "**6 Pokémon** can learn both Trick Room and Will-O-Wisp in Gen 9.",
  reasoning_markdown:
    "I intersected the Gen 9 learnsets of both moves — only Pokémon that learn BOTH appear.",
  candidates: {
    total_count: 6,
    truncated: false,
    sort: null,
    shown: [
      {
        name: "Dusknoir",
        dex_number: 477,
        sprite_url: "...",
        types: ["ghost"],
      },
      {
        name: "Ceruledge",
        dex_number: 1023,
        sprite_url: "...",
        types: ["fire", "ghost"],
      },
    ],
  },
  citations: [
    {
      source: "learnset/trick-room (gen-9)",
      detail: "learned_by set intersected",
    },
    {
      source: "learnset/will-o-wisp (gen-9)",
      detail: "learned_by set intersected",
    },
  ],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

// Example C — resolve-or-clarify on a misspelling (AC-1.3, BR-9).
const EXAMPLE_C: OakAnswer = {
  status: "clarification_needed",
  answer_markdown:
    'I couldn\'t find a move called "Will-o-Whisp" — did you mean **Will-O-Wisp**?',
  reasoning_markdown:
    "The name didn't match a known move; the closest match is Will-O-Wisp.",
  suggestions: ["Will-O-Wisp"],
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

// Example D — stat math with stated assumptions (US-9, BR-6).
const EXAMPLE_D: OakAnswer = {
  status: "answered",
  answer_markdown:
    "**169 Speed** at Level 50, with 252 Speed EVs, a 31 Speed IV, and a Jolly nature (+Speed).",
  reasoning_markdown:
    "Garchomp's base Speed is 102. Applying the standard stat formula with your spread gives 169.",
  damage_calc: {
    assumptions: { level: 50, ev: 252, iv: 31, nature: "Jolly (+Spe)" },
    result: { stat: "speed", value: 169 },
    is_estimate: true,
    breakdown: "floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169",
  },
  subjects: [
    {
      name: "Garchomp",
      dex_number: 445,
      sprite_url: "...",
      types: ["dragon", "ground"],
      is_fallback: false,
    },
  ],
  citations: [{ source: "pokemon/garchomp", detail: "base speed: 102" }],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

// Example E — out-of-scope decline (pure scope-decline; empty citations allowed).
const EXAMPLE_E: OakAnswer = {
  status: "answered",
  answer_markdown:
    "Egg moves and breeding are outside what I cover. I can help with Dratini's level-up/TM learnset, stats, abilities, evolutions, or type matchups.",
  reasoning_markdown:
    "Breeding/egg moves are explicitly out of scope; I'm flagging that rather than guessing.",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

// Example F — proactive "stop and ask" with structured question.options. The
// agent declines to answer generally and presents mutually-exclusive choices;
// each option label is sent verbatim as the user's reply when clicked.
const EXAMPLE_F: OakAnswer = {
  status: "clarification_needed",
  answer_markdown:
    "Trick Room teams differ a lot by format — are you building for **Singles** or **Doubles**?",
  reasoning_markdown:
    "Format materially changes the recommended setters and abusers; asking before building.",
  question: {
    options: [
      { label: "Singles", description: "6v6, one Pokémon active per side" },
      { label: "Doubles", description: "4v4, two Pokémon active per side" },
    ],
  },
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

const OAK_ANSWER_EXAMPLES: Array<[string, OakAnswer]> = [
  ["Example A (conditional mechanics)", EXAMPLE_A],
  ["Example B (intersection candidates)", EXAMPLE_B],
  ["Example C (clarification)", EXAMPLE_C],
  ["Example D (stat math / damage_calc)", EXAMPLE_D],
  ["Example E (scope decline)", EXAMPLE_E],
  ["Example F (stop and ask / question.options)", EXAMPLE_F],
];

// ===========================================================================

describe("contracts gate — canonical tool outputs validate", () => {
  it("validates the Garchomp query_pokedex output (tools.md T2)", () => {
    const parsed = queryPokedexOutputSchema.safeParse(GARCHOMP_QUERY_POKEDEX);
    expect(parsed.success).toBe(true);
  });

  it("validates the Farigiraf get_pokemon output (tools.md T3)", () => {
    const parsed = getPokemonOutputSchema.safeParse(FARIGIRAF_GET_POKEMON);
    expect(parsed.success).toBe(true);
  });

  it("accepts the query_pokedex structured-error shapes", () => {
    expect(
      queryPokedexOutputSchema.safeParse({ error: "index_unavailable" })
        .success,
    ).toBe(true);
    expect(
      queryPokedexOutputSchema.safeParse({ unresolved: ["trik-room"] }).success,
    ).toBe(true);
    expect(
      queryPokedexOutputSchema.safeParse({
        total_count: 0,
        truncated: false,
        sort: null,
        results: [],
      }).success,
    ).toBe(true);
  });

  it("accepts the get_pokemon miss shape", () => {
    expect(
      getPokemonOutputSchema.safeParse({
        found: false,
        suggestions: ["farigiraf"],
      }).success,
    ).toBe(true);
  });
});

describe("contracts gate — canonical OakAnswer examples validate", () => {
  for (const [label, example] of OAK_ANSWER_EXAMPLES) {
    it(`validates ${label}`, () => {
      const parsed = oakAnswerSchema.safeParse(example);
      if (!parsed.success) {
        throw new Error(
          `${label} failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(parsed.success).toBe(true);
    });
  }
});

describe("OakAnswer rejects invalid payloads", () => {
  it("rejects an unknown status", () => {
    expect(
      oakAnswerSchema.safeParse({ ...EXAMPLE_E, status: "made_up" })
        .success,
    ).toBe(false);
  });

  it("rejects an off-list type name in subjects (must be one of the 18)", () => {
    const bad = {
      ...EXAMPLE_A,
      subjects: [
        {
          name: "Mystery",
          sprite_url: "...",
          types: ["lightning"],
          is_fallback: false,
        },
      ],
    };
    expect(oakAnswerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required field (generation_basis)", () => {
    const { generation_basis, ...rest } = EXAMPLE_E;
    void generation_basis;
    expect(oakAnswerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects unknown top-level keys (additionalProperties: false)", () => {
    expect(
      oakAnswerSchema.safeParse({ ...EXAMPLE_E, surprise: 1 }).success,
    ).toBe(false);
  });

  it("rejects an invalid inference confidence", () => {
    const bad = {
      ...EXAMPLE_A,
      inferences: [{ claim: "x", confidence: "definitely" }],
    };
    expect(oakAnswerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a question with fewer than 2 options (.min(2))", () => {
    const bad = { ...EXAMPLE_F, question: { options: [{ label: "Only one" }] } };
    expect(oakAnswerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a question with more than 4 options (.max(4))", () => {
    const bad = {
      ...EXAMPLE_F,
      question: {
        options: [
          { label: "A" },
          { label: "B" },
          { label: "C" },
          { label: "D" },
          { label: "E" },
        ],
      },
    };
    expect(oakAnswerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an option with an unknown key (.strict())", () => {
    const bad = {
      ...EXAMPLE_F,
      question: {
        options: [
          { label: "Singles", value: "singles" },
          { label: "Doubles" },
        ],
      },
    };
    expect(oakAnswerSchema.safeParse(bad).success).toBe(false);
  });
});

describe("JSON-Schema generation for the Anthropic SDK", () => {
  it("emits an input schema for every tool name (T1..T11)", () => {
    for (const name of TOOL_NAMES) {
      expect(toolInputJsonSchemas[name]).toBeDefined();
    }
    expect(Object.keys(toolInputJsonSchemas).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
  });

  it("every tool input schema has an object root, no $schema, and additionalProperties:false", () => {
    for (const name of TOOL_NAMES) {
      const js = toolInputJsonSchemas[name];
      expect(js.type).toBe("object");
      expect(js).not.toHaveProperty("$schema");
      expect(js.additionalProperties).toBe(false);
    }
  });

  it("the submit_answer schema IS the OakAnswer schema with the required core fields", () => {
    expect(oakAnswerJsonSchema).toBe(toolInputJsonSchemas.submit_answer);
    expect(oakAnswerJsonSchema.type).toBe("object");
    const required = oakAnswerJsonSchema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "status",
        "answer_markdown",
        "reasoning_markdown",
        "citations",
        "inferences",
        "generation_basis",
      ]),
    );
  });

  it("contains no $ref (fully inlined via $refStrategy:'none')", () => {
    const serialized = JSON.stringify(toolInputJsonSchemas);
    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("$schema");
  });

  it("toJsonSchema throws on a non-object root", () => {
    // A bare string schema must not be accepted as a tool input schema.
    expect(() => toJsonSchema(resolveEntityInputSchema.shape.query)).toThrow();
  });
});

describe("tool input schemas apply documented defaults", () => {
  it("resolve_entity defaults kind='any' and limit=5", () => {
    const parsed = resolveEntityInputSchema.parse({ query: "Farigiraf" });
    expect(parsed.kind).toBe("any");
    expect(parsed.limit).toBe(5);
  });

  it("compute_stat defaults level=50, iv=31, ev=0, nature='neutral'", () => {
    const parsed = computeStatInputSchema.parse({ base_stat: 102 });
    expect(parsed).toMatchObject({
      level: 50,
      iv: 31,
      ev: 0,
      nature_effect: "neutral",
      is_hp: false,
    });
  });
});
