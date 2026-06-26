# Output Formats

The agent produces exactly one structured output per turn: the **`PokebotAnswer`**
object, emitted as the argument to the `submit_answer` tool (T11). This is the
contract between the agent and the frontend renderer.

## `PokebotAnswer` — JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PokebotAnswer",
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "answer_markdown", "reasoning_markdown", "citations", "inferences", "generation_basis"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["answered", "clarification_needed", "resolution_failed", "insufficient_data"],
      "description": "Kind of response. 'answered' = a real answer; 'clarification_needed' = need user input (e.g. did-you-mean); 'resolution_failed' = couldn't resolve an entity at all; 'insufficient_data' = tools couldn't supply needed data (e.g. PokeAPI down)."
    },
    "answer_markdown": {
      "type": "string",
      "description": "The direct, bottom-line-first answer in markdown. Always present (for non-answered statuses, this carries the clarification/decline text)."
    },
    "reasoning_markdown": {
      "type": "string",
      "description": "The 'why' — how the agent reached the answer, including mechanics deductions and how filters/math were applied."
    },
    "citations": {
      "type": "array",
      "description": "The specific PokeAPI data relied on (BR-4). Empty only when no data was used (e.g. a pure scope decline).",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["source", "detail"],
        "properties": {
          "source": { "type": "string", "description": "Resource referenced, e.g. 'move/fake-out', 'ability/armor-tail', 'pokemon/garchomp', 'learnset/will-o-wisp (gen-9)', 'type/ground'." },
          "detail": { "type": "string", "description": "The exact datum used, e.g. 'priority: 3', 'base speed: 102', the quoted effect text." },
          "endpoint_url": { "type": "string", "description": "Optional canonical PokeAPI URL for verification." }
        }
      }
    },
    "inferences": {
      "type": "array",
      "description": "Parts of the answer that are the agent's deduction rather than stated data (BR-3). Empty when the answer is purely factual.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["claim", "confidence"],
        "properties": {
          "claim": { "type": "string" },
          "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
          "note": { "type": "string", "description": "Why it's an inference / what it hinges on / known edge cases." }
        }
      }
    },
    "generation_basis": {
      "type": "object",
      "additionalProperties": false,
      "required": ["generation", "fallback"],
      "properties": {
        "generation": { "type": "string", "description": "e.g. 'gen-9', 'gen-8'." },
        "fallback": { "type": "boolean", "description": "True when the answer falls back to pre-Gen-9 data for a Pokémon not native to Gen 9 (BR-1)." },
        "note": { "type": "string", "description": "Required-in-spirit when fallback=true: name the Pokémon and the generation/source used." }
      }
    },
    "subjects": {
      "type": "array",
      "description": "Specific Pokémon the answer is about — drives sprite cards + type badges (US-11).",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "sprite_url", "types", "is_fallback"],
        "properties": {
          "name": { "type": "string" },
          "dex_number": { "type": "integer" },
          "sprite_url": { "type": "string" },
          "types": { "type": "array", "items": { "$ref": "#/definitions/typeName" } },
          "is_fallback": { "type": "boolean" },
          "source_generation": { "type": "string" }
        }
      }
    },
    "candidates": {
      "type": "object",
      "description": "Result set for filter/superlative/list answers (US-1/2/3) — drives the candidate table.",
      "additionalProperties": false,
      "required": ["total_count", "truncated", "shown"],
      "properties": {
        "total_count": { "type": "integer", "description": "Total matches found (may exceed shown.length)." },
        "truncated": { "type": "boolean", "description": "True when shown is a subset of total_count." },
        "sort": { "type": ["string", "null"], "description": "Sort applied, e.g. 'speed desc'." },
        "shown": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "types"],
            "properties": {
              "name": { "type": "string" },
              "dex_number": { "type": "integer" },
              "sprite_url": { "type": "string" },
              "types": { "type": "array", "items": { "$ref": "#/definitions/typeName" } },
              "key_stats": { "type": "object", "description": "Subset of stats relevant to the query, e.g. { speed: 135 }." },
              "ability": { "type": "string", "description": "Relevant ability when the filter was ability-based." }
            }
          }
        }
      }
    },
    "damage_calc": {
      "type": "object",
      "description": "Battle-math result (US-9). Always an estimate (BR-6).",
      "additionalProperties": false,
      "required": ["assumptions", "result", "is_estimate"],
      "properties": {
        "assumptions": { "type": "object", "description": "Every assumption used: level, evs, ivs, nature, modifiers, etc." },
        "result": { "type": "object", "description": "The computed value(s), e.g. { stat: 'speed', value: 169 } or { min_damage: 142, max_damage: 168 }." },
        "is_estimate": { "type": "boolean", "const": true },
        "breakdown": { "type": "string", "description": "The worked steps (from compute_stat / estimate_damage)." }
      }
    },
    "suggestions": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Closest valid entity names for clarification_needed / resolution_failed (BR-9). Rendered as clickable chips."
    },
    "uncertainty_flags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Top-level caveats surfaced prominently (e.g. 'Couldn't reach PokeAPI for item data', 'Result assumes the standard ability')."
    }
  },
  "definitions": {
    "typeName": {
      "type": "string",
      "enum": ["normal","fire","water","electric","grass","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"]
    }
  }
}
```

## Validation Rules

- `status`, `answer_markdown`, `reasoning_markdown`, `citations`, `inferences`,
  `generation_basis` are **always required**.
- When `status = "answered"` and the answer makes any factual claim, `citations`
  **must be non-empty** (BR-4). The only exception is a pure scope-decline
  (Example E), where no data was used.
- When the answer contains a deduction, it **must** appear in `inferences`
  (BR-3). Conversely, purely factual answers should have `inferences: []`.
- When `generation_basis.fallback = true`, `generation_basis.note` must name the
  Pokémon and the generation/source used (BR-1), and the affected `subjects[].is_fallback`
  must be `true`.
- `candidates.total_count` reflects the true match count even when `shown` is
  truncated — never imply full coverage when truncated (honest counts).
- `damage_calc.is_estimate` is always `true` (BR-6).
- For `clarification_needed` / `resolution_failed`, `suggestions` should be
  populated when any close match exists.
- All `types` / `subjects[].types` / `candidates.shown[].types` values must be
  one of the 18 `typeName` enum values (so the frontend can color-map badges).

## Consumer Contract

The **frontend chat renderer** (a React `AnswerCard`, per `ux-design.md`) ingests
`PokebotAnswer`:

| Field | Frontend component |
|-------|--------------------|
| `answer_markdown` | `AnswerBody` |
| `reasoning_markdown` | `ReasoningBlock` (collapsible) |
| `subjects[]` | `SpriteCard` (+ `TypeBadge` per type) |
| `candidates` | `CandidateTable` ("N of M" when truncated) |
| `citations[]` | `SourceList` (collapsible "Sources") |
| `inferences[]` | `InferenceCallout` |
| `generation_basis.fallback`, `uncertainty_flags[]` | `FallbackBanner` / `CaveatStrip` |
| `damage_calc` | `DamageReadout` (shows assumptions + estimate tag) |
| `suggestions[]` (with `status`) | `SuggestionChips` (click → follow-up message) |

The schema is also the headless test contract — evals assert against these fields
directly (see `evaluation.md`).

## Failure / Abstention Output

- **Couldn't resolve an entity:** `status: "resolution_failed"`, explain in
  `answer_markdown`, populate `suggestions`. Never return an empty answer silently
  (BR-9).
- **Need user input to proceed:** `status: "clarification_needed"`.
- **Tools couldn't supply data (e.g. PokeAPI down):** `status: "insufficient_data"`,
  say so plainly in `answer_markdown`, add an `uncertainty_flags` entry. Do not
  fabricate (NFR reliability + "never invent data" rule).
