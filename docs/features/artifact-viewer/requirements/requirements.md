# Artifact Viewer — Business Requirements

> Source: backlog item **B-4 — Artifact viewer** (`docs/backlog.md`). This document
> also **absorbs B-6 — Clickable sources → source-detail artifact**: in the interview
> the clickable-source behavior was generalized into a clickable-**entity** behavior
> that opens an entity-detail artifact through this same surface, so B-6 is satisfied as
> a special case here rather than as a separate feature. See **Relationship to the
> backlog** below.

## Overview

Today every Pokébot answer renders inline as an `AnswerCard` in a single scrolling chat
thread (`docs/agent-design/ux-design.md`: "the thread is the surface"). Rich
answers — a team sheet, a damage-calc breakdown, a type-matchup grid, a side-by-side
comparison, or just a single Pokémon the user wants to study — scroll away and have to be
re-found.

The artifact viewer adds a **dedicated, persistent surface beside the chat** where a
structured output or a specific entity can be opened as a first-class object, kept on
screen while the conversation continues, drilled into, and dismissed. Its defining purpose
(per the interview) is **co-visibility**: pin something rich on screen and keep asking
questions without losing it.

Two things open into the viewer:

1. **Entity detail** — clicking a Pokémon, move, ability, item, or type that appears in a
   *structured* part of an answer opens a **full profile** of that entity (everything
   Pokébot has for the active format), rendered with the same grounded, cited conventions
   as the rest of the product.
2. **Structured answer views** — a per-section control on rich answer blocks (candidate
   table, damage readout, comparison, type grid, team sheet) opens that block into the
   viewer as a focused, full-detail artifact.

The viewer shows **one artifact at a time** and behaves like a small in-app browser:
clicks and drill-downs push onto a back stack; a back control returns to the previous
artifact. Artifacts are **ephemeral** — session-only, not persisted, not shareable —
which keeps this feature independent of accounts (B-1) and chat history (B-3).

### Why this exists

- Rich, reasoning-heavy answers (the point of the product) currently scroll out of view;
  there is no way to hold one in place while continuing to chat.
- Citations and entities are referenced but not *inspectable* in place — to see "what the
  source actually says" or the full profile of a Pokémon mentioned in an answer, the user
  must ask another question or leave the app (the external `↗` PokeAPI link).
- A focused surface lets answers that are inherently bigger than a chat bubble (team
  sheets, comparisons, damage math, type grids, entity profiles) get the room they need.

### What success looks like

This is a single-user hobby product; success is qualitative and behavioral rather than a
revenue/adoption metric:

- The user can open, drill into, navigate back through, and dismiss artifacts without
  losing their place in the conversation.
- Opening an entity from an answer is faster and more useful than re-asking the agent
  about it.
- Artifacts feel consistent with the rest of Pokébot — grounded, cited, format-tagged —
  not like a separate, un-sourced data dump.
- Opening an artifact feels effectively instant (see NFR-1).

## Users and Personas

Single persona — **the Owner** (the sole user of this single-user app; see
`docs/requirements/requirements.md` §Users and Personas). Competitive/curious Pokémon
player who asks mechanics, filtering, and battle-math questions and wants to study the
entities and results an answer surfaces without losing the thread of the conversation.
No new roles are introduced.

## User Stories

### Opening artifacts

- **AV-US-1** — As the Owner, I want to click a Pokémon, move, ability, item, or type that
  appears in a structured part of an answer and have its full detail open in a side panel,
  so I can study it without re-asking the agent.
  - **AV-1.1** — Given an answer with a subject sprite card (e.g. Farigiraf), when I click
    the sprite card, then the viewer opens showing Farigiraf's full entity-detail artifact.
  - **AV-1.2** — Clickable entities include all of: **Pokémon** (sprite cards,
    candidate-table rows, comparison cells), **moves**, **abilities**, **items**, and
    **types** (type badges) — wherever each appears as a *structured* element, and entries
    in the **Sources** list.
  - **AV-1.3** — Entity names appearing only in free-flowing prose (answer/reasoning
    markdown sentences) are **not** clickable; they render as plain text. (See
    AV-Out-of-Scope.)
  - **AV-1.4** — A clickable entity gives a clear affordance (cursor/hover/focus styling)
    that distinguishes it from non-interactive text.

