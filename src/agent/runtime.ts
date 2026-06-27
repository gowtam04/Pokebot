/**
 * Agent runtime — `runPokebot` (design.md § Agent runtime; agent-design
 * integration.md § Invocation Signature). Phase 5.
 *
 * Drives one Sonnet-4.6 tool-loop turn:
 *   1. Assemble the prompt-cached stable prefix: system prompt + few-shot
 *      (transcribed from agent-design/prompts.md) + the 11 tool definitions.
 *      ONE `cache_control: { type: "ephemeral" }` breakpoint sits on the last
 *      system block; render order is tools → system → messages, so that single
 *      breakpoint caches the tools + system + few-shot together. The prefix is
 *      built once at module load and is byte-identical across turns.
 *   2. Append the in-session `history` then the current `message` as the
 *      variable message tail.
 *   3. Loop ≤ 10 iterations. Per the RISK DIRECTIVE for Sonnet 4.6, thinking +
 *      a forced `tool_choice` is a HARD 400 — so we use `tool_choice: "auto"`
 *      with `thinking: { type: "adaptive" }` and drive `submit_answer` via the
 *      system prompt + this max-iteration guard. Each turn: echo the FULL
 *      `response.content` back, dispatch every `tool_use` block, and return all
 *      `tool_result` blocks in ONE user message with matching `tool_use_id`.
 *      Loop until `stop_reason !== "tool_use"`.
 *   4. On `submit_answer`, validate the payload against the PokebotAnswer Zod
 *      schema. Valid → return it. Invalid → return the validation error to the
 *      model and request a re-emit (≤ 2). After the budget is exhausted —
 *      or if the loop hits its iteration cap, or the model ends a turn without
 *      submitting — synthesize an `insufficient_data` PokebotAnswer.
 *   5. Emit `onProgress` once per tool call, and assemble + log the per-turn
 *      pino trace (integration.md § Observability Hooks).
 *
 * Never throws for in-domain failures (unresolved entity / clarification /
 * PokeAPI down / loop-max / invalid-after-retry surface as a PokebotAnswer with
 * the right `status`). Transport/API faults from `messages.stream` propagate to
 * the route as exceptions (sse-types.ts: those become an `error` event).
 */

import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/env";
import { dispatch, tools } from "@/agent/tools";
import {
  CHAMPIONS_FEW_SHOT,
  CHAMPIONS_SYSTEM_PROMPT,
} from "@/agent/prompts/champions";
import { pokebotAnswerSchema, type PokebotAnswer } from "@/agent/schemas";
import type {
  AgentContext,
  ChatMessage,
  OnAnswerDelta,
  OnAnswerStart,
  OnProgress,
  RunPokebot,
} from "@/agent/types";
import { logTurn, type ToolTraceEntry, type TurnTrace } from "@/server/logger";

// ---------------------------------------------------------------------------
// Loop constants (integration.md § Guardrails — enforced by the loop, not the
// prompt).
// ---------------------------------------------------------------------------

/** Hard cap on model turns per user message (integration.md / D-loop). */
export const MAX_ITERATIONS = 10;

/** Re-emit budget when a `submit_answer` payload fails schema validation. */
export const MAX_SUBMIT_RETRIES = 2;

/**
 * Output budget. Comfortably fits the largest PokebotAnswer (candidate lists +
 * reasoning). The per-turn call streams (messages.stream), so the SDK's
 * non-streaming HTTP timeout no longer applies.
 */
export const MAX_TOKENS = 16000;

/** The fixed model (agent-design D2; overridable via env for ops only). */
const MODEL = env.ANTHROPIC_MODEL;

// ---------------------------------------------------------------------------
// Cacheable stable prefix — system prompt + few-shot (transcribed verbatim
// from agent-design/prompts.md). Kept as module constants so the prefix is
// byte-identical on every turn (a prerequisite for prompt-cache hits).
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Pokebot, a knowledgeable and trustworthy Pokémon expert for a single
competitive player. You answer questions about Pokémon, moves, abilities, types,
stats, evolutions, items, and — most importantly — how game mechanics interact.

# Your goal
For each user message, gather exactly the data you need using your tools, reason
carefully (especially about mechanics and battle math), and submit one answer
via the submit_answer tool. Your value is not just looking up data — it is
reasoning correctly on top of it and being transparent about how you got there.

# Data and generation rules
1. All Pokémon data comes from your tools (which draw from PokeAPI). Never invent
   data. If a tool didn't give you a fact, you don't have it — say so.
2. Answers are based on Generation 9 (Scarlet/Violet, including DLC) by default.
   If a Pokémon is not native to Gen 9, your tools will tell you (is_gen9_native
   = false, with a source_generation). When that happens, use the available data
   but clearly flag that it's based on an earlier generation and name which one.
3. "Can learn move X" is evaluated against the Gen 9 learnset. query_pokedex and
   the learnset data already handle this — trust them over your own memory.

# How to use your tools
- When a name might be misspelled or ambiguous, call resolve_entity first and use
  the canonical slug. Never return an empty result for a name you simply failed
  to resolve — offer the closest valid match and ask (see "Resolve or clarify").
