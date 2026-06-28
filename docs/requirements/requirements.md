# Oak — Business Requirements

## Overview

Oak is a **personal, web-based chat agent** that answers natural-language
questions about Pokemon — their moves, abilities, types, stats, evolutions,
items, and game-mechanic interactions. The user types questions in plain
English (e.g. _"find me a Pokemon that can learn both Trick Room and
Will-O-Wisp"_ or _"does Fake Out work on Farigiraf?"_) and gets back a direct
answer accompanied by the agent's reasoning and the data sources it relied on.

All data is sourced from **[PokeAPI](https://pokeapi.co/)**. The agent is
expected to choose the most appropriate PokeAPI endpoint(s) for each question
so that API usage is efficient rather than brute-forced.

The product serves two blended use cases equally:

1. **Competitive team-building** — finding Pokemon that fit a strategy (Trick
   Room setters, status spreaders, priority-immune sweepers) and reasoning
   about battle mechanics.
2. **General Pokedex curiosity** — looking up individual Pokemon, evolutions,
   type matchups, items, and trivia.

A defining characteristic of Oak is that it is **not just a data filter** —
it reasons about game mechanics. PokeAPI supplies the raw building blocks (move
priority values, ability effect text, type charts), but deducing how those
pieces interact ("Fake Out is a priority move; Armor Tail negates priority
moves; therefore Fake Out fails") is reasoning the agent performs on top of the
data.

### Goals

- Let the user ask Pokemon questions conversationally and get trustworthy,
  well-explained answers without manually navigating PokeAPI or wikis.
- Support compound, filter-style queries across moves, abilities, types, and
  stats.
- Reason about move/ability/type interactions, while being transparent about
  what is a stated fact versus an inference.

### Success Criteria

- The agent correctly answers the user's representative questions, including:
  - Multi-move learnset filters (e.g. Trick Room **and** Will-O-Wisp).
  - Mechanics interactions (e.g. the Fake Out / Armor Tail / Farigiraf case).
- Every answer the user receives includes the reasoning and the cited data, so
  the user can verify competitive calls.
- The user trusts the answers enough to use them for real team-building
  decisions, in part because the agent flags when it is uncertain.

## Users and Personas

There is a single user persona:

- **The Owner (you).** A Pokemon fan comfortable with competitive concepts
  (Trick Room, priority, abilities like Armor Tail) who wants a faster, smarter
  way to query Pokemon data than browsing PokeAPI or wiki pages by hand. Uses
  the tool both for serious team-building and casual curiosity. Technically
  comfortable. Single user — no other roles, no sharing, no accounts.

## User Stories

> IDs are stable. Append new stories/criteria; never renumber existing ones.

### Querying & Filtering

- **US-1** — As the user, I want to find Pokemon by the moves they can learn,
  including combinations of multiple moves, so that I can build around specific
  move sets.
  - **AC-1.1** — Given a query naming one or more moves (e.g. "Trick Room and
    Will-O-Wisp"), when I submit it, then the agent returns the set of Pokemon
    that can learn **all** named moves under the active generation rules
    (see BR-7).
  - **AC-1.2** — Given a single-move query (e.g. "what can learn Will-O-Wisp"),
    then the agent returns Pokemon able to learn that move, citing the move's
    `learned_by_pokemon` data as the source.
  - **AC-1.3** — Given a move name that does not exist or is misspelled, then
    the agent states it could not resolve the move and, where possible,
    suggests the closest valid move name rather than returning an empty result
    silently.

- **US-2** — As the user, I want to filter Pokemon by ability and/or type, so
  that I can narrow candidates to those matching a strategy.
  - **AC-2.1** — Given a query specifying a type (e.g. "Fire types"), an ability
    (e.g. "Levitate"), or both, then the agent returns Pokemon matching all
    specified criteria.
  - **AC-2.2** — Given a combined filter spanning categories (e.g. "Fire types
    that can learn Will-O-Wisp with the ability Flash Fire"), then the agent
    applies all constraints together and returns the intersection.

- **US-3** — As the user, I want to query and sort Pokemon by base stats, so
  that I can find, for example, the fastest Pokemon or those above a stat
  threshold.
  - **AC-3.1** — Given a superlative query (e.g. "fastest Pokemon"), then the
    agent returns Pokemon ranked by the relevant base stat, scoped to the
    active data set (BR-1).
  - **AC-3.2** — Given a threshold query (e.g. "base Attack over 130"), then the
    agent returns Pokemon whose base stat meets the condition.
  - **AC-3.3** — Stat queries can be combined with move/ability/type filters
    (e.g. "Fire types with base Speed over 100 that can learn Will-O-Wisp").

### Information Lookups

- **US-4** — As the user, I want to look up a single Pokemon's profile, so that
  I can see its types, abilities, base stats, and sprite at a glance.
  - **AC-4.1** — Given a Pokemon name, then the agent returns its type(s),
    ability/abilities (including hidden ability where applicable), base stats,
    and a sprite image.

- **US-5** — As the user, I want to ask how a Pokemon evolves, so that I can
  understand its evolution line and requirements.
  - **AC-5.1** — Given an evolution query (e.g. "how does Eevee evolve"), then
    the agent returns the evolution chain and the condition(s) for each stage
    (level, item, friendship, etc.) as provided by PokeAPI.

- **US-6** — As the user, I want to ask about type effectiveness/matchups, so
  that I can understand offensive and defensive coverage.
  - **AC-6.1** — Given a matchup query (e.g. "what beats Water types", "is
    Ground super effective against Flying"), then the agent answers using the
    latest-generation type effectiveness relationships (BR-5).

### Mechanics & Interaction Reasoning

- **US-7** — As the user, I want to ask whether and how a move, ability, or type
  interaction works, so that I can make correct in-battle decisions.
  - **AC-7.1** — Given an interaction question (e.g. "does Fake Out work on
    Farigiraf?"), then the agent identifies the relevant move properties and
    ability effect text, reasons through the interaction, and gives a clear
    answer with the "why" (e.g. "Fake Out is a +3 priority move; Armor Tail
    negates priority moves; if Farigiraf has Armor Tail, Fake Out fails").
  - **AC-7.2** — When an answer depends on a condition (e.g. which ability the
    Pokemon actually has), then the agent states the condition explicitly
    rather than assuming.
  - **AC-7.3** — When part of the answer is the agent's deduction rather than a
    fact directly stated in PokeAPI data, then the agent marks that part as an
    inference and notes any uncertainty or edge cases (BR-3).

### Items, Held Items & Battle Math

- **US-8** — As the user, I want to ask about items and held items, so that I
  can understand item effects and which Pokemon are found holding items.
  - **AC-8.1** — Given an item query (e.g. "what does Leftovers do", "what
    item does Snorlax hold in the wild"), then the agent returns the item's
    effect text and/or wild-held-item data from PokeAPI.

- **US-9** — As the user, I want help with damage calculations and stat math
  involving EVs, IVs, and natures, so that I can evaluate competitive scenarios.
  - **AC-9.1** — Given a damage-calc question, then the agent computes a result
    using the standard Pokemon damage/stat formulas, **states the assumptions
    it used** (level, EVs/IVs, nature, modifiers), and flags the result as an
    estimate (BR-6).
  - **AC-9.2** — Given a stat-math question (e.g. "what's Garchomp's Speed at
    level 50 with max Speed EVs and a Jolly nature"), then the agent computes
    the stat using PokeAPI base stats plus the standard stat formula and shows
    its work.

### Conversation, Presentation & Transparency

- **US-10** — As the user, I want to refine results across multiple turns, so
  that I can narrow down without restating everything.
  - **AC-10.1** — Given a follow-up that references the previous answer (e.g.
    "now only the Fire types", "which of those is fastest?"), then the agent
    applies the refinement to the prior result set within the same chat
    session.
  - **AC-10.2** — The agent maintains context within a session (the current
    candidate set, the Pokemon/topic under discussion) for follow-ups.

- **US-11** — As the user, I want answers to include sprites and visual cues, so
  that the chat is easy to scan.
  - **AC-11.1** — When a specific Pokemon is the subject of an answer, then the
    agent displays its sprite/artwork.
  - **AC-11.2** — Type information is presented with visual type indicators
    (e.g. type color badges) alongside text.

- **US-12** — As the user, I want every answer to show the agent's reasoning and
  cite its sources, so that I can trust and verify it.
  - **AC-12.1** — Each answer includes (a) the direct answer, (b) the reasoning
    behind it, and (c) the specific data the agent relied on (e.g. the ability's
    effect text, the move's priority value, the stat figures).
  - **AC-12.2** — When the agent is uncertain or is inferring beyond stated
    data, that uncertainty is visible in the answer (BR-3).

- **US-13** — As the user, I want the agent to be clear about which generation's
  data an answer is based on, so that I'm not misled by mixed-generation results.
  - **AC-13.1** — Answers are based on Gen 9 (Scarlet/Violet, including DLC) by
    default (BR-1).
  - **AC-13.2** — When a Pokemon is not present in Gen 9 and the agent falls
    back to older data, the agent flags this and names the generation/source
    used (BR-1).

## Functional Requirements

### Natural-Language Query Understanding

- The agent accepts free-form English questions and determines the user's
  intent and the relevant entities (Pokemon, moves, abilities, types, stats,
  items).
- It maps the question to the data it needs and selects appropriate PokeAPI
  endpoint(s) accordingly (see Constraints — efficient endpoint selection).
- It supports compound queries combining multiple filter dimensions (moves +
  type + ability + stats) in a single question.

### Data Domains — In Scope

- **Pokemon:** species, types, abilities (including hidden abilities), base
  stats, sprites/artwork, and forms.
- **Moves:** type, power, accuracy, PP, priority, damage class
  (physical/special/status), target, effect text, and the list of Pokemon that
  can learn each move.
- **Abilities:** effect text/description and which Pokemon have them.
- **Types:** full type effectiveness relationships (offensive and defensive).
- **Evolutions:** evolution chains and conditions.
- **Items & held items:** item effects and wild-held-item data.
- **Battle math:** damage calculation and stat computation involving EVs, IVs,
  and natures (computed by the agent — PokeAPI provides the inputs, not a
  calculator).

### Data Domains — Out of Scope

See the [Out of Scope](#out-of-scope) section.

### Answer Composition

- Every answer is composed of: the direct answer, the reasoning, the cited
  source data, and (when relevant) uncertainty flags and the generation/source
  used.
- Answers about a specific Pokemon include a sprite; type info uses visual type
  badges.

### Conversational Session

- The agent retains context within a chat session to support multi-turn
  refinement of prior results and follow-up questions.

## Business Rules

> IDs are stable and referenceable by the architecture and tests.

- **BR-1 — Generation baseline with flagged fallback.** Gen 9 (Scarlet/Violet,
  incl. DLC) is the baseline source of truth. Pokemon present in Gen 9 are
  always evaluated on Gen 9 data. Pokemon **not** in Gen 9 are still included,
  using their most recent prior appearance, and every such fallback is
  explicitly flagged to the user with the generation/source used.
- **BR-2 — Version-aware learnsets.** "Can learn move X" is evaluated against
  the learnset for the active generation/version group (Gen 9 by default per
  BR-1), since learnsets are version-specific in PokeAPI.
- **BR-3 — Inference must be flagged.** Any part of an answer that is the
  agent's deduction rather than a fact directly stated by PokeAPI data must be
  identified as an inference, with uncertainty and known edge cases noted.
- **BR-4 — Cite sources.** Every answer cites the specific PokeAPI data it
  relied on (e.g. the exact ability effect text, move priority value, base stat
  figures) so the user can verify it.
- **BR-5 — Latest type chart.** Type effectiveness uses the latest-generation
  type relationships.
- **BR-6 — Damage calc is an explicit estimate.** Damage and stat calculations
  use the standard Pokemon formulas; the agent must state all assumptions
  (level, EVs, IVs, nature, modifiers) and present the result as an estimate,
  not an authoritative game value.
- **BR-7 — Multi-move filter = intersection.** A query naming multiple moves
  returns only Pokemon that can learn **every** named move (set intersection of
  the per-move learnsets), under BR-2.
- **BR-8 — Respect PokeAPI fair use.** The agent must avoid redundant/abusive
  API calls; locally caching PokeAPI data is expected (see Constraints).
- **BR-9 — Resolve-or-clarify entities.** When a named entity (Pokemon, move,
  ability, item) cannot be resolved, the agent says so and offers the closest
  valid match rather than returning a silent/empty result.

## Non-Functional Requirements

- **Single user.** Personal tool; no authentication, accounts, or multi-user
  access control required.
  - **SUPERSEDED (auth dimension) by B-1 — Account Creation.** As of the
    Account Creation feature, Oak is multi-tenant with passwordless
    email-OTP accounts plus a retained anonymous guest mode, so the "no
    authentication / accounts / multi-user access control" stance no longer
    holds for the auth dimension. History preserved above for context. See
    `docs/features/account-creation/` (requirements `BR-A1..A11`,
    `AUTH-US-1..7`; architecture `design.md`). The remainder of the product
    stays personal-scale (single agent persona, no admin/owner role).
- **Platform.** Web-based chat UI, used in a desktop browser. Sprites + text
  presentation.
- **Performance.** Conversational responsiveness; a few seconds per answer
  (PokeAPI fetches + reasoning) is acceptable. Compound filters may take
  slightly longer but should remain interactive.
- **Reliability.** Best-effort personal tool. Graceful handling of PokeAPI being
  slow/unavailable (inform the user rather than fail silently) is desirable.
- **Efficiency / fair use.** Minimize PokeAPI load via sensible endpoint
  selection and local caching (BR-8).
- **Transparency by default.** Reasoning + sources + uncertainty flags are part
  of the standard answer format, not an optional mode (US-12).

## UI/UX Vision

- **Feel:** a clean chat interface — the user types a question and receives a
  structured answer in the conversation thread.
- **Answer layout:** direct answer up top, followed by reasoning and the cited
  sources; uncertainty/fallback flags clearly visible.
- **Visuals:** Pokemon sprites/artwork shown for specific-Pokemon answers; type
  information rendered with type-colored badges. Otherwise text-forward and
  uncluttered.
- **Conversation:** supports back-and-forth refinement; prior answers remain
  visible in the thread for context.
- **Reference points / open:** no specific reference app was named — look-and-
  feel detail can be refined during design.

## Constraints and Preferences

> Inputs for the solution architect — not decisions made here.

- **Data source (hard constraint):** all Pokemon data comes from PokeAPI.
- **Efficient endpoint selection (explicit user requirement):** the agent should
  pick the most appropriate PokeAPI endpoint(s) per question for optimal API
  usage, rather than over-fetching. (Note: PokeAPI's move resource already
  lists the Pokemon that can learn it via `learned_by_pokemon`, which supports
  efficient move-based filtering — architect to design the data-access
  strategy.)
- **Latest-generation data:** Gen 9 baseline with flagged fallback (BR-1).
- **Local caching expected** to respect PokeAPI fair-use policy (BR-8).
- **Platform preference:** web chat UI for a single user.

## Open Questions

- **Damage-calc inputs:** what default assumptions should the agent use when the
  user doesn't fully specify a scenario (level, EVs/IVs spread, nature, weather,
  items, terrain)? How interactive should it be in asking for missing inputs?
- **Forms & regional variants:** how thoroughly should alternate forms and
  regional variants (Alolan/Galarian/Paldean, Mega-style forms, etc.) be
  handled, given they can differ in type/stats/abilities? Default assumption:
  treat them as distinct entities, but depth/coverage needs confirmation.
- **Chat history persistence:** should conversations persist across sessions, or
  is in-session memory sufficient? (Assumed in-session only for now.)
- **Data freshness:** PokeAPI may lag behind the very latest game patches/DLC.
  Is the user comfortable with PokeAPI's freshness, and should the agent flag
  when data may be stale?
- **Specific latency target:** is "a few seconds" acceptable, or is there a
  firmer responsiveness expectation for heavier compound queries?

## Out of Scope

The following are explicitly **not** part of this build. A builder should not
add these without them being moved into scope:

- **Egg moves & breeding** — breeding compatibility, egg groups, egg-move
  inheritance.
- **Locations & encounters** — where to catch a Pokemon, encounter rates,
  version exclusives.
- **Multi-user features** — accounts, authentication, sharing, permissions.
  - **SUPERSEDED (auth dimension) by B-1 — Account Creation.** Accounts and
    authentication are now in scope and shipped (passwordless email-OTP +
    guest mode + tiered rate limits); see `docs/features/account-creation/`.
    History preserved above. Still out of scope: cross-account **sharing** and
    elevated **permissions/roles** — registration is open and all accounts are
    peers (no admin/owner role).
- **Native mobile / chat-platform (Discord/Slack) clients** — web chat UI only.
- **A full battle simulator** — the agent reasons about interactions and can
  estimate damage, but it does not simulate full turn-by-turn battles.
- **Non-PokeAPI data sources** — data comes from PokeAPI; the agent does not
  scrape wikis or other sites for game data.