- **AV-US-2** — As the Owner, I want a per-section control on each rich answer block to
  open that block into the viewer, so I can expand a result into a focused, full-detail
  surface.
  - **AV-2.1** — Each of these answer blocks, when present, exposes its own "open in
    viewer" control: candidate table, damage readout, side-by-side comparison, type-matchup
    grid, and team sheet.
  - **AV-2.2** — Given an answer containing a damage-calc result, when I activate that
    block's "open in viewer" control, then the viewer opens a damage-calc artifact showing
    the assumptions, result, and worked breakdown.
  - **AV-2.3** — A block with no rich structured content exposes no "open in viewer"
    control (the control appears only where there is an artifact to open).

- **AV-US-3** — As the Owner, I want clicking a citation in the **Sources** list to open an
  artifact detailing that source, so citations become inspectable in-app instead of only
  linking out. (This is the B-6 behavior, realized as an entity-detail artifact.)
  - **AV-3.1** — Given a Sources entry such as `ability/armor-tail`, when I click it, then
    the viewer opens the entity-detail artifact for that ability.
  - **AV-3.2** — The existing external `↗` link (`citation.endpoint_url`) to the canonical
    PokeAPI endpoint is **retained** as a separate affordance; the new click opens the
    in-app artifact rather than navigating away.
  - **AV-3.3** — The source artifact surfaces, at minimum, the cited datum
    (`citation.detail`) in the context of the entity's full profile, and the format /
    generation the data is drawn from.

### Viewing, navigating, and acting on artifacts

- **AV-US-4** — As the Owner, I want the viewer to stay on screen beside the chat while I
  keep asking questions, so a pinned artifact doesn't scroll away.
  - **AV-4.1** — On desktop, the viewer is a panel docked beside the chat; the chat remains
    fully usable (I can read prior turns, type, and send) while the viewer is open.
  - **AV-4.2** — Sending a new message and receiving a new answer does **not** close or
    change the open artifact.

- **AV-US-5** — As the Owner, I want nested entities inside an artifact to be clickable so I
  can drill deeper, with a way back to where I came from.
  - **AV-5.1** — Given Farigiraf's profile lists its abilities, moves, and types, when I
    click one of those nested entities, then the viewer replaces its content with that
    entity's detail artifact.
  - **AV-5.2** — A **back** control returns to the immediately previous artifact, in
    reverse order of how I navigated (a back stack); from the first artifact, back is
    unavailable/disabled.
  - **AV-5.3** — Opening a new artifact from the chat (a fresh entity click or a per-section
    button) pushes onto the same navigation history so back still works.

- **AV-US-6** — As the Owner, I want only one artifact shown at a time so the surface stays
  focused.
  - **AV-6.1** — Opening any new artifact replaces the currently displayed one (no
    second simultaneous panel, no tabs).
  - **AV-6.2** — The previously displayed artifact remains reachable via the back control
    (AV-5.2), not via a second visible pane.

- **AV-US-7** — As the Owner, I want to close the viewer to give the chat full width.
  - **AV-7.1** — A close/collapse control dismisses the viewer; the chat reflows to full
    width and the conversation is unchanged.
  - **AV-7.2** — Closing the viewer does not delete the conversation or any answer; only
    the (ephemeral) viewer state is dismissed.

- **AV-US-8** — As the Owner, I want to ask the agent a follow-up about the entity I'm
  viewing, so I can move from inspecting to asking in one step.
  - **AV-8.1** — An open artifact exposes an "ask about this in chat" action that directs a
    follow-up about that entity to the agent (e.g. pre-fills or sends a message naming the
    entity).
  - **AV-8.2** — The follow-up runs as a normal chat turn in the same session — it reuses
    the existing message flow and introduces no new agent protocol.

