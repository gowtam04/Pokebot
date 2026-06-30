# Oak for iPhone — History & Teams

> Two signed-in features at parity with the web app: **durable chat history**
> (`docs/features/chat-history/requirements/`) and the **team builder**
> (`docs/features/team-builder/requirements/`). This file specifies their native
> iPhone expression. IDs scoped `M-`. Append; never renumber.

> **⚠️ Updated — "active team" removed (web change, 2026-06).** The web app dropped
> the active-team seam; saved teams are now referenced **by name in chat** (the agent
> calls `list_teams` then `get_team`). **M-TEAM-US-5 and its M-AC-T5.x criteria are
> retired**, and the iOS client carries no active-team selector, `setActiveTeam`, or
> `active_team_id`. Other "active team" mentions below are superseded by this note.

## A. Durable chat history (signed-in)

### Overview

For signed-in users, every conversation is saved automatically with full
structural fidelity (reopened answers render identically — reasoning, citations,
flags, sprites, tables) and is available on any device the account signs in on,
**including across web and iPhone**. Reopening a conversation makes it the live
thread again, with the agent retaining that conversation's earlier context.
**Guests have no durable history** — their thread is ephemeral.

### User stories

- **M-HIST-US-1** — As a signed-in user, I want my conversations saved
  automatically, so I never lose Oak's reasoning.
  - **M-AC-H1.1** — Conversations appear in a history list with **no explicit
    save step**.
  - **M-AC-H1.2** — A conversation created on the web is visible and openable on
    the iPhone (and vice-versa) after signing into the same account, rendering
    identically.

- **M-HIST-US-2** — As a signed-in user, I want to browse, search, and organize
  my history, so I can find past work.
  - **M-AC-H2.1** — I can see a list of my conversations with enough to identify
    each (title + recency).
  - **M-AC-H2.2** — I can **search** my conversations.
  - **M-AC-H2.3** — I can **filter by format** (standard / Champions).
  - **M-AC-H2.4** — I can **pin**, **rename**, and **delete** a conversation.
  - **M-AC-H2.5** — These actions use native iPhone patterns (e.g. swipe actions,
    context menus, pull-to-refresh) appropriate to a list.

- **M-HIST-US-3** — As a signed-in user, I want to reopen and continue a past
  conversation, so I can pick up where I left off.
  - **M-AC-H3.1** — Reopening a conversation makes it the live thread; a
    context-dependent follow-up reflects that conversation's earlier turns.
  - **M-AC-H3.2** — A reopened conversation's earlier answers render with full
    fidelity (not flattened to plain text).

### Business rules (history)

- **M-BR-H1** — History is **signed-in only**; guests see no history surface and
  nothing is persisted server-side for them.
- **M-BR-H2** — **Per-account isolation** — a user can never see or open another
  account's conversations.
- **M-BR-H3** — A conversation belongs to a **single format**; the format filter
  and the saved format tag are consistent with the index's per-format split.
- **M-BR-H4** — Saving is **automatic and effortless**; the app must not require
  a manual "save conversation" action.

## B. Team builder (signed-in)

### Overview

The team builder lets a signed-in user create, name, and revisit fully-specified
competitive teams, and lets the agent reason against a chosen **active team**
("is my team weak to Trick Room?") instead of a re-described one. A team carries
the **full competitive set** per Pokémon: species, ability, held item, four
moves, nature, EV spread, IVs, Tera type, level. Teams are **per-account** and
**format-aware** (each belongs to one format). The builder is **warn-but-allow**:
it surfaces legality/validity problems but never blocks saving.

Teams are built two ways: **manually** on a dedicated teams surface, and
**agent-assisted** in chat (the agent proposes a team or edit; the user
explicitly applies it to saved storage).

### User stories

- **M-TEAM-US-1** — As a signed-in user, I want to create and name a team and
  fill in each Pokémon's full set, so I have a durable, revisitable roster.
  - **M-AC-T1.1** — I can create a named team and add up to 6 Pokémon, each with
    species, ability, held item, four moves, nature, EVs, IVs, Tera type, level.
  - **M-AC-T1.2** — I can save it, leave, return, and find it intact.
  - **M-AC-T1.3** — Editing a team's sets on a phone is workable with native
    inputs (pickers/steppers/search), without requiring a desktop.

- **M-TEAM-US-2** — As a signed-in user, I want to import and export teams in
  **Showdown paste** format, so I can interchange with my existing tools.
  - **M-AC-T2.1** — Pasting a Showdown team produces a saved team.
  - **M-AC-T2.2** — Any saved team can be exported to Showdown text that
    **round-trips** (re-importing reproduces the team).
  - **M-AC-T2.3** — Native share/clipboard is used for export (copy / share
    sheet) and paste for import.

- **M-TEAM-US-3** — As a signed-in user, I want the builder to **warn but not
  block** on legality/validity problems, so I stay in control.
  - **M-AC-T3.1** — A team with an illegal/invalid detail (e.g. EV total over
    508, a move not in the species' learnset) can **still be saved**, with the
    offending detail clearly flagged.

- **M-TEAM-US-4** — As a signed-in user, I want to ask the agent to draft or
  modify a team in chat and then apply it, so building can be conversational.
  - **M-AC-T4.1** — I can ask the agent to build/modify a team ("build me a Trick
    Room team", "swap in a Fire type"); it **proposes** a team.
  - **M-AC-T4.2** — Applying a proposed team is an **explicit user action** that
    writes it to saved storage; the agent does not silently overwrite my teams.

- **M-TEAM-US-5** — As a signed-in user, I want to set a team **active** for a
  conversation, so the agent reasons against my actual roster.
  - **M-AC-T5.1** — I can select a saved team as the active team for a
    conversation.
  - **M-AC-T5.2** — With an active team, asking "is my team weak to X?" produces
    an answer that reasons against the **actual saved sets**, with Oak's usual
    reasoning + citations.
  - **M-AC-T5.3** — The active team for the current conversation is visible/at a
    glance, and can be changed or cleared.

- **M-TEAM-US-6** — As a signed-in user, I want to manage my team library (list,
  rename, duplicate, delete), so I can keep it organized.
  - **M-AC-T6.1** — I can see all my teams, grouped/identifiable by format and
    name, and rename or delete them with native list patterns.

### Business rules (teams)

- **M-BR-T1** — Teams are **signed-in only** and **per-account isolated** (no
  cross-account visibility, no sharing in v1).
- **M-BR-T2** — A team belongs to **exactly one format** (`scarlet-violet` |
  `champions`).
- **M-BR-T3** — **Warn-but-allow**: validity/legality issues are surfaced, never
  block saving.
- **M-BR-T4** — Applying an agent-proposed team to storage is always an
  **explicit** user action.
- **M-BR-T5** — Showdown export must **round-trip** through import.
- **M-BR-T6** — The same teams are shared across web and iPhone for an account.

## Dependencies & notes

- Both features require sign-in (`accounts-and-access.md`) and reuse the existing
  backend's history and team persistence, plus the team-related agent tools
  (active team / save team). The app provides native surfaces over them; it does
  not reimplement team validation or persistence.
- Reasoning against an active team flows through the same chat/streaming path in
  `chat-experience.md`.
