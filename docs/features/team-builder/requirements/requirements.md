# Team Builder — Business Requirements

> Refines backlog item **B-2 — Team building**
> (`docs/backlog.md`) into a buildable spec. Builds on **B-1 — Account Creation**
> (shipped: per-account identity + isolation) and is adjacent to **B-3 — Chat
> History** (shipped: per-account, resumable conversations). IDs below are stable
> and addressable downstream — append, never renumber.

## Overview

Today Oak can *reason about* a competitive team but cannot *save* one — every
answer is a one-off. The Team Builder lets the user create, name, and revisit
**fully-specified competitive teams**, and lets the chat agent reason against a
chosen team ("is my team weak to Trick Room?") instead of a team the user has to
re-describe each turn.

Teams are built two complementary ways:

1. **Manually**, on a dedicated Teams page, where the user fills in each Pokémon's
   full competitive set.
2. **Agent-assisted**, in chat, where the user asks the agent to draft or modify a
   team ("build me a Trick Room team", "swap in a Fire type"); the agent *proposes*
   a team and the user explicitly applies it to saved storage.

A team carries the **full competitive set** per Pokémon (species, ability, held
item, four moves, nature, EV spread, IVs, Tera type, level). The builder follows a
**warn-but-allow** philosophy: it surfaces legality and validity problems but never
blocks the user from saving — consistent with the product's "reason on top of data,
explain the why, flag uncertainty" ethos.

Teams are **per-account** (B-1 isolation) and **format-aware** — every team belongs
to exactly one format (`scarlet-violet` | `champions`), consistent with the index's
per-format split.

### Goals

- Turn one-off team-building answers into a durable, revisitable workflow: a library
  of named teams the user owns.
- Let the agent ground team questions in an actual saved roster rather than a
  re-stated description.
- Support real competitive practice: full sets, Showdown-paste interchange, and
  honest legality/validity warnings.

### Success Criteria

- The user can build a complete 6-Pokémon team (with full sets) on the Teams page,
  save it, leave, and return to find it intact.
- The user can paste a Showdown team and get a saved team back; and can export any
  saved team to Showdown text that round-trips.
- In a conversation with an active team selected, asking "is my team weak to X?"
  produces an answer that reasons against the actual saved sets, with the product's
  usual reasoning + citations.