### Grounding and format

- **AV-US-9** — As the Owner, I want every artifact to clearly show which format and
  generation its data is for, so I always know whether I'm looking at Scarlet/Violet or
  Champions data.
  - **AV-9.1** — Every artifact displays a visible format/generation tag.
  - **AV-9.2** — An artifact reflects the active format (the Champions toggle) at the moment
    it is opened (BR-AV-7).

- **AV-US-10** — As the Owner, I want entity-detail artifacts to carry the same grounded,
  cited treatment as answers, so artifacts feel as trustworthy as the chat.
  - **AV-10.1** — An entity-detail artifact shows per-datum source attribution for the
    values it presents, consistent with the `SourceList` convention.
  - **AV-10.2** — Where an entity artifact surfaces a fallback or an uncertainty (e.g. data
    drawn from a pre-Gen-9 fallback), it shows the same caveat/fallback treatment used in
    answers (`CaveatStrip` conventions, BR-1).

### Failure and edge cases

- **AV-US-11** — As the Owner, when I open something whose detail can't be loaded, I want a
  clear explanation in the panel rather than a silent failure.
  - **AV-11.1** — Given I click an entity that cannot be resolved, when the viewer opens,
    then it shows a clear "couldn't load" state and, where a near-match exists, suggested
    alternatives — consistent with the agent's `resolution_failed` behavior (BR-9).
  - **AV-11.2** — Given the data index is unavailable, when I open any entity artifact, then
    the viewer shows a clear unavailable state consistent with the agent's
    `insufficient_data` behavior — it does not fabricate data and does not crash the chat.
  - **AV-11.3** — A failed artifact load never breaks the underlying conversation; the chat
    remains fully usable.

## Functional Requirements

### The viewer surface

- A single artifact surface that is **docked beside the chat on desktop** and renders the
  **active artifact** plus its navigation controls (back, close, and the artifact's own
  actions).
- **One artifact at a time.** No tabs, no second pane, no simultaneous artifacts
  (AV-US-6).
- **Back-stack navigation.** Every open-action (entity click, per-section button,
  nested-entity drill-down) pushes the new artifact onto a history; back pops to the
  previous one (AV-US-5).
- **Mobile / narrow screens:** when there is no room beside the chat, the viewer opens as a
  **full-screen overlay** over the chat; closing it returns to the conversation
  (BR-AV-9).
- **Open / close lifecycle:** the viewer is hidden until something is opened; closing
  collapses it and returns full width to the chat (AV-US-7).

### Trigger surfaces (what is clickable / has a control)

- **Clickable structured entities** (open entity-detail artifact): subject sprite cards;
  candidate-table rows; side-by-side comparison cells; type badges; **Sources** list
  entries. Entity kinds: Pokémon, move, ability, item, type (AV-1.2, AV-3.1).
- **Per-section "open in viewer" controls** (open structured-view artifact): on the
  candidate table, damage readout, comparison, type-matchup grid, and team sheet blocks,
  when present (AV-2.1).
- **Nested entities inside an artifact** are themselves clickable and drill down (AV-5.1).
- **Not clickable:** entity names in free-flowing answer/reasoning prose (AV-1.3).

### Artifact types (v1)

Each type renders field-by-field with the product's grounded conventions (sources,
inference/uncertainty flags where applicable, format/generation tag).

1. **Entity detail — Pokémon.** Full species profile for the active format: name, dex
   number, sprite/artwork, types, base stats, abilities, type matchups
   (offensive/defensive), and movepool/learnset. "Full" = everything Pokébot holds for that
   species in the active format, not just the datum the answer used (BR-AV-3).
2. **Entity detail — Move.** Type, damage category, power, accuracy, PP, priority, target,
   and effect text.
3. **Entity detail — Ability.** Effect text and the species that have it.
4. **Entity detail — Item.** Effect / relevant competitive attributes.
5. **Entity detail — Type.** The type's offensive and defensive matchup grid.
6. **Team sheet.** A team's roster and the competitively relevant detail of each member, as
   surfaced by the answer.
