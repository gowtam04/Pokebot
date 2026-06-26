# UX Design — Interaction Contract

> Scope: this file locks **what the agent drives in the UI** (the interaction
> contract). Visual design — colors, exact type-badge palette, typography,
> layout — is out of scope here and belongs to the `frontend-design` skill,
> which runs after `agent-design` and `solution-architect`.

## Interaction Pattern

**Plain chat with rich structured-answer rendering.** The user types a question;
the agent replies with one **answer card** rendered from the `submit_answer`
structured payload. There is no separate content panel, wizard, or third-party
embed (no Calendly-style surfaces). The richness lives *inside* each assistant
message: sprites, type badges, a candidate table, collapsible citations, and
inference/fallback callouts.

The thread is the surface. Prior answer cards stay visible for multi-turn
refinement (US-10): "now only the Fire types", "which of those is fastest?".

## Surfaces / Components the Agent Drives

The agent doesn't call UI-action tools; it drives the UI **entirely through the
fields of its `submit_answer` payload**. Each field maps to a frontend
component:

| Component | Driven by (payload field) | Purpose | When populated |
|-----------|--------------------------|---------|----------------|
| **Answer body** | `answer_markdown` | The direct, bottom-line-first answer. | Always. |
| **Reasoning block** | `reasoning_markdown` | The "why" — mechanics deductions, how filters were applied. Collapsible. | Always. |
| **Subject sprite card(s)** | `subjects[]` (`name`, `dex_number`, `sprite_url`, `types[]`, `is_fallback`) | Sprite/artwork + name + type badges for the Pokémon the answer is about (US-11.1). | When the answer is about specific Pokémon. |
| **Type badge** | any `types[]` / `type` string | Type rendered as a color-coded badge (US-11.2). Frontend owns the 18-type → color map. | Wherever a type appears. |
| **Candidate table/grid** | `candidates` (`total_count`, `shown[]`, `truncated`, `sort`) | The result set for filter/superlative queries — rows with sprite, name, types, key stats, ability. Shows "N of M" when truncated. | Filter/list/superlative answers (US-1/2/3). |
| **Citation list** | `citations[]` (`source`, `detail`, `endpoint_url?`) | The specific PokeAPI data relied on (BR-4). Collapsible "Sources". | Always (≥1). |
| **Inference callout** | `inferences[]` (`claim`, `confidence`, `note?`) | Visually distinct "this is my deduction, not stated data" markers (BR-3). | When the answer contains deductions. |
| **Uncertainty / fallback banner** | `uncertainty_flags[]`, `generation_basis.fallback` | Prominent caveat strip — e.g. "Based on Gen 8 data; this Pokémon isn't in Gen 9" (BR-1, US-13). | When uncertain or on generation fallback. |
| **Damage/stat readout** | `damage_calc` (`assumptions`, `result`, `breakdown`, `is_estimate`) | Shows the computed value, the assumptions used, the worked breakdown, and an "estimate" tag (US-9, BR-6). | Battle-math answers. |
| **Clarification prompt** | `status: "clarification_needed"` / `"resolution_failed"` + `suggestions[]` | Renders the agent's question and clickable suggested entity names (BR-9, AC-1.3). | When an entity can't be resolved or is ambiguous. |

## Agent → UI Action Map

There are no imperative UI-action tools. The single action is **emit
`submit_answer`**; the frontend reconstructs the card from its fields. This keeps
the agent headless-testable (the payload is the whole contract) and the frontend
free to restyle without prompt changes.

## UI → Agent Input Map

| User action | Becomes agent input |
|-------------|---------------------|
| Types a question and sends | New user message appended to session history; agent runs a turn. |
| Clicks a **suggested entity** chip (from a `resolution_failed`/`clarification` card) | Sends a follow-up user message with the chosen name (e.g. "Will-O-Wisp"). Treated as a normal turn. |
| Clicks a candidate in the table (optional, frontend's choice) | Sends a follow-up like "tell me about <name>". Normal turn. No special protocol. |
| Reloads / closes tab | Session ends; in-session memory is discarded (D9). |

## State

Stateless beyond the in-session message history. No wizard steps, no
agent-managed UI state machine. Each turn is: history + new message → tools →
`submit_answer`.

## Carry-forward

- **Tools (`tools.md`):** no UI-action tools needed; `submit_answer`'s schema is
  the UI contract.
- **Output (`output-formats.md`):** the `submit_answer` schema must include every
  UI-intent field above.
- **Integration (`integration.md`):** the **UI consumer contract** names the
  frontend components that read each field, and how clicked-suggestion follow-ups
  flow back as normal messages.
- **`frontend-design` (later):** converts this contract into concrete visuals —
  the type-color palette, sprite card layout, table styling, callout treatments.
