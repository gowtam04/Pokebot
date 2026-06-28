/**
 * Oak few-shot examples — transcribed VERBATIM from
 * `docs/agent-design/prompts.md` ("Few-Shot Examples", Examples A–E).
 *
 * These examples live in the cacheable stable prefix (system + tool defs +
 * few-shot), so the rendered text MUST stay byte-identical run-to-run for the
 * Anthropic prompt cache to hit. Do NOT author or fill in the abbreviated tool
 * transcripts — `prompts.md` is the source of truth. Tool calls are shown as
 * `→ tool(args)` / `← result` exactly as in the doc; each example ends in a
 * `submit_answer` call carrying the OakAnswer (see output-formats.md).
 */

/** A single transcribed few-shot example (A–E). */
export interface FewShotExample {
  /** Example letter, "A"–"E". */
  readonly id: "A" | "B" | "C" | "D" | "E";
  /** Heading text verbatim from prompts.md (e.g. "Example A — …"). */
  readonly title: string;
  /** The user message that opens the example. */
  readonly user: string;
  /** The abbreviated tool transcript ending in `submit_answer`. */
  readonly transcript: string;
}

/**
 * The five worked examples (A–E), verbatim from agent-design/prompts.md.
 * Source of truth for {@link renderFewShot} / {@link FEW_SHOT_PROMPT}.
 */
export const FEW_SHOT_EXAMPLES: readonly FewShotExample[] = [
  {
    id: "A",
    title: "Example A — Mechanics interaction with a conditional (US-7, BR-3)",
    user: "does Fake Out work on Farigiraf?",
    transcript: `→ get_move({ name: "fake-out" })
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
    answer_markdown: "It depends on Farigiraf's ability.\\n\\n- **If it has Armor Tail:** Fake Out **fails** — Armor Tail blocks all increased-priority moves, and Fake Out is +3 priority.\\n- **If it has Cud Chew or Sap Sipper:** Fake Out **works** normally (40 BP + flinch, on your first turn).",
    reasoning_markdown: "Fake Out is a +3 priority move (a fact from its move data). Armor Tail's effect is to block moves with increased priority. So against an Armor Tail Farigiraf, Fake Out can't connect. Farigiraf has three possible abilities, so the outcome is conditional on which one this Farigiraf actually has.",
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
  })`,
  },
  {
    id: "B",
    title: "Example B — Multi-move intersection filter (US-1, BR-7)",
    user: "find me a Pokémon that can learn both Trick Room and Will-O-Wisp",
    transcript: `→ query_pokedex({ moves: ["trick-room","will-o-wisp"], limit: 50 })
← { total_count: 6, truncated: false, results: [
     { display_name: "Dusknoir", national_dex_number: 477, types: ["ghost"], base_stats: {...}, sprite_url: "...", is_gen9_native: true },
     { display_name: "Ceruledge", national_dex_number: 1023, types: ["fire","ghost"], ... }, ... ] }

→ submit_answer({
    status: "answered",
    answer_markdown: "**6 Pokémon** can learn both Trick Room and Will-O-Wisp in Gen 9. A few standouts: **Dusknoir** (Ghost), **Ceruledge** (Fire/Ghost). See the full list below.",
    reasoning_markdown: "I took the Gen 9 learnset for each move and intersected them — only Pokémon that can learn BOTH appear. This is a straightforward set intersection, no inference involved.",
    candidates: { total_count: 6, truncated: false, sort: null, shown: [ /* the 6 rows with sprite, types */ ] },
    citations: [
      { source: "learnset/trick-room (gen-9)", detail: "learned_by set intersected" },
      { source: "learnset/will-o-wisp (gen-9)", detail: "learned_by set intersected" }
    ],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })`,
  },
  {
    id: "C",
    title: "Example C — Resolve-or-clarify on a misspelling (AC-1.3, BR-9)",
    user: "what can learn Will-o-Whisp",
    transcript: `→ query_pokedex({ moves: ["will-o-whisp"] })
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
  })`,
  },
  {
    id: "D",
    title: "Example D — Stat math with stated assumptions (US-9, BR-6)",
    user: "what's Garchomp's Speed at level 50 with max Speed EVs and a Jolly nature",
    transcript: `→ get_pokemon({ name: "garchomp" })
← { found: true, base_stats: { ..., speed: 102 }, types: ["dragon","ground"], is_gen9_native: true }

→ compute_stat({ base_stat: 102, level: 50, ev: 252, iv: 31, nature_effect: "boosted" })
← { value: 169, breakdown: "floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169.4 -> 169" }

→ submit_answer({
    status: "answered",
    answer_markdown: "**169 Speed** at Level 50, with 252 Speed EVs, a 31 Speed IV, and a Jolly nature (+Speed).",
    reasoning_markdown: "Garchomp's base Speed is 102. Applying the standard stat formula with your spread gives 169. Want me to recompute at Level 100, or with a different EV/IV spread or nature?",
    damage_calc: { assumptions: { level: 50, ev: 252, iv: 31, nature: "Jolly (+Spe)" }, result: { stat: "speed", value: 169 }, is_estimate: true, breakdown: "floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169" },
    subjects: [{ name: "Garchomp", dex_number: 445, sprite_url: "...", types: ["dragon","ground"], is_fallback: false }],
    citations: [{ source: "pokemon/garchomp", detail: "base speed: 102" }],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })`,
  },
  {
    id: "E",
    title: "Example E — Out-of-scope decline (Out of Scope section)",
    user: "what egg moves does Dratini get?",
    transcript: `→ submit_answer({
    status: "answered",
    answer_markdown: "Egg moves and breeding are outside what I cover. I can help with Dratini's level-up/TM learnset, its stats and abilities, evolutions, or type matchups — want any of those?",
    reasoning_markdown: "Breeding/egg moves are explicitly out of scope for this tool; I'm flagging that rather than guessing.",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false }
  })`,
  },
];

/**
 * Render the few-shot block as a single deterministic string, mirroring the
 * `prompts.md` layout (heading, **User:** line, fenced transcript). Pure and
 * order-stable so the assembled prefix is byte-identical every call.
 */
export function renderFewShot(
  examples: readonly FewShotExample[] = FEW_SHOT_EXAMPLES,
): string {
  return examples
    .map(
      (ex) =>
        `### ${ex.title}\n\n**User:** ${ex.user}\n\n\`\`\`\n${ex.transcript}\n\`\`\``,
    )
    .join("\n\n");
}

/** Pre-rendered few-shot block for the cacheable prefix. */
export const FEW_SHOT_PROMPT = renderFewShot();

export default FEW_SHOT_EXAMPLES;