7. **Side-by-side comparison.** A focused comparison of 2+ Pokémon (stats, types,
   matchups).
8. **Damage-calc breakdown.** The battle-math result: every assumption used, the computed
   result, and the worked breakdown — always carrying the "estimate" tag (BR-6).
9. **Type-matchup grid.** A type chart / coverage grid for a Pokémon or type combination.

> Exact field lists for each type are bounded by what the data layer can supply and are a
> design detail for the architect; the requirement is that entity detail is a *complete*
> profile (BR-AV-3) and that structured-view artifacts mirror the corresponding answer
> block in full.

### Artifact content & grounding

- Entity-detail artifacts carry **full grounding chrome**: a format/generation tag,
  per-datum source attribution (consistent with `SourceList`), and fallback/uncertainty
  caveats where they apply (AV-US-9, AV-US-10).
- The **cited datum** for a source-opened artifact (`citation.detail`) is surfaced in the
  context of the entity's profile (AV-3.3).
- Artifacts reuse existing rendering conventions (type badges, sprite cards,
  inference/caveat treatments) so they stay visually and behaviorally consistent with the
  `AnswerCard` tree.

### Actions on an open artifact

- **Back** (when history exists), **Close/collapse**, and **Ask about this in chat**
  (AV-US-7, AV-US-8). The follow-up is a normal chat turn (AV-8.2).
- **No copy, no share, no export** in v1 (see AV-Out-of-Scope).

### Data sourcing

- Opening an entity detail produces a **full profile**, which generally requires reading
  Pokébot's data at click time — it is **not** limited to data already present in the
  answer payload (BR-AV-3). This is a deliberate change from B-6's earlier "no fresh read"
  framing and is the single most important input for the architect (see Constraints).
- The data shown must be drawn from Pokébot's existing index for the **active format**;
  artifacts must never invent data (BR-AV-5).

## Business Rules

- **BR-AV-1 — Ephemeral / session-only.** Artifacts and viewer state are not persisted, not
  shareable, and do not survive a reload. The feature has no dependency on accounts (B-1) or
  chat history (B-3).
- **BR-AV-2 — User-triggered only.** Artifacts open only in response to a user action (an
  entity click, a per-section control, or a nested drill-down). The agent never decides to
  emit or open an artifact on its own.
- **BR-AV-3 — Entity detail is a full profile.** An entity-detail artifact shows everything
  Pokébot holds about that entity for the active format, not only the datum the originating
  answer used.
- **BR-AV-4 — One artifact visible at a time.** The viewer shows exactly one artifact;
  opening another replaces it (the prior one stays reachable via back).
- **BR-AV-5 — Never fabricate.** When data is missing or unresolvable, the viewer shows an
  honest "couldn't load / unavailable" state (AV-US-11); it never invents values. Mirrors
  the agent's `resolution_failed` / `insufficient_data` behavior (BR-9, NFR reliability).
- **BR-AV-6 — Grounded like answers.** Entity-detail artifacts carry per-datum sources, a
  format/generation tag, and fallback/uncertainty caveats where applicable, consistent with
  the `OakAnswer` rendering conventions.
- **BR-AV-7 — Format snapshot + always tagged.** An artifact reflects the active format at
  the moment it is opened and always displays its format/generation tag. Re-rendering an
  already-open artifact when the format toggle changes is **not required** (re-opening
  refreshes it).
- **BR-AV-8 — Clickability is structured-only.** Only structured entity elements and
  Sources entries are clickable; free-text prose mentions are not (AV-1.3).
- **BR-AV-9 — Responsive surface.** Desktop = docked side panel co-visible with chat;
  narrow/mobile = full-screen overlay over chat.
- **BR-AV-10 — Conversation isolation.** No viewer action (open, drill, fail, close) ever
  alters or breaks the underlying conversation; the chat remains usable throughout
  (AV-11.3).

## Non-Functional Requirements