- A team with an illegal/invalid detail (e.g. EV total over 508, a move not in the
  species' learnset) can still be saved, and the offending detail is clearly flagged.

## Users and Personas

Unchanged from the core product: a single persona, **the Owner** — a
competitively-literate Pokémon fan, technically comfortable, using Oak for both
serious team-building and casual curiosity. With B-1, accounts exist and all data is
per-account, but there is still **no admin/owner role and no cross-account sharing** —
every account is a peer and sees only its own teams.

## User Stories

> IDs are stable. Acceptance criteria are objectively testable. Append; never renumber.

### Creating & Editing Teams (manual)

- **TEAM-US-1** — As the user, I want to create and name a team on a dedicated Teams
  page, so that I have a place to assemble and keep a roster.
  - **AC-1.1** — Given I am signed in and on the Teams page, when I create a new team
    and give it a name, then a team is saved to my account with that name and the
    currently-active format, and it appears in my team list.
  - **AC-1.2** — Given I create a team without typing a name, when I save, then the
    system assigns a non-empty default name (e.g. "Untitled team") rather than
    rejecting the save.
  - **AC-1.3** — Given another user's account, when I view my team list, then I see
    only my own teams (per-account isolation, BR-T11).

- **TEAM-US-2** — As the user, I want to add up to six Pokémon to a team and specify
  each one's full competitive set, so that my team reflects exactly what I'd run.
  - **AC-2.1** — Given a team, when I add a Pokémon, then I can set its species,
    ability, held item, up to four moves, nature, EV spread, IV spread, Tera type, and
    level (BR-T1 defines the set fields).
  - **AC-2.2** — Given I am choosing a species, ability, move, or item, when I search,
    then choices are drawn from the team's format index for that entity, and an
    unrecognized name is resolved-or-flagged rather than silently accepted as empty
    (BR-T7, consistent with the core BR-9).
  - **AC-2.3** — Given a Pokémon with its set, when a specific Pokémon is shown, then
    its sprite/artwork is displayed and its type(s) use type-colored badges
    (consistent with the core US-11).

- **TEAM-US-3** — As the user, I want to save a team that is incomplete or
  competitively invalid, so that I can keep works-in-progress without fighting the
  tool.
  - **AC-3.1** — Given a team with fewer than six Pokémon, or Pokémon with empty set
    slots, when I save, then the save succeeds and the team is marked incomplete
    (informational), not rejected (BR-T4).
  - **AC-3.2** — Given a team with a validity/legality problem (BR-T5 list), when I
    save, then the save succeeds and each problem is shown as a warning attached to the
    offending slot (BR-T6 — warn but allow).

- **TEAM-US-4** — As the user, I want to rename, duplicate, and delete teams, so that
  I can manage a library and branch variants.
  - **AC-4.1** — Given a saved team, when I rename it, then the new name persists and
    is reflected everywhere the team is listed.
  - **AC-4.2** — Given a saved team, when I duplicate it, then a new independent team is
    created with a distinct name (e.g. suffixed "copy") and identical sets, and editing
    the copy does not change the original.
  - **AC-4.3** — Given a saved team, when I delete it, then I am asked to confirm, and
    on confirmation the team is permanently removed from my account and from any
    conversation that had it active (BR-T10).

### Validity & Legality Feedback

- **TEAM-US-5** — As the user, I want the builder to tell me when a set is illegal or
  invalid (without stopping me), so that I know what would fail in a real match.
  - **AC-5.1** — Given an EV spread whose total exceeds 508, or any single EV outside
    0–252, then a warning identifies the offending stat(s) and the rule (BR-T5).
  - **AC-5.2** — Given a move not present in the species' learnset for the team's
    format/generation, an ability not legal for the species, or a held item not legal
    in the team's format, then each is flagged with the reason (BR-T5).
  - **AC-5.3** — Given two Pokémon of the same species, or (where the format's item
    clause applies) two Pokémon holding the same item, then a team-level warning names
    the clause and the involved slots (BR-T5).
  - **AC-5.4** — Given a team flagged with one or more warnings, when I view the team,
    then a summary of its warnings is visible at the team level (not only per-slot).

### Agent-Assisted Building (in chat)

- **TEAM-US-6** — As the user, I want to ask the agent to draft a team in chat, so that
  I can start from a strategy instead of a blank page.
  - **AC-6.1** — Given a team-construction request in chat (e.g. "build me a Trick Room
    team"), then the agent proposes a team — species and sets to the extent it can
    justify — carrying the product's usual reasoning, citations, inference/uncertainty
    flags, and format/generation tag (BR-T8).
  - **AC-6.2** — Given the agent has proposed a team, when I take no action, then
    nothing is written to my saved teams — the proposal exists only in the
    conversation until I apply it (BR-T8 — propose, then user applies).
  - **AC-6.3** — Given a proposed team, when I apply it, then I can save it as a new
    named team **or** apply it onto an existing team, and the result is a normal saved
    team (subject to the same warn-but-allow validation, BR-T6).

- **TEAM-US-7** — As the user, I want to ask the agent to modify a team in chat, so
  that I can iterate conversationally.
  - **AC-7.1** — Given a conversation with an active team, when I ask for a change
    ("swap in a Fire type", "give Gholdengo a Choice Scarf"), then the agent proposes
    the edited set as a diff/proposal I can apply; the active team is **not** mutated
    until I apply (BR-T8).

### Active Team & Chat Integration

- **TEAM-US-8** — As the user, I want to choose an active team for a conversation, so
  that the agent reasons against the right roster without me re-describing it.
  - **AC-8.1** — Given a conversation, when it starts, then it has **no** active team;
    I must explicitly select one (BR-T9 — defaults empty, manual select).
  - **AC-8.2** — Given I select an active team for a conversation, then that selection
    persists with the conversation (including on resume per B-3), and is shown in the
    chat UI.
  - **AC-8.3** — Given a conversation whose format mode is X (the Champions toggle),
    when I pick an active team, then only teams whose format is X are selectable, and
    changing the format mode clears an active team whose format no longer matches
    (BR-T9, BR-T3).

- **TEAM-US-9** — As the user, I want the agent to use my active team only when my
  question is about it, so that ordinary lookups stay unaffected and predictable.
  - **AC-9.1** — Given a conversation with an active team, when I ask a team-relevant
    question ("is my team weak to Trick Room?", "what's my team's Speed control?"),
    then the answer reasons over the active team's actual sets (BR-T9).
  - **AC-9.2** — Given a conversation with an active team, when I ask an unrelated
    lookup ("what does Leftovers do?"), then the answer does not inject or assume the
    team (only-when-asked, BR-T9).
  - **AC-9.3** — Given the agent reasons about an active team that carries validity
    warnings, when relevant to the answer, then the agent surfaces those warnings
    rather than treating an illegal set as legal (BR-T6).

### Interchange (Showdown paste)

- **TEAM-US-10** — As the user, I want to import a team from Pokémon Showdown paste
  text, so that I can bring in teams from elsewhere.
  - **AC-10.1** — Given valid Showdown/pokepaste text, when I import it, then a new
    team is created with each Pokémon's set parsed into the corresponding fields
    (BR-T1), in the currently-active format.
  - **AC-10.2** — Given paste text containing an unresolved name (species/move/item/
    ability), when I import, then that entry is flagged (resolved-or-clarify, BR-T7)
    and the rest of the team still imports — import is not aborted wholesale.
  - **AC-10.3** — Given paste text containing an illegal/invalid value (e.g. EVs over
    508, a move not in the learnset), when I import, then the team imports with that
    value preserved and the corresponding warning attached (warn but allow, BR-T6).

- **TEAM-US-11** — As the user, I want to export a saved team to Showdown paste text,
  so that I can use it in Showdown, a damage calculator, or share it manually.
  - **AC-11.1** — Given a saved team, when I export it, then I get Showdown-format text
    covering each Pokémon's set, in a form I can copy.
  - **AC-11.2** — Given a team exported to text and then re-imported, then the resulting
    team's sets match the original (round-trip for all fields the format represents).

## Functional Requirements

### Team Data Model (business view)

- A **team** belongs to one account and one format (`scarlet-violet` | `champions`),
  has a name, a created/updated timestamp, and an ordered list of up to **six**
  Pokémon slots. Teams may be incomplete (fewer than six; slots with empty fields).
- A **team Pokémon (set)** captures the full competitive specification — see BR-T1.
- A team carries derived **validity/legality warnings** (BR-T5) computed against its
  format; warnings are advisory metadata, never a save gate.

### Manual Builder (Teams page)

- A dedicated Teams area lists the user's teams (filterable by format) and opens a
  data-dense editor for a single team.
- The editor supports adding/removing/reordering Pokémon and editing every set field
  (BR-T1) with format-scoped pickers for species/ability/move/item (BR-T7).
- The editor shows sprites and type badges (core US-11 conventions) and surfaces
  per-slot and team-level warnings (TEAM-US-5).
- Standard management: create, name, rename, duplicate, delete-with-confirm
  (TEAM-US-4).

### Agent-Assisted Building (chat)

- The agent can propose a new team or an edit to the active team in response to a
  chat request, expressed in the normal `OakAnswer` form (reasoning, citations,
  flags, generation tag).
- A proposal is **inert** until the user applies it; applying writes a new team or
  updates an existing one (TEAM-US-6, TEAM-US-7, BR-T8).
- The agent needs **read access to the active team's full set** to reason about it
  (TEAM-US-9). *How* that access is wired — a new tool vs. context injection vs. the
  fixed 11-tool contract — is a design decision handed to the architect (see
  Constraints).

### Validation (warn-but-allow)

- The builder computes warnings for: EV total/per-stat caps, IV ranges, learnset
  legality, ability legality, item legality, species clause, and item clause where the
  format applies (BR-T5). It never blocks a save (BR-T6).

### Active Team & Conversation Integration

- A conversation may have at most one active team; it defaults to none and is
  user-selected (BR-T9). The selection is part of conversation state and survives
  resume (B-3). The active team must match the conversation's format mode (BR-T3).

### Interchange

- Import parses Showdown/pokepaste text into a team (BR-T1 fields), applying
  resolve-or-clarify (BR-T7) and warn-but-allow (BR-T6). Export serializes a saved
  team to Showdown text, round-tripping all represented fields (TEAM-US-10/11).

## Business Rules

> IDs are stable and referenceable by the architecture and tests.

- **BR-T1 — Full competitive set.** A team Pokémon is specified by: **species** (and
  form/variant where applicable), **ability**, **held item**, up to **four moves**,
  **nature**, **EV spread** (per the six stats), **IV spread** (per the six stats,
  default 31), **Tera type**, and **level** (default per the format's convention).
  Optional cosmetic fields (nickname, gender, shininess) are preserved on Showdown
  import/export where present but are not competitively significant.
- **BR-T2 — Per-account ownership.** Every team belongs to exactly one account; teams
  are private to that account (no sharing). Inherits B-1 isolation (BR-A9).
- **BR-T3 — Format-bound.** Every team belongs to exactly one format
  (`scarlet-violet` | `champions`). A team is only valid/active within its own format;
  the active-team selection for a conversation must match that conversation's format
  mode.
- **BR-T4 — Partial teams allowed.** A team need not be complete (six Pokémon, all
  slots filled) to be saved. Incompleteness is informational, never a save gate.
- **BR-T5 — Validity/legality checks (advisory).** The builder evaluates, at minimum:
  EV total ≤ 508 and each EV in 0–252; each IV in 0–31; each move present in the
  species' learnset for the team's format/generation; ability legal for the species;
  held item legal in the team's format; **species clause** (no duplicate species);
  and **item clause** (no duplicate held item) where the format applies. Each failure
  becomes a warning naming the rule and the offending slot(s).
- **BR-T6 — Warn but allow.** No validity/legality failure (BR-T5) ever blocks
  saving, importing, or applying a team. Failures are surfaced as warnings only. When
  the agent reasons over a team, it must respect and surface those warnings rather
  than assume legality.
- **BR-T7 — Resolve-or-clarify entities.** When a named entity (species/move/ability/
  item) entered manually or via import cannot be resolved, the system flags it and
  offers the closest valid match rather than silently accepting an empty value
  (consistent with the core BR-9).
- **BR-T8 — Agent proposes, user applies.** In agent-assisted mode the agent never
  mutates saved teams directly. It proposes a team or edit within the conversation;
  only an explicit user "apply" action creates or updates a saved team. Applied teams
  are subject to BR-T6.
- **BR-T9 — Active team is per-conversation, opt-in, on-demand.** Active team is a
  per-conversation selection that defaults to none and must be set manually. The
  agent reasons against it **only when the user's question pertains to the team**; it
  is not injected into unrelated answers.
- **BR-T10 — Deletion is permanent and confirmed.** Deleting a team requires
  confirmation, permanently removes it, and clears it as the active team from any
  conversation that referenced it.
- **BR-T11 — Showdown interchange.** Teams import from and export to Pokémon Showdown
  paste format. Import is resilient (per-entry resolve-or-clarify, warn-but-allow,
  no wholesale abort); export round-trips every field the format represents.

## Non-Functional Requirements

- **Per-account, signed-in feature.** Team building requires an account (B-1); guests
  do not get persisted teams. Isolation per BR-A9.
- **Performance.** Builder interactions (add/edit/save/import/export) feel
  immediate — sub-second for local edits; saving and importing a full six-Pokémon
  team completes within a couple of seconds. Selecting an active team and asking a
  team question keeps the conversation's usual responsiveness (a few seconds per
  answer); carrying the active team must not materially degrade chat latency.
- **Retention.** Teams persist indefinitely per account until the user deletes them
  (consistent with chat-history retention, B-3).
- **Platform.** Desktop web, consistent with the rest of the product (the Teams page
  is data-dense and desktop-first).
- **Transparency.** Validity/legality warnings and the agent's reasoning/citations are
  always visible, not an optional mode (consistent with core US-12).

## UI/UX Vision

- **Teams page:** a list of the user's teams (name, format, sprites preview,
  incomplete/warning badges), filterable by format, with create/rename/duplicate/
  delete actions; opening a team shows a data-dense editor with one panel per Pokémon
  covering all set fields, sprites, type badges, and inline per-slot warnings plus a
  team-level warning summary.
- **Import/export:** a paste-in dialog for Showdown text on import; a copyable text
  output on export.
- **Chat integration:** a clear, unobtrusive **active-team selector** in the
  conversation UI (defaulting to "none"), scoped to the conversation's format; when a
  team is active it's visibly indicated. Agent team proposals render in the normal
  answer stream with an explicit **Apply** affordance (save as new / apply to
  existing).
- **Feel:** consistent with the existing clean, text-forward chat plus the product's
  sprite + type-badge conventions. No new visual language beyond what the design
  system already establishes.

## Constraints and Preferences

> Inputs for the solution architect — not decisions made here.

- **Builds on shipped features.** Identity/isolation from B-1 (Account Creation);
  conversation persistence/resume from B-3 (Chat History). Active-team-per-conversation
  extends conversation state and should integrate with B-3's storage and resume path.
- **Data from `@pkmn`, per format.** Species/move/ability/item/learnset/type data and
  legality come from the existing per-format index (`gen-provider.ts` →
  Postgres/Drizzle), reusing repos — not a new data source. Stat/EV/IV/nature math
  reuses the existing formulas layer.
- **Agent read-access to the active team is the key architectural call.** The agent
  must be able to read the active team's full sets to satisfy TEAM-US-9, but the
  product fixes an **11-tool contract** and the active format is **server-controlled,
  not an LLM-visible input**. Whether the team enters via a new tool, context
  injection, or another mechanism — and how that interacts with the prompt-cached
  prefix, `MAX_ITERATIONS`, and the tool contract — is for the architect. The active
  team, like the format mode, should not become a scope-widening LLM input.
- **Apply/propose is a chat-side write path.** Agent proposals are inert; the "apply"
  action is a normal authenticated write (not part of the agent tool loop). The
  architect decides where that endpoint/flow lives.
- **Showdown-paste parsing/serialization** should reuse in-ecosystem tooling where it
  exists (the `@pkmn` ecosystem already underpins ingest) rather than a hand-rolled
  parser, at the architect's discretion.

## Open Questions

- **Computed stats in the editor.** The app already computes stats from base
  stats + EV/IV/nature (US-9 formulas). Should the editor display each Pokémon's
  computed stats live? (Assumed: yes, read-only, as a natural reuse — confirm.)
- **Damage-calc hand-off.** Should an active/edited team feed the agent's damage-calc
  answers (US-9) directly ("calc Gholdengo vs. my team's Garchomp")? This overlaps
  B-5 (competitive battling) and is likely a later increment — confirm scope.
- **Level defaults & format conventions.** Default level (e.g. 50 for VGC-style vs.
  100) and which clauses (item clause, Tera restrictions) actually apply per format
  need to be pinned per format/regulation during design.
- **Agent-proposed set completeness.** How complete must an agent proposal be (full
  EV spreads and items, or species + roles with sets left to the user)? Affects
  TEAM-US-6 expectations.
- **Team count guardrail.** "Many teams" is intended; an abuse-backstop cap (if any)
  is an open detail, not a policy — mirrors the chat-history retention note.

## Out of Scope

A builder should not add these without their being moved into scope:

- **Sharing / collaboration.** No public teams, share links, or cross-account access —
  teams are private to one account (consistent with the product's no-sharing stance).
- **Battle simulation.** No turn-by-turn battles or live matches (that is B-5 /
  globally out of scope); the agent reasons about and can estimate, it does not
  simulate.
- **Metagame data.** No usage %, tier placement, or sample/"recommended" competitive
  sets sourced from Showdown usage — that is B-5 (Competitive battling page).
- **Breeding & egg moves.** Egg-move legality/inheritance remains out of scope
  globally; learnset checks use the existing index's learnset only.
- **Non-`@pkmn` data.** No new external data source for teams; all entity/legality
  data comes from the existing per-format index.
- **Mobile-native / chat-platform clients.** Web only, consistent with the product.
- **Sharing teams to a damage calculator as a live integration.** Export to Showdown
  text is in scope (TEAM-US-11); a live, two-way calc integration is not.
