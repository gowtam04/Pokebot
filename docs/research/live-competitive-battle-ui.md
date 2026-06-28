# Live Competitive Battle UI — Two Implementation Directions

> **Status:** exploration. Two implementation directions are described here. Both will be
> **prototyped independently** and the choice between them made later. This document is
> **not a comparison** — each direction below is a standalone *steelman*: the strongest
> honest case for building it that way, plus the architecture and implementation that case
> implies. Read each on its own terms.
>
> Companion to backlog **B-5 — Competitive battling page** (`docs/backlog.md`). Where B-5
> is the broad "competitive surface," this doc drills into the *live battle* sub-surface.

---

## Product definition (agreed scope — shared by both directions)

The Live Competitive Battle UI is a **friendly, real-time battle companion** that sits
beside a competitive match the user is playing. It is **not** an autonomous bot — the human
makes every decision; the UI assists. Its four jobs:

1. **Explain the turn.** After each turn resolves, narrate what happened in plain language
   with the numbers behind it ("Earthquake hit Rotom-Wash for 42%; your Landorus survived at
   12% because it was holding Focus Sash").
2. **Recommend the next move.** Surface the strongest option(s) for the upcoming turn with
   supporting stats (KO %, speed checks, risk), as a suggestion the player can take or ignore.
3. **Track what the opponent has revealed.** Maintain a live "scouting sheet" of everything
   the opposing player has shown — revealed moves, items, abilities, Tera type — plus what can
   be *inferred* (speed bounds from turn order, EV spreads back-solved from damage rolls,
   Choice-lock detection, etc.).
4. **Keep up live.** Decisions and explanations must land within Showdown's turn clock.

Fixed constraints from the scoping pass:

| Dimension      | Decision                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Core function  | Live co-pilot / explainer (recommend + narrate + scout). Not a bot.      |
| State source   | **ps-local** — a self-hosted Pokémon Showdown server, over its sim protocol. |
| Timing         | **Live-timed** — must respond within the turn clock (seconds).           |
| Format scope   | **Both Singles and Doubles** from the start.                             |

Relationship to the rest of Oak: this is a **new surface**, distinct from the fixed
11-tool chat agent (`docs/agent-design/tools.md`). It does not have to honor that agent's
tool contract; it may define its own tools/modules. It does build on the same `@pkmn`
data layer and (for metagame data) the `ps-local` ingest that B-5 introduces.

---

## Common substrate (plumbing both directions need)

Stated here once so each direction below can focus on what's distinctive. This is shared
infrastructure, **not** a point of comparison.

- **ps-local connection.** A server-side websocket bridge from the Next.js app to the
  `ps-local` Showdown server. The browser never talks to ps-local directly; a Node route
  holds the socket and relays parsed events to the client (and the player's chosen actions
  back). `runtime = "nodejs"`, long-lived connection per active battle.
- **Protocol parsing.** Showdown streams a line protocol (`|request|`, `|turn|`, `|move|`,
  `|switch|`, `|-damage|`, `|-heal|`, `|-status|`, `|-boost|`, `|-weather|`, `|faint|`, …).
  Parse with `@pkmn/protocol`; do **not** hand-roll it.
- **Authoritative battle-state model.** `@pkmn/client`'s `Battle` consumes the protocol
  stream and maintains client-side state for both sides: actives, HP %, status, boosts,
  field (weather/terrain/hazards/side conditions), and the *known* part of each set. Both
  directions read from this same model; neither should re-derive state from raw lines.
- **The HUD shell.** A new App Router page (e.g. `/battle`) rendering: the field, both teams
  with revealed-info badges, a turn log, and a recommendation panel. The shell is identical
  regardless of which engine fills the panels; only the *source* of the explanation and
  recommendation differs between directions.
- **Format awareness.** Singles vs Doubles and the specific ruleset (VGC/BSS/Smogon tier)
  come from the battle's format string and drive legal-action generation and legality.

Everything above is direction-agnostic. The two directions diverge entirely in **how the
turn explanation, the recommendation, and the inference are produced.**

---

## Direction A — Local processing (no LLMs)

A fully deterministic engine. Parse the battle, compute exact numbers, infer hidden
information by rule, score the candidate actions, and assemble the explanation from
templates. No model in the loop.

### Steelman

- **Latency is a non-issue.** A damage-calc sweep over every legal action plus a shallow
  search is sub-millisecond to low-millisecond. Against a live turn clock measured in
  seconds, the engine effectively never has to "race the timer." This is the single biggest
  reason to favour a deterministic core for a *live-timed* tool: the hard constraint is met
  trivially and with no variance.
- **Every number is exact and faithful.** Damage rolls, KO chances, and speed checks come
  from the same calculation logic Showdown itself uses (`@smogon/calc` / `@pkmn` data), so
  the explanation can never disagree with what actually happens on the field. There is no
  hallucination surface — the explainer renders ground-truth state transitions.
- **Zero per-turn marginal cost, fully private, fully offline.** No API calls, no tokens, no
  per-turn spend, no data leaving the machine. A whole season of laddering costs nothing
  beyond compute. It runs against `ps-local` with no external dependency.
- **Deterministic and testable.** The same battle state always yields the same explanation
  and recommendation. That makes it unit-testable against fixtures (replays in → expected
  analysis out), reproducible in bug reports, and trustworthy in a way a stochastic system
  is not. It fits the repo's existing "oracle test against a fixture" pattern.
- **The inference is genuinely tractable in code.** Speed bounds, damage-roll back-solving,
  Choice-lock and item detection, and usage-prior set prediction are all closed-form or
  small-search problems — exactly the kind of thing a deterministic engine does better than
  anything fuzzy.

### Architecture

```
ps-local ──ws──▶ protocol parse ──▶ Battle state (@pkmn/client)
                                      │
                                      ├─▶ Scouting engine ──────▶ revealed-info sheet
                                      ├─▶ Calc sweep (@smogon/calc) ─▶ per-action damage table
                                      ├─▶ Recommendation engine ──▶ ranked actions + EV
                                      └─▶ Turn explainer (templates) ─▶ narration
                                                   │
                                                   ▼
                                              HUD panels
```

- **Scouting engine (`src/battle/scouting/`).** Deterministic inference over the running
  state:
  - *Speed bounds:* from observed move order + known base stats, bound the opponent's speed
    stat each turn; intersect bounds across turns to narrow nature/EV/Scarf.
  - *Damage-roll back-solve:* given an observed % from a known attacker move, invert the calc
    to the set of defensive spreads (or, on our incoming hits, offensive spreads) consistent
    with the roll. Narrows EVs as more data arrives.
  - *Item/ability tells:* Choice-lock (locked into one move), Leftovers/Sitrus from
    end-of-turn or threshold heals, Sash survival at full HP, Intimidate/weather/terrain on
    switch-in, etc. — a rules table mapping observed events → revealed/inferred slot.
  - *Set prediction:* combine revealed slots with `ps-local` usage priors (B-5 metagame data)
    to rank likely remaining moves/item/spread.
- **Calc sweep.** For the upcoming turn, run `@smogon/calc` over every legal action against
  every legal target, using the *inferred* opponent spread ranges. Produces a damage/KO table.
- **Recommendation engine (`src/battle/eval/`).** Two implementable tiers:
  - *Heuristic eval* (ship first): score each action from the calc table + board features
    (KO secured, speed control, hazard/field value, risk of being KO'd back), pick the max.
  - *Shallow search* (upgrade): expectiminimax over one or two plies with chance nodes for
    damage rolls, crits, secondary effects, and an opponent action distribution drawn from
    usage priors. Alpha-beta / move-count pruning to stay well inside the timer.
- **Turn explainer (`src/battle/explain/`).** Templated natural language assembled from the
  parsed event log and the calc results — one template per event type, composed in order.
  Because inputs are exact, sentences are always faithful ("X used Y; Z took N% (rolled in
  the A–B% band for the inferred spread); …").
- **Singles vs Doubles.** Doubles widens the action space (two actives × moves × target
  selection, plus spread-move geometry and redirection/protect interactions). Same engine,
  larger branching: the calc sweep enumerates target combinations; the search prunes harder
  and/or the heuristic tier is used to hold latency. Singles is the smaller special case.

**Libraries / repo fit:** `@pkmn/protocol`, `@pkmn/client`, `@smogon/calc` (+ existing
`@pkmn` data already vendored). New deterministic modules under `src/battle/`. No agent
runtime, no `ANTHROPIC_API_KEY` dependency on this path. Testable with replay fixtures via
the existing Vitest node project.

### Honest edge cases (and how this direction handles them)

- *Heuristic shallowness vs. a strong human:* mitigated by the search upgrade and by leaning
  on usage priors for opponent modelling; the recommendation is explicitly a suggestion.
- *Mechanical-sounding narration:* mitigated with richer templates and by foregrounding the
  numbers (which is the point — players want the math).
- *Protocol/edge-mechanic coverage:* bounded, finite work; covered incrementally with replay
  fixtures. Unknowns degrade to "unrecognised event" rather than a wrong claim.

### Open implementation questions (Direction A)

- How deep does the search need to go before the recommendation is "good enough," and where
  does Doubles force a drop back to heuristics to hold the timer?
- How are inferred spread *ranges* surfaced in the UI without overwhelming the player?
- Exactly which usage cut from `ps-local` feeds the set-prediction priors, and how fresh?

---

## Direction B — LLM agent-based processing

Each turn, hand a structured snapshot of the battle to an LLM agent that reasons about what
happened, updates the scouting picture, and recommends the next move — grounded by tools so
the numbers stay exact. Built on Oak's existing agent runtime and "reason on top of
data" philosophy.

### Steelman

- **The output is exactly the "friendly explanation" the product wants.** The agreed product
  is a *friendly, quick UI that explains what happened* — natural-language explanation is the
  deliverable, and that is precisely what an LLM produces best. It can adapt tone and depth,
  answer follow-ups ("why not switch?"), and explain *reasoning*, not just numbers.
- **It weighs the fuzzy, game-deciding considerations heuristics struggle to encode.** Win
  conditions, momentum, when to sacrifice a Pokémon, baiting a switch, reading a likely
  Protect in Doubles, end-game sequencing — these are exactly the soft, contextual judgments
  a strong model reasons about natively and a hand-written eval function captures poorly.
- **It reuses the platform that already exists.** `src/agent/runtime.ts` already runs a
  Claude tool-loop with a byte-identical prompt-cached prefix, Zod-validated structured
  output (`OakAnswer`), re-emit-on-failure, and an SSE token stream to a field-by-field
  renderer (`AnswerCard`). A battle co-pilot is the same machine pointed at a new prompt,
  a battle-specific tool subset, and a `BattleTurnAnalysis` schema. Much of the hard
  infrastructure is built.
- **It is grounded, not guessing.** Following the repo's core principle, the model never
  invents numbers: tools supply exact damage rolls, speed checks, usage priors, and legality;
  the model *reasons over* them and cites them. The structured output schema carries the same
  inference/uncertainty/citation flags Oak answers already use, so "known vs inferred"
  is explicit on every claim.
- **It extends by prompt, not by code.** New considerations (a new Tera read, a format quirk)
  are prompt/few-shot changes rather than new eval heuristics — fast iteration as the
  metagame shifts each season.
- **Set prediction leans on broad knowledge.** Beyond raw usage priors, the model brings
  general competitive knowledge of common sets and archetypes to predict the opponent's
  hidden slots, then confirms against tools.

### Architecture

```
ps-local ──ws──▶ protocol parse ──▶ Battle state (@pkmn/client)
                                      │
                          deterministic State Assembler
                          (snapshot + pre-computed calc table + legal actions + scouting deltas)
                                      │
                                      ▼
                    Battle agent turn  (tool-loop, cached prefix)
              tools: damage_calc · usage/set_predictor · speed_check · legality
                                      │
                       BattleTurnAnalysis  (Zod-validated, streamed)
                                      │
                                      ▼
                                 HUD panels
```

- **State assembler (deterministic, shared-flavoured but path-specific).** The model is **not**
  fed raw protocol. A deterministic step turns the `@pkmn/client` state into a compact JSON
  turn-context: field, both teams, the revealed-info sheet, the legal action set, and a
  **pre-computed damage-calc table** for the upcoming turn. Pre-computing the calc table is
  the key latency move — it removes most tool round-trips, so the model usually reasons in a
  single pass over facts it already has.
- **Per-turn agent invocation.** On each `|turn|`/`|request|`, run one tool-loop turn:
  - *Cached prefix:* system prompt + battle tool defs + team-preview context, assembled
    byte-identically so Anthropic prompt-caching covers it; only the per-turn delta is fresh.
  - *Tools (grounding):* `damage_calc` (exact rolls), `usage_lookup` / `set_predictor`
    (ps-local priors), `speed_check`, `legality`. Mirrors the existing tool layer; these are
    a *new* tool set for a new surface, so the fixed 11-tool chat contract does not bind here.
  - *Output schema `BattleTurnAnalysis`:* `{ what_happened, revealed_updates[],
    recommendation{ action, rationale, ko_chance, risk }, confidence, citations[],
    inference_flags[] }` — a battle-shaped sibling of `OakAnswer`, Zod-validated with the
    same ≤2 re-emit fallback.
- **Latency strategy (the hard part, since live-timed).** Treated as a first-class design
  problem, not an afterthought:
  - *Prompt-cache* the static prefix → each turn ships only the delta.
  - *Pre-computed calc table* in the snapshot → few or zero tool round-trips per turn.
  - *Stream tokens* to the HUD so the explanation appears as it's written, well before the
    full analysis finishes.
  - *Speculative start:* kick off the analysis the instant the turn resolves in the protocol
    stream, before the player looks — buying wall-clock against the clock.
  - *Fast model + bounded thinking:* a low-latency model (e.g. Haiku/Sonnet) with capped
    reasoning; the schema keeps output compact.
  - *Graceful degradation:* if a turn's analysis is still pending near the clock limit, show
    the pre-computed calc table immediately so the player is never blocked (this is Direction
    B's own fallback within its design — the deterministic numbers it already computed for the
    snapshot).
- **Revealed-info tracking.** The deterministic assembler maintains the scouting *facts*
  (revealed moves/items/abilities, speed bounds); the agent contributes *interpretation*
  (predicted remaining set, what a revealed Choice item implies for next turn), grounded by
  the `set_predictor` tool and flagged as inference in the output.
- **Singles vs Doubles.** Same loop; the snapshot encodes one or two actives and the legal
  *target* dimension, and the prompt/few-shot cover spread moves, redirection, and Protect
  mind-games. Doubles mostly enlarges the action set described to the model, not the
  machinery.

**Libraries / repo fit:** `@pkmn/protocol` + `@pkmn/client` for state (shared), then
`src/agent/runtime.ts` patterns reused for a battle agent mode, a battle tool subset under
`src/agent/tools/` (or a parallel `src/agent/battle-tools/`), a new prompt prefix
(cf. `src/agent/prompts/champions.ts`), and an `AnswerCard`-style renderer for
`BattleTurnAnalysis`. Needs `ANTHROPIC_API_KEY` and incurs per-turn tokens.

### Honest edge cases (and how this direction handles them)

- *Latency under the turn clock:* the central risk; addressed by the caching + pre-compute +
  streaming + speculative-start + degradation stack above.
- *Hallucinated numbers:* removed from the critical path by tool-grounding and the
  pre-computed calc table; the schema forbids un-cited quantitative claims.
- *Per-turn token cost:* bounded by the cached prefix + compact deltas + fast model; a season
  of laddering has a real but predictable spend.
- *Consistency turn-to-turn:* mitigated by carrying the structured scouting sheet forward as
  state rather than re-deriving it from prose each turn.

### Open implementation questions (Direction B)

- What is the real p95 turn latency with caching + pre-computed calc + streaming, and does it
  fit the tightest competitive turn clocks (notably Doubles, with more to describe)?
- How much of the scouting sheet is deterministic (assembler) vs. model-maintained, and where
  exactly is the validator boundary?
- Which model/effort tier hits the latency/quality point for live play, and does it differ
  between Singles and Doubles?
- Does the battle agent share `src/agent/tools/` with the chat agent or get its own parallel
  set, given it is deliberately outside the fixed 11-tool contract?

---

## Shared open questions (neutral — apply to either direction)

- **ps-local surface:** which exact endpoints/streams it exposes for live battles, usage
  stats, and replays; how a self-hosted live server is reached without violating the current
  "no network at ingest" guarantee (likely: live battle traffic is runtime, not ingest;
  usage data is ingested separately per B-5).
- **HUD design:** how the field, revealed-info badges, turn log, and recommendation panel lay
  out for both Singles and Doubles; how inferred ranges are shown without clutter.
- **Format coverage order:** Singles and Doubles are both in scope, but which ruleset
  (VGC/BSS/Smogon tier) is wired through `ps-local` first.

## Next steps

Both directions are to be prototyped independently against `ps-local`. The decision between
them is deliberately **out of scope for this document** and will be made after each prototype
exists.