- **NFR-1 — Performance.** Opening an artifact should feel effectively instant. Because the
  full-profile data comes from Pokébot's local index (not a remote crawl), the open-to-render
  latency should be in the snappy range (target well under ~500 ms on a warm index);
  surface a brief loading state if a read is in flight rather than blocking the UI.
- **NFR-2 — Reliability.** The viewer degrades gracefully: an unresolved entity or an
  unavailable index yields a clear in-panel message, never a crash and never a corrupted
  conversation (BR-AV-5, BR-AV-10).
- **NFR-3 — Consistency.** Artifacts reuse the established grounded conventions and visual
  language (type colors, sprite cards, source list, caveat treatments) so they read as part
  of Pokébot, governed by the existing design system (`docs/design-system/design-system.md`).
- **NFR-4 — Accessibility.** The viewer is keyboard-operable: opening moves focus
  appropriately, the panel is dismissible from the keyboard (e.g. Esc), and clickable
  entities are reachable and activatable via keyboard with a visible focus state. Honors the
  existing light/dark theme.
- **NFR-5 — Statelessness.** Consistent with BR-AV-1, the viewer holds only in-session,
  in-memory state (the current artifact and its back stack); nothing is written to storage.

## UI/UX Vision

- **Desktop layout:** chat occupies the main column; the artifact viewer docks to the side
  (e.g. a right-hand panel) when open and collapses away when closed, returning full width
  to the chat. Chat stays interactive while the panel is open.
- **Mobile layout:** the viewer opens as a full-screen overlay/sheet over the chat; a clear
  close control returns to the conversation.