- For ANY filter, threshold, superlative ("fastest", "highest Attack"), or
  compound query, use query_pokedex. Do not fetch Pokémon one-by-one to filter or
  rank them. To find Pokémon that learn SEVERAL moves, pass them all in \`moves\` —
  the tool returns the intersection (Pokémon that learn ALL of them in Gen 9).
- When you present a list of Pokémon, put them in the \`candidates\` field and, for
  EACH row, copy the row's full six \`base_stats\` (hp, attack, defense,
  special_attack, special_defense, speed) verbatim from the query_pokedex result
  into that row's \`base_stats\` field — always all six, never a subset, and never
  invent them. The UI renders the full stat line and type badges from this. Do NOT
  also reproduce that list as a markdown table inside \`answer_markdown\`: keep
  \`answer_markdown\` as prose (the bottom line plus any notes); the structured
  \`candidates\` list IS the table. (Markdown tables are still fine in
  \`answer_markdown\` for OTHER things — type charts, head-to-head comparisons.)
- For a single Pokémon's profile, use get_pokemon. For move/ability/type/
  evolution/item details, use the matching get_* tool. Fetch only what the answer
  needs (efficient API use matters).
- For any stat or damage math, ALWAYS use compute_stat / estimate_damage. Do not
  do the arithmetic yourself — the formulas floor at each step and manual math is
  error-prone. You still decide the inputs and explain the result.
- End every turn by calling submit_answer. It is your only way to respond —
  whether you're giving the answer or stopping to ask (see "When to stop and ask").

# Reasoning and transparency (non-negotiable)
- Separate stated facts from your deductions. A fact is something a tool returned
  (e.g. "Fake Out has priority +3"). A deduction is your inference about how
  facts combine (e.g. "therefore Armor Tail blocks it"). Put deductions in the
  \`inferences\` field with a confidence level, and reflect uncertainty in the
  answer (BR-3).
- Cite the specific data you relied on in \`citations\` — exact priority values,
  effect text, stat figures, learnset sources — so the user can verify (BR-4).
- When an answer depends on a condition (e.g. WHICH ability a Pokémon has —
  Farigiraf can have Cud Chew, Armor Tail, or Sap Sipper), state the condition
  explicitly instead of assuming one. Give the answer per relevant case.
- For damage/stat math, state every assumption (level, EVs, IVs, nature,
  modifiers). Default to Level 50, 0 EVs, 31 IVs, neutral nature, and no weather/
  items unless the user specified them. Present results as estimates and invite
  the user to refine the spread (BR-6).

# Type effectiveness
Use get_type_matchups (latest type chart). Treat 0× as an IMMUNITY, not a
resistance — e.g. Flying takes no damage from Ground; Normal/Ghost are immune to
each other. Be precise about super-effective vs not-very-effective vs immune.

# Conversation
You may receive follow-ups that build on the previous answer ("now only the Fire
types", "which of those is fastest?"). Apply the refinement to the prior result
set / topic from earlier in this conversation rather than starting over.

# Active team
The user can have a saved team SELECTED as the conversation's active team. When a
question is about "my team", a member of it, "this set", or wants advice grounded
in what they're running, call get_active_team to read it. It takes no arguments —
the user selects the team, you cannot pick or change it — and returns the members
(species, ability, item, moves, nature, EVs/IVs, Tera type, level) with display
names plus any validity/legality \`warnings\` (illegal moves, over-cap EVs,
duplicate species, etc.). If it returns { active: false }, no team is selected:
say so and offer to help build or import one rather than inventing a team. Use the
warnings to ground your advice, and reason on top of the team the same way you do
for any other data (cite what you read, flag inferences).
When the user asks you to BUILD or suggest a team (or changes to one), put the
result in the \`proposed_team\` field — a name, the format, and the members array
(species/ability/item/moves/nature/EVs/IVs/tera_type/level per slot; partial sets
are fine, omit what you're unsure of). You never save or modify a team yourself —
\`proposed_team\` is a suggestion the user applies. Still write the prose summary in
\`answer_markdown\` and your reasoning/citations as usual.

# When to stop and ask
Some requests can't be answered well until you know one missing thing — e.g.
"build a Trick Room team" (Singles or Doubles? — the setters and abusers differ a
lot), or a request that maps to several forms. When a SINGLE unstated choice
would MATERIALLY change your answer or the set you'd recommend, STOP and ask
instead of answering generally or silently picking one. Ask about ONE thing at a
time.
To ask, call submit_answer with status "clarification_needed", lead
\`answer_markdown\` with the focused question, and populate \`question\` with 2–4
concrete, mutually-exclusive \`options\`. Each option's \`label\` is sent verbatim
as the user's next message when clicked, so write it as their reply ("Singles",
"Doubles"); add a one-line \`description\` only when the label isn't self-evident.
Do NOT also give a full general answer in that turn — asking and answering are
different turns; you'll continue next turn with their choice and the full
conversation. The user can also type a free-text reply instead of clicking.
Don't ask when a clearly-stated default works: if you can answer and just note
the assumption (level/EVs/format), prefer that. Reserve stop-and-ask for when a
wrong guess would waste the user's time or change the recommendation.

# Scope — politely decline these (they are out of scope)
- Egg moves, breeding, egg groups, move inheritance.
- Where to catch Pokémon, encounter rates, locations, version exclusives.
- Full turn-by-turn battle simulation (you reason about interactions and can
  estimate single hits, but you do not simulate whole battles).
- Any data not available through your tools / PokeAPI (no outside sources).
When declining, briefly say it's outside what you cover and offer what you CAN
help with.

# Answer style
Lead with the bottom line, then the reasoning. Be concise and competitive-savvy;
the user knows terms like Trick Room, priority, STAB, EV/IV/nature. Always submit
through submit_answer with citations, inferences, and generation_basis filled in.`;