- **Viewer chrome:** a header area carrying the artifact title (the entity/result name) and
  its format/generation tag, a **back** control (when there's history), a **close**
  control, and the artifact's actions ("ask about this in chat"). The body renders the
  artifact field-by-field.
- **Affordances:** clickable entities in answers get a consistent, discoverable hover/focus
  treatment; per-section "open in viewer" controls sit on their respective answer blocks.
- **Mini-browser feel:** drilling into a nested entity and pressing back should feel like
  navigating a small browser pane — predictable forward (open) / back behavior, one item at
  a time.
- **Reference feel for entities:** an entity-detail artifact should read like a compact,
  cited dossier (stats, types, abilities, matchups, movepool) rather than a chat bubble —
  scannable, dense, and grounded.

> Concrete visuals — exact panel width, breakpoints, motion, typography, the per-section
> control's icon/placement — are for the `frontend-design` skill / design system, not this
> document.

## Constraints and Preferences

These are inputs for the solution architect — not decisions made here.

- **Fresh-read on click (key architectural input).** Full entity profiles (BR-AV-3) need
  data that is **not** in the `OakAnswer` payload, so opening an artifact will generally
  require reading the index at click time. This diverges from the prior B-4/B-6 "no fresh
  read / purely frontend-derived" framing in `docs/backlog.md`. The architect must decide
  the read path. Hard constraints to respect while doing so:
  - The **agent's fixed 11-tool contract** and the tool-loop must not change to serve this
    (`docs/agent-design/tools.md`); this is a UI/data-fetch concern, not an agent turn.
  - Reads remain repo-layer reads against the existing Postgres index
    (`src/data/repos/`), honoring the **per-format** split (`format` column) and the
    `server-only` boundary on `@/data/db`.
  - The "tools never throw in-domain" seam still applies in spirit: load failures return
    documented "unavailable / unresolved" states, not exceptions surfaced to the user
    (BR-AV-5).
- **Output-shape question (open).** Whether artifacts are derived purely on the frontend,
  fetched via a new read endpoint, and/or require enriching the `citations[]` / answer
  schema (`src/agent/schemas.ts`) to carry more is an architecture decision. Note the
  current `citationSchema` is strictly `{ source, detail, endpoint_url? }`.
- **Champions parity.** Everything must work in both formats (`scarlet-violet` and
  `champions`), reading from the active `AgentMode`/format; the format is server-controlled
  and not an LLM input (per CLAUDE.md), and artifacts must tag it (BR-AV-7).
- **Reuse existing components.** Prefer reusing the existing answer-card leaf components and
  conventions (`SourceList`, `TypeBadge`, `SpriteCard`, `CaveatStrip`, etc.) and the design
  system over inventing parallel UI.
- **Stack is fixed.** TypeScript / Next.js (App Router) monolith; no new persistence for
  this feature (BR-AV-1).
- **Timeline/budget:** none stated — single-user hobby project.

## Open Questions

- **Movepool/learnset presentation.** A full Pokémon profile's movepool can be large — show
  the complete list, a searchable/filterable list, or a summarized subset with expand? (UX
  detail; default assumption: complete but scrollable, refine in design.)
- **Live format re-render.** BR-AV-7 makes snapshot-at-open the requirement and live update
  optional; confirm whether an already-open artifact should ever auto-refresh when the
  Champions toggle flips, or always require re-opening.
- **"Ask about this in chat" wording/behavior.** Does it pre-fill the composer for the user
  to edit and send, or send immediately? (Default assumption: pre-fill, user sends.)
- **Source-detail as its own type vs. a rendering of entity detail.** Carried from B-6:
  whether a source-opened artifact is just the entity-detail artifact with the cited datum
  highlighted (current assumption, AV-3.3), or a distinct artifact type.
- **Type-grid vs. type entity detail overlap.** The "type-matchup grid" structured artifact
  and the "type" entity-detail artifact may be the same thing; confirm whether they should
  merge.
- **Abuse/size backstop.** Not expected for a single user, but if a profile read could be
  expensive (very large movepools), is any caching/limit wanted? (Likely no for v1.)

## Out of Scope

Treated as hard boundaries — an autonomous implementer must not add these:

- **Persistence of artifacts.** No saving artifacts to an account, no surviving reload, no
  artifact history beyond the in-session back stack (BR-AV-1). Persisting/sharing is a
  future item that would depend on B-1/B-3.
- **Sharing / export / copy.** No shareable links, no export to file, and no copy-to-
  clipboard action in v1 (AV-US-8 deliberately excludes these).
- **Agent-initiated artifacts.** The agent does not decide to open artifacts; no new
  agent tool, no change to the `submit_answer` contract or the tool-loop to drive the
  viewer (BR-AV-2).
- **Clickable free-text entity linking.** Detecting and linking entity names inside
  free-flowing answer/reasoning prose is out; only structured elements and Sources entries
  are clickable (BR-AV-8).
- **Multiple simultaneous artifacts.** No tabs, no side-by-side artifacts, no "collect a
  working set" surface; strictly one visible at a time with back navigation (BR-AV-4).
- **Editing.** Artifacts are read-only views; no editing of stats, sets, or team contents
  from the viewer (team *building* is backlog B-2).
- **New metagame data.** Entity detail draws only on Pokébot's existing `@pkmn`-built
  index; no usage stats, tiers, or sample sets (those are backlog B-5).
- **Guest vs. signed-in distinction.** Because artifacts are ephemeral and require no
  storage, the viewer works identically for guests and signed-in users; no auth gating.

## Relationship to the backlog

- **Implements B-4 (Artifact viewer)** with these previously-open questions now resolved:
  ephemeral/session-only (confirmed); user-triggered (confirmed, BR-AV-2); first artifact
  types = entity detail + team sheet + comparison + damage-calc + type grid; surface =
  docked side panel (desktop) / full-screen overlay (mobile), one-at-a-time with back
  navigation.
- **Absorbs B-6 (Clickable sources → source-detail artifact):** clickable Sources entries
  open an entity-detail artifact (AV-US-3), satisfying B-6's intent. B-6's central open
  question (where the richer detail comes from) is resolved here in favor of a **fresh
  read for a full profile** (BR-AV-3) rather than carrying the full datum in the payload —
  the opposite of the tentative decision recorded in `docs/backlog.md` under B-6, which
  the architect should reconcile.
- **No dependency** on B-1 (accounts) or B-3 (chat history); does not touch B-2 (team
  building) or B-5 (competitive page) beyond reading the existing index.