const FEW_SHOT = `# Worked examples

Each example shows the tool calls (abbreviated "→ tool(args)" / "← result") and
ends in the submit_answer call that produces the user-facing answer card.

## Example A — Mechanics interaction with a conditional
User: does Fake Out work on Farigiraf?
→ get_move({ name: "fake-out" })
← { found: true, display_name: "Fake Out", priority: 3, damage_class: "physical",
    effect_short: "Hits first (+3 priority), flinches; only on the user's first turn." }
→ get_pokemon({ name: "farigiraf" })
← { found: true, display_name: "Farigiraf", types: ["normal","psychic"],
    abilities: { slot1: "cud-chew", slot2: "armor-tail", hidden: "sap-sipper" }, is_gen9_native: true }
→ get_ability({ name: "armor-tail" })
← { found: true, display_name: "Armor Tail",
    effect_short: "Prevents the holder from being hit by moves with increased priority." }
→ submit_answer({
    status: "answered",
    answer_markdown: "It depends on Farigiraf's ability.\\n\\n- **If it has Armor Tail:** Fake Out **fails** — Armor Tail blocks all increased-priority moves, and Fake Out is +3 priority.\\n- **If it has Cud Chew or Sap Sipper:** Fake Out **works** normally.",
    reasoning_markdown: "Fake Out is a +3 priority move (a fact from its move data). Armor Tail blocks moves with increased priority. Farigiraf has three possible abilities, so the outcome is conditional on which one this Farigiraf has.",
    subjects: [{ name: "Farigiraf", dex_number: 981, sprite_url: "...", types: ["normal","psychic"], is_fallback: false }],
    citations: [
      { source: "move/fake-out", detail: "priority: 3; damage_class: physical" },
      { source: "ability/armor-tail", detail: "Prevents the holder from being hit by increased-priority moves." },
      { source: "pokemon/farigiraf", detail: "abilities: cud-chew, armor-tail, sap-sipper" }
    ],
    inferences: [
      { claim: "Armor Tail negates Fake Out specifically because Fake Out has +3 priority.", confidence: "high",
        note: "Direct application of Armor Tail's effect text to Fake Out's priority value." }
    ],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example B — Multi-move intersection filter
User: find me a Pokémon that can learn both Trick Room and Will-O-Wisp
→ query_pokedex({ moves: ["trick-room","will-o-wisp"], limit: 50 })
← { total_count: 6, truncated: false, results: [ { display_name: "Dusknoir", ... }, { display_name: "Ceruledge", ... }, ... ] }
→ submit_answer({
    status: "answered",
    answer_markdown: "**6 Pokémon** can learn both Trick Room and Will-O-Wisp in Gen 9. Standouts: **Dusknoir** (Ghost) as a bulky Trick Room setter, and **Ceruledge** (Fire/Ghost) for offense. The full list with stats is below.",
    reasoning_markdown: "I intersected the Gen 9 learnsets for both moves — only Pokémon that can learn BOTH appear. A straightforward set intersection, no inference.",
    candidates: { total_count: 6, truncated: false, sort: null, shown: [
      { name: "Dusknoir", dex_number: 477, sprite_url: "...", types: ["ghost"], base_stats: { hp: 45, attack: 100, defense: 135, special_attack: 65, special_defense: 135, speed: 45 } },
      { name: "Ceruledge", dex_number: 937, sprite_url: "...", types: ["fire","ghost"], base_stats: { hp: 75, attack: 125, defense: 80, special_attack: 60, special_defense: 100, speed: 85 } }
      /* …the remaining rows, each with all six base_stats copied from query_pokedex… */
    ] },
    citations: [
      { source: "learnset/trick-room (gen-9)", detail: "learned_by set intersected" },
      { source: "learnset/will-o-wisp (gen-9)", detail: "learned_by set intersected" }
    ],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example C — Resolve-or-clarify on a misspelling
User: what can learn Will-o-Whisp
→ query_pokedex({ moves: ["will-o-whisp"] })
← { unresolved: ["will-o-whisp"] }
→ resolve_entity({ query: "Will-o-Whisp", kind: "move" })
← { matches: [ { kind: "move", slug: "will-o-wisp", display_name: "Will-O-Wisp", score: 0.94 } ] }
→ submit_answer({
    status: "clarification_needed",
    answer_markdown: "I couldn't find a move called \\"Will-o-Whisp\\" — did you mean **Will-O-Wisp**? If so, I'll pull the list of Pokémon that can learn it.",
    reasoning_markdown: "The name didn't match a known move; the closest match is Will-O-Wisp (a Fire-type status move that burns the target).",
    suggestions: ["Will-O-Wisp"],
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example D — Stat math with stated assumptions
User: what's Garchomp's Speed at level 50 with max Speed EVs and a Jolly nature
→ get_pokemon({ name: "garchomp" })
← { found: true, base_stats: { ..., speed: 102 }, types: ["dragon","ground"], is_gen9_native: true }
→ compute_stat({ base_stat: 102, level: 50, ev: 252, iv: 31, nature_effect: "boosted" })
← { value: 169, breakdown: "floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169.4 -> 169" }
→ submit_answer({
    status: "answered",
    answer_markdown: "**169 Speed** at Level 50, with 252 Speed EVs, a 31 Speed IV, and a Jolly nature (+Speed).",
    reasoning_markdown: "Garchomp's base Speed is 102. Applying the standard stat formula with your spread gives 169. Want me to recompute at Level 100 or with a different spread?",
    damage_calc: { assumptions: { level: 50, ev: 252, iv: 31, nature: "Jolly (+Spe)" }, result: { stat: "speed", value: 169 }, is_estimate: true, breakdown: "floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169" },
    subjects: [{ name: "Garchomp", dex_number: 445, sprite_url: "...", types: ["dragon","ground"], is_fallback: false }],
    citations: [{ source: "pokemon/garchomp", detail: "base speed: 102" }],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example E — Out-of-scope decline
User: what egg moves does Dratini get?
→ submit_answer({
    status: "answered",
    answer_markdown: "Egg moves and breeding are outside what I cover. I can help with Dratini's level-up/TM learnset, its stats and abilities, evolutions, or type matchups — want any of those?",
    reasoning_markdown: "Breeding/egg moves are explicitly out of scope for this tool; I'm flagging that rather than guessing.",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example F — Stop and ask before a format-dependent build
User: help me build a trick room team
→ submit_answer({
    status: "clarification_needed",
    answer_markdown: "Happy to build a Trick Room team! One thing first — **Singles or Doubles?** Trick Room plays quite differently in each (Doubles especially rewards a dedicated setter + redirection), so the setters and abusers I'd pick depend on it.",
    reasoning_markdown: "The format materially changes the recommended setters, abusers, and support, so I'm asking before building rather than giving a generic list.",
    question: { options: [
      { label: "Singles", description: "6v6, one Pokémon active per side" },
      { label: "Doubles", description: "4v4, two active — the common TR format" }
    ] },
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })

## Example G — Grounding advice in the user's active team
User: anything wrong with my team?
→ get_active_team({})
← { active: true, team: { name: "Rain Offense", format: "scarlet-violet", members: [
    { species: "garchomp", species_display: "Garchomp", ability: "rough-skin", item: "life-orb",
      moves: ["earthquake","dragon-claw","fire-fang","stealth-rock"], moves_display: ["Earthquake","Dragon Claw","Fire Fang","Stealth Rock"],
      nature: "jolly", evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, tera_type: "fire", level: 50 },
    /* …five more members… */
  ], warnings: [
    { code: "move_not_in_learnset", message: "Garchomp can't learn Stealth Rock in this format.", slot: 0, field: "moves[3]" },
    { code: "ev_total_exceeded", message: "Slot 2 spends 512 EVs (max 508).", slot: 1 }
  ] } }
→ submit_answer({
    status: "answered",
    answer_markdown: "Two issues stand out on **Rain Offense**:\\n\\n1. **Garchomp – Stealth Rock** isn't in its learnset for this format, so that slot is illegal as written. Swap to a legal hazard setter (or drop the move).\\n2. **Slot 2** is over the EV cap — it spends **512** of a maximum **508**, so 4 EVs are wasted; trim a stat by 4.\\n\\nEverything else looks legal.",
    reasoning_markdown: "I read your active team and its computed warnings. The move-legality and EV-cap flags come straight from the validator; I'm surfacing the two that actually need a fix and leaving the rest alone.",
    citations: [
      { source: "active_team/Rain Offense", detail: "warning move_not_in_learnset: Garchomp / Stealth Rock (slot 0)" },
      { source: "active_team/Rain Offense", detail: "warning ev_total_exceeded: slot 2 total 512 > 508" }
    ],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })`;

/**
 * The stable system prefix as two text blocks. The breakpoint on the LAST block
 * (few-shot) caches tools + both system blocks together (render order is
 * tools → system → messages). Exactly one ephemeral breakpoint per the RISK
 * DIRECTIVE.
 */
const SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT },
  {
    type: "text",
    text: FEW_SHOT,
    cache_control: { type: "ephemeral" },
  },
];

/**
 * Champions-mode sibling of {@link SYSTEM_BLOCKS}. Same two-block shape and the
 * SAME single ephemeral breakpoint on the last (few-shot) block, so the
 * Champions scope gets its own warm prompt-cache prefix. Selected by
 * `ctx.mode === "champions"` just before the stream call; the standard blocks
 * above stay byte-identical so OFF mode keeps its cache.
 */
const CHAMPIONS_SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: "text", text: CHAMPIONS_SYSTEM_PROMPT },
  {
    type: "text",
    text: CHAMPIONS_FEW_SHOT,
    cache_control: { type: "ephemeral" },
  },
];

/**
 * The tool definitions for the Anthropic SDK, built once (T1..T11 plus the
 * inlined T12 `get_active_team`, which auto-joins from the tool layer). `name` /
 * `inputSchema` come straight from the tool layer (schemas.ts is the single
 * source), so this list is deterministic and never reordered between turns
 * (reordering would invalidate the cache).
 */
const TOOL_DEFS: Anthropic.Tool[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
}));

// ---------------------------------------------------------------------------
// Progress labels (integration.md § UI Consumer Contract — "stream tool-activity
// labels … so the UI shows motion").
// ---------------------------------------------------------------------------

const PROGRESS_LABELS: Record<string, string> = {
  resolve_entity: "🔍 Resolving name…",
  query_pokedex: "📊 Searching the Pokédex…",
  get_pokemon: "📇 Looking up Pokémon…",
  get_move: "⚔️ Looking up move…",
  get_ability: "✨ Looking up ability…",
  get_type_matchups: "🛡️ Checking type matchups…",
  get_evolution_chain: "🧬 Tracing evolution…",
  get_item: "🎒 Looking up item…",
  compute_stat: "🧮 Computing stat…",
  estimate_damage: "💥 Estimating damage…",
  submit_answer: "✍️ Composing the answer…",
  get_active_team: "📋 Reading your active team…",
};

/** The generic per-tool label, used as the fallback when args are unusable. */
function progressLabel(tool: string): string {
  return PROGRESS_LABELS[tool] ?? `Running ${tool}…`;
}

/**
 * Title-cases a slug/name for display in a progress label, preserving internal
 * separators: `"will-o-wisp"` → `"Will-O-Wisp"`, `"iron hands"` → `"Iron Hands"`,
 * `"garchomp"` → `"Garchomp"`. Returns "" for non-strings/empties so callers can
 * fall back to the generic label. Only the first letter after a word boundary is
 * uppercased (existing casing is left intact), and the result is length-capped so
 * a pathological input can't bloat the label.
 */
export function titleizeSlug(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim().replace(/_/g, " ").slice(0, 48);
  if (!cleaned) return "";
  return cleaned.replace(/(^|[\s-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
}

const STAT_FILTER_LABELS: Record<string, string> = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  special_attack: "Sp. Atk",
  special_defense: "Sp. Def",
  speed: "Speed",
  base_stat_total: "BST",
};

const STAT_OP_LABELS: Record<string, string> = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  "==": "=",
};

/** Pulls the string members out of a value that may or may not be an array. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Joins the present query_pokedex filters into a readable "Fire · Speed > 100 · learns Will-O-Wisp" clause. */
function describePokedexFilters(obj: Record<string, unknown>): string {
  const parts: string[] = [];

  const types = asStringList(obj.types).map(titleizeSlug).filter(Boolean);
  if (types.length) parts.push(types.join("/"));

  const abilities = asStringList(obj.abilities).map(titleizeSlug).filter(Boolean);
  if (abilities.length) parts.push(abilities.join(", "));

  const moves = asStringList(obj.moves).map(titleizeSlug).filter(Boolean);
  if (moves.length) parts.push(`learns ${moves.join(", ")}`);

  if (Array.isArray(obj.stat_filters)) {
    for (const f of obj.stat_filters) {
      if (!f || typeof f !== "object") continue;
      const sf = f as Record<string, unknown>;
      const stat = typeof sf.stat === "string" ? STAT_FILTER_LABELS[sf.stat] ?? sf.stat : null;
      const op = typeof sf.op === "string" ? STAT_OP_LABELS[sf.op] ?? sf.op : null;
      const val = typeof sf.value === "number" ? sf.value : null;
      if (stat && op && val !== null) parts.push(`${stat} ${op} ${val}`);
    }
  }

  return parts.join(" · ");
}

/**
 * Builds a human-readable, context-rich progress label for one tool call by
 * enriching the generic per-tool verb with the concrete subject from the model's
 * `input`. Input is model-supplied and untrusted, so every field read is guarded
 * and any missing/malformed field falls back to the generic `progressLabel`.
 */
export function describeToolCall(tool: string, input: unknown): string {
  const base = progressLabel(tool);
  const obj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  switch (tool) {
    case "resolve_entity": {
      const q = typeof obj.query === "string" ? obj.query.trim() : "";
      return q ? `🔍 Resolving “${q.slice(0, 48)}”…` : base;
    }
    case "query_pokedex": {
      const filters = describePokedexFilters(obj);
      return filters ? `📊 Searching the Pokédex: ${filters}…` : base;
    }
    case "get_pokemon": {
      const name = titleizeSlug(obj.name);
      return name ? `📇 Looking up ${name}…` : base;
    }
    case "get_move": {
      const name = titleizeSlug(obj.name);
      return name ? `⚔️ Looking up the move ${name}…` : base;
    }
    case "get_ability": {
      const name = titleizeSlug(obj.name);
      return name ? `✨ Reading the ${name} ability…` : base;
    }
    case "get_type_matchups": {
      const types = asStringList(obj.types).map(titleizeSlug).filter(Boolean);
      return types.length ? `🛡️ Checking ${types.join("/")} matchups…` : base;
    }
    case "get_evolution_chain": {
      const name = titleizeSlug(obj.species);
      return name ? `🧬 Tracing ${name}’s evolution…` : base;
    }
    case "get_item": {
      const name = titleizeSlug(obj.name);
      return name ? `🎒 Looking up ${name}…` : base;
    }
    case "compute_stat": {
      const lvl = typeof obj.level === "number" ? obj.level : null;
      return lvl ? `🧮 Computing a stat at Lv ${lvl}…` : "🧮 Computing a stat…";
    }
    case "estimate_damage":
      return "💥 Running the damage calc…";
    case "submit_answer":
      return "✍️ Composing the answer…";
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Incremental answer_markdown extractor (token-by-token streaming)
// ---------------------------------------------------------------------------

/**
 * Pulls the growing, decoded value of the top-level `answer_markdown` string out
 * of the accumulating `partial_json` fragments of a streaming submit_answer tool
 * input. Only a `submit_answer` input has an `answer_markdown` field, so feeding
 * this just the submit_answer block's deltas is sufficient.
 *
 * `push(fragment)` returns ONLY the newly-decoded characters (or "") so the
 * caller can forward them as an `answer_delta`. Concatenating every return value
 * reproduces the decoded `answer_markdown` prefix seen so far — and, once the
 * value's closing quote arrives, equals the final `answer.answer_markdown`.
 *
 * SDK-version-independent: it consumes only raw JSON text and decodes JSON string
 * escapes itself (\n \t \r \b \f \/ \\ \" and \uXXXX incl. surrogate pairs),
 * never emitting a partial escape and never splitting an escaped surrogate pair
 * across two chunks. Keys may appear in any order; non-target values (objects,
 * arrays, strings, primitives) are fully skipped, so a `reasoning_markdown` value
 * that contains the literal substring `"answer_markdown"` cannot misfire.
 */
export class AnswerMarkdownExtractor {
  private state:
    | "before_object"
    | "at_root"
    | "key_string"
    | "after_key"
    | "before_value"
    | "target_value"
    | "skip_value"
    | "done" = "before_object";

  private keyBuf = "";
  private targetKey = false;

  // Shared JSON-string decode state (key_string + target_value).
  private escape = false;
  private uHex: string | null = null; // collecting \uXXXX digits when non-null
  private pendingHigh: number | null = null; // buffered escaped high surrogate

  // skip_value state.
  private skipDepth = 0;
  private skipInString = false;
  private skipEscape = false;
  private skipStarted = false;

  /** Feed one `partial_json` fragment; returns newly-decoded answer_markdown. */
  push(fragment: string): string {
    let out = "";
    for (let i = 0; i < fragment.length; i++) {
      if (this.state === "done") break;
      out += this.feed(fragment[i]!);
    }
    return out;
  }

  private resetStringState(): void {
    this.escape = false;
    this.uHex = null;
    this.pendingHigh = null;
  }

  private flushPendingHigh(): string {
    if (this.pendingHigh !== null) {
      const s = String.fromCharCode(this.pendingHigh);
      this.pendingHigh = null;
      return s;
    }
    return "";
  }

  private feed(ch: string): string {
    switch (this.state) {
      case "before_object":
        if (ch === "{") this.state = "at_root";
        return "";
      case "at_root":
        if (ch === '"') {
          this.keyBuf = "";
          this.resetStringState();
          this.state = "key_string";
        } else if (ch === "}") {
          this.state = "done";
        }
        return "";
      case "key_string": {
        const r = this.decodeStringChar(ch);
        if (r.closed) {
          this.targetKey = this.keyBuf === "answer_markdown";
          this.state = "after_key";
        } else {
          this.keyBuf += r.char;
        }
        return "";
      }
      case "after_key":
        if (ch === ":") this.state = "before_value";
        return "";
      case "before_value":
        if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") return "";
        if (this.targetKey && ch === '"') {
          this.resetStringState();
          this.state = "target_value";
          return "";
        }
        // Non-target key, or a target value that isn't a string — skip it whole.
        this.startSkip();
        return this.feedSkip(ch);
      case "target_value": {
        const r = this.decodeStringChar(ch);
        if (r.closed) {
          this.state = "done";
          return r.char;
        }
        return r.char;
      }
      case "skip_value":
        return this.feedSkip(ch);
      case "done":
        return "";
    }
  }

  /** Decode one char of a JSON string. `closed` marks the unescaped end quote. */
  private decodeStringChar(ch: string): { char: string; closed: boolean } {
    if (this.uHex !== null) {
      this.uHex += ch;
      if (this.uHex.length < 4) return { char: "", closed: false };
      const code = parseInt(this.uHex, 16);
      this.uHex = null;
      if (Number.isNaN(code)) return { char: "", closed: false };
      if (code >= 0xd800 && code <= 0xdbff) {
        const flushed = this.flushPendingHigh();
        this.pendingHigh = code;
        return { char: flushed, closed: false };
      }
      if (code >= 0xdc00 && code <= 0xdfff && this.pendingHigh !== null) {
        const s = String.fromCharCode(this.pendingHigh, code);
        this.pendingHigh = null;
        return { char: s, closed: false };
      }
      return {
        char: this.flushPendingHigh() + String.fromCharCode(code),
        closed: false,
      };
    }

    if (this.escape) {
      this.escape = false;
      const lead = this.flushPendingHigh();
      switch (ch) {
        case "n":
          return { char: lead + "\n", closed: false };
        case "t":
          return { char: lead + "\t", closed: false };
        case "r":
          return { char: lead + "\r", closed: false };
        case "b":
          return { char: lead + "\b", closed: false };
        case "f":
          return { char: lead + "\f", closed: false };
        case "/":
          return { char: lead + "/", closed: false };
        case "\\":
          return { char: lead + "\\", closed: false };
        case '"':
          return { char: lead + '"', closed: false };
        case "u":
          // A high surrogate buffered before this \u must wait for the result.
          if (lead) this.pendingHighReinstate(lead);
          this.uHex = "";
          return { char: "", closed: false };
        default:
          return { char: lead + ch, closed: false };
      }
    }

    if (ch === "\\") {
      this.escape = true;
      return { char: "", closed: false };
    }
    if (ch === '"') {
      return { char: this.flushPendingHigh(), closed: true };
    }
    return { char: this.flushPendingHigh() + ch, closed: false };
  }

  // The `\u` escape branch flushes pendingHigh into `lead`, but a high surrogate
  // immediately followed by `\u` is the start of a surrogate PAIR — re-buffer it
  // so the low surrogate can combine. (Only reachable for back-to-back \u.)
  private pendingHighReinstate(lead: string): void {
    if (lead.length === 1) this.pendingHigh = lead.charCodeAt(0);
  }

  private startSkip(): void {
    this.state = "skip_value";
    this.skipDepth = 0;
    this.skipInString = false;
    this.skipEscape = false;
    this.skipStarted = false;
  }

  private feedSkip(ch: string): string {
    if (this.skipInString) {
      if (this.skipEscape) {
        this.skipEscape = false;
      } else if (ch === "\\") {
        this.skipEscape = true;
      } else if (ch === '"') {
        this.skipInString = false;
        if (this.skipDepth === 0) this.state = "at_root";
      }
      return "";
    }

    if (!this.skipStarted) {
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") return "";
      this.skipStarted = true;
      if (ch === '"') {
        this.skipInString = true;
        return "";
      }
      if (ch === "{" || ch === "[") {
        this.skipDepth = 1;
        return "";
      }
      // Primitive (number / true / false / null) — fall through.
    }

    if (ch === '"') {
      this.skipInString = true;
      return "";
    }
    if (ch === "{" || ch === "[") {
      this.skipDepth++;
      return "";
    }
    if (ch === "}" || ch === "]") {
      if (this.skipDepth > 0) {
        this.skipDepth--;
        if (this.skipDepth === 0) this.state = "at_root";
        return "";
      }
      // A primitive ended on the parent's closing brace — re-dispatch it.
      this.state = "at_root";
      return this.feed(ch);
    }
    if (this.skipDepth === 0) {
      if (ch === ",") {
        this.state = "at_root";
        return this.feed(ch);
      }
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
        this.state = "at_root";
      }
      // else: still mid-primitive token (digits, letters) — keep consuming.
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// Injectable client seam — keeps the public signature fixed while letting the
// unit/integration tests drive a recorded transcript (design.md Phase 5: a
// stubbed/recorded Anthropic client for determinism).
// ---------------------------------------------------------------------------

/**
 * The minimal `MessageStream` surface the runtime consumes: it is async-iterable
 * over the raw streaming events (used to extract `answer_markdown` deltas) and
 * exposes `finalMessage()` to recover the fully-assembled message (which the
 * existing loop body operates on, unchanged).
 */
export interface MessageStreamLike
  extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** The single SDK method the runtime uses (the streaming helper). */
export interface AnthropicClientLike {
  messages: {
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): MessageStreamLike;
  };
}

let cachedClient: Anthropic | undefined;

/** Lazily build + memoize the real Anthropic client (once per process). */
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map in-session history turns to SDK message params. */
function historyToMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  return history.map((turn) => ({ role: turn.role, content: turn.content }));
}

/** Compact a Zod issue list into a single human/model-readable string. */
function formatZodIssues(error: import("zod").ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Build a schema-valid `insufficient_data` answer for the orchestration-level
 * fallbacks (loop-max, invalid-after-retries, no-submit). Never user-blaming;
 * states plainly that the turn couldn't be completed (integration.md).
 */
function synthesizeInsufficientData(reason: string): PokebotAnswer {
  return {
    status: "insufficient_data",
    answer_markdown:
      "I wasn't able to put together a reliable answer for that this time. " +
      "Could you rephrase or narrow the question, and I'll try again?",
    reasoning_markdown:
      "The agent could not complete this turn through its normal tool loop, " +
      "so it is reporting insufficient data rather than guessing.",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
    uncertainty_flags: [reason],
  };
}

/** Read the session id off the (correlation-tagged) child logger, if present. */
function sessionIdOf(ctx: AgentContext): string {
  const logger = ctx.logger as { bindings?: () => Record<string, unknown> };
  if (typeof logger.bindings === "function") {
    const bound = logger.bindings();
    if (typeof bound.session_id === "string") {
      return bound.session_id;
    }
  }
  return "";
}

/** Mutable accumulator for the per-turn trace, finalized in {@link finalize}. */
interface TraceState {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTrace: ToolTraceEntry[];
}

function accumulateUsage(state: TraceState, usage: Anthropic.Usage): void {
  state.inputTokens +=
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  state.outputTokens += usage.output_tokens;
  state.thinkingTokens += usage.output_tokens_details?.thinking_tokens ?? 0;
}

/**
 * Assemble + emit the per-turn pino trace (integration.md § Observability
 * Hooks) and return the answer. `cache_hit` is recorded as `false` for every
 * entry: the read-through cache hit/miss lives inside the data layer and is not
 * observable from the runtime seam.
 */
function finalize(
  answer: PokebotAnswer,
  state: TraceState,
  ctx: AgentContext,
): PokebotAnswer {
  const trace: TurnTrace = {
    request_id: ctx.requestId,
    session_id: sessionIdOf(ctx),
    model: MODEL,
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    thinking_tokens: state.thinkingTokens,
    tool_trace: state.toolTrace,
    turn_latency_ms: Date.now() - state.startedAt,
    status: answer.status,
    citation_count: answer.citations.length,
  };
  logTurn(trace, ctx.logger);
  return answer;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Run the tool-loop against an explicit client. Exposed for tests
 * (recorded-transcript injection); production calls go through {@link runPokebot}.
 */
export async function runPokebotWith(
  client: AnthropicClientLike,
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: OnProgress,
  onAnswerStart?: OnAnswerStart,
  onAnswerDelta?: OnAnswerDelta,
): Promise<PokebotAnswer> {
  const state: TraceState = {
    startedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    toolTrace: [],
  };

  // Variable tail: prior in-session turns, then the current user message.
  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(history),
    { role: "user", content: message },
  ];

  let submitRetries = 0;

  // Server-controlled scope selects the system-prompt variant (loop-invariant).
  // Standard stays referentially SYSTEM_BLOCKS (byte-identical → cache preserved);
  // Champions uses its sibling prefix. Everything else (tools, thinking,
  // tool_choice, model, max_tokens, messages) is identical across modes.
  const systemBlocks =
    ctx.mode === "champions" ? CHAMPIONS_SYSTEM_BLOCKS : SYSTEM_BLOCKS;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Bail if the client disconnected (user pressed Stop) during the prior tool
    // dispatch — covers the gap between the SDK-level aborts below. Thrown as an
    // AbortError so it propagates to the route like any transport fault (where it
    // is recognized via req.signal.aborted and not surfaced as an error event).
    if (ctx.signal?.aborted) {
      throw new DOMException("Aborted by client", "AbortError");
    }

    // Transport/API faults here propagate to the route (NOT caught). Forward the
    // request signal so an in-flight stream is torn down immediately on Stop.
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
        tools: TOOL_DEFS,
        // RISK DIRECTIVE: thinking + forced tool_choice = HARD 400 on Sonnet 4.6.
        // Use adaptive thinking with tool_choice "auto"; submit_answer is driven
        // by the system prompt and the max-iteration guard, never forced.
        thinking: { type: "adaptive" },
        tool_choice: { type: "auto" },
        messages,
      },
      { signal: ctx.signal },
    );

    // Stream answer_markdown out of the submit_answer tool input as it arrives.
    // Keyed on the content-block index so parallel tool blocks stay isolated; a
    // re-emitted submit_answer (after a validation failure) starts a fresh block
    // → fresh onAnswerStart → the client resets its buffer.
    let submitIndex: number | null = null;
    let extractor: AnswerMarkdownExtractor | null = null;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (
          event.content_block.type === "tool_use" &&
          event.content_block.name === "submit_answer"
        ) {
          submitIndex = event.index;
          extractor = new AnswerMarkdownExtractor();
          onAnswerStart?.();
        }
      } else if (
        event.type === "content_block_delta" &&
        event.index === submitIndex &&
        extractor !== null &&
        event.delta.type === "input_json_delta"
      ) {
        const chunk = extractor.push(event.delta.partial_json);
        if (chunk) onAnswerDelta?.(chunk);
      } else if (
        event.type === "content_block_stop" &&
        event.index === submitIndex
      ) {
        submitIndex = null;
        extractor = null;
      }
    }

    // The fully-assembled message — structurally identical to the old
    // messages.create result; the loop body below is unchanged.
    const response = await stream.finalMessage();

    accumulateUsage(state, response.usage);

    // Echo the FULL assistant content back (preserves thinking blocks +
    // tool_use blocks for multi-turn continuity on the same model).
    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // Model ended its turn without calling any tool — it never submitted an
    // answer. Surface insufficient_data (integration.md error surface).
    if (toolUseBlocks.length === 0) {
      return finalize(
        synthesizeInsufficientData("model_ended_turn_without_submit_answer"),
        state,
        ctx,
      );
    }

    // One tool_result per tool_use block — returned together in ONE user
    // message (splitting them across messages trains the model off parallel
    // tool use). Build them all, then decide whether to terminate or continue.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let validAnswer: PokebotAnswer | null = null;
    let submitFailed = false;

    for (const block of toolUseBlocks) {
      onProgress?.({ tool: block.name, label: describeToolCall(block.name, block.input) });

      if (block.name === "submit_answer") {
        const started = Date.now();
        const parsed = pokebotAnswerSchema.safeParse(block.input);
        if (parsed.success) {
          validAnswer = parsed.data;
          state.toolTrace.push({
            tool: block.name,
            args: block.input,
            latency_ms: Date.now() - started,
            cache_hit: false,
            error: null,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Answer accepted.",
          });
        } else {
          submitFailed = true;
          const detail = formatZodIssues(parsed.error);
          state.toolTrace.push({
            tool: block.name,
            args: block.input,
            latency_ms: Date.now() - started,
            cache_hit: false,
            error: detail,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content:
              `Your submit_answer payload failed validation: ${detail}. ` +
              "Call submit_answer again with a corrected payload that matches " +
              "the required schema.",
          });
        }
        continue;
      }

      // A regular read/compute tool. The tool layer returns structured shapes
      // and never throws in-domain; a genuine throw (e.g. a DB fault) is caught
      // here so one bad tool can't kill the turn — it is fed back so the model
      // can recover or report insufficient_data.
      const started = Date.now();
      let result: unknown;
      let errorMessage: string | null = null;
      try {
        result = await dispatch(block.name, block.input, ctx);
      } catch (caught) {
        errorMessage =
          caught instanceof Error ? caught.message : String(caught);
        result = { error: "tool_error", detail: errorMessage };
      }
      state.toolTrace.push({
        tool: block.name,
        args: block.input,
        latency_ms: Date.now() - started,
        cache_hit: false,
        error: errorMessage,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(errorMessage ? { is_error: true } : {}),
      });
    }

    // A valid answer terminates the turn immediately (no further API call, so
    // the unused tool_results are harmless).
    if (validAnswer) {
      return finalize(validAnswer, state, ctx);
    }

    // submit_answer was emitted but invalid: re-emit up to the budget, then
    // synthesize insufficient_data.
    if (submitFailed) {
      submitRetries += 1;
      if (submitRetries > MAX_SUBMIT_RETRIES) {
        return finalize(
          synthesizeInsufficientData("submit_answer_invalid_after_retries"),
          state,
          ctx,
        );
      }
    }

    // Hand the tool results back and loop.
    messages.push({ role: "user", content: toolResults });
  }

  // Iteration cap reached without a valid submit_answer.
  return finalize(
    synthesizeInsufficientData("max_iterations_reached"),
    state,
    ctx,
  );
}

/**
 * The agent entry point. Builds the cached prefix + variable tail, runs the
 * Sonnet-4.6 tool-loop against the real Anthropic client, and returns a
 * schema-valid PokebotAnswer. See the module header for the full contract.
 */
export const runPokebot: RunPokebot = (
  message,
  history,
  ctx,
  onProgress,
  onAnswerStart,
  onAnswerDelta,
) =>
  runPokebotWith(
    getClient(),
    message,
    history,
    ctx,
    onProgress,
    onAnswerStart,
    onAnswerDelta,
  );

export default runPokebot;
