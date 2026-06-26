# Backlog

Forward-looking work not yet specified in `requirements/` or `architecture/design.md`.
Items here are **candidates**, not commitments — each needs a requirements pass before
it moves into a design doc. Today Pokebot is **single-user and stateless** (in-memory
per-session history, no accounts, no persisted artifacts); every item below changes one
of those assumptions, so they're listed in dependency order: accounts unlock the rest.

> Append new items; don't renumber existing ones. IDs are stable.

---

## B-1 — Account creation

**Why:** The product is single-user by design today (one Owner, no auth — see
`requirements.md` §Users and Personas). Persisting anything per-person (teams, chat
history) first requires a notion of "who," so this is the prerequisite for B-2 and B-3.

**Scope:**
- Sign-up / sign-in / sign-out; session-backed identity replacing the current
  server-controlled single session.
- Per-user data isolation — every persisted row (teams, chats) scoped to an account.
- Decide auth strategy (email+password, magic link, or OAuth provider) and where
  identity lives relative to the existing Drizzle/SQLite layer.

**Open questions:**
- Is this truly multi-tenant, or just "log in to sync my own data across devices"?
- Does the rate limit (currently per-session) become per-account?
- Migration path for the existing single-user data, if any.

**Touches:** `src/app/api/chat/route.ts` (session resolution), data layer / new
`accounts` table, new auth routes, frontend auth UI.

---

## B-2 — Team building

**Why:** Competitive team-building is one of the two core use cases
(`requirements.md` §Overview), but the agent only *reasons about* teams — it can't
*save* one. Letting the user persist and revisit named teams turns one-off answers
into an ongoing workflow.

**Scope:**
- Create / name / edit / delete teams; each team a set of Pokémon (species + the
  competitively relevant slots: ability, item, moves, EVs/nature as scope allows).
- Surface saved teams to the agent as context so follow-up questions ("is my team
  weak to Trick Room?") can reason against the actual roster.
- Format-aware: a team belongs to a format (`scarlet-violet` | `champions`),
  consistent with the per-format index split.

**Open questions:**
- Manual team construction UI, agent-assisted ("build me a Trick Room team"), or both?
- How much of a full competitive set do we model (just species, or full
  ability/item/move/EV detail)?
- Is a team a new tool input the agent can read, and if so how does that interact with
  the fixed 11-tool contract?

**Depends on:** B-1 (teams are per-account).

---

## B-3 — Chat history

**Why:** Conversation history is currently **in-memory only** (per-session store in
`route.ts`) — it evaporates on restart and isn't visible across devices. Persisting it
gives the user a durable record of past answers (with their reasoning and citations,
which are the point of the product) and the ability to resume threads.

**Scope:**
- Persist conversations (messages + the structured `PokebotAnswer` payloads) per account.
- List / open / continue / delete past conversations from the frontend.
- Decide retention and what exactly is stored (raw markdown only, or the full
  structured answer + tool-activity trace for replay).

**Open questions:**
- Store full `PokebotAnswer` structured payloads (richer, larger) or just the rendered
  markdown?
- Does resuming a thread re-feed prior turns to the model, and how does that interact
  with the prompt-cached prefix and `MAX_ITERATIONS`?
- Retention / size limits per account.

**Depends on:** B-1 (history is per-account).

---

## B-4 — Artifact viewer

**Why:** Some answers are inherently richer than a single chat bubble — a full team
sheet, a damage-calc breakdown, a type-matchup grid, a side-by-side species comparison.
Today every answer renders inline in the `AnswerCard` stream and scrolls away. A
dedicated artifact viewer would let the agent emit a structured, focused output that the
user can open, pin, and revisit as a first-class object instead of re-scrolling chat.

**Scope:**
- A dedicated panel/surface that renders a structured artifact (team sheet, comparison
  table, damage-calc result, type chart) separately from the inline chat answer.
- Defined artifact type(s) the agent can produce, rendered field-by-field like the
  existing `PokebotAnswer` tree — reusing the citation / inference / generation-tag
  conventions so artifacts stay grounded in data.
- Open / pin / dismiss an artifact alongside the live conversation.

**Open questions:**
- Is an artifact a new shape in the `PokebotAnswer` schema, a separate output channel,
  or a derived view the frontend computes from an existing answer?
- Does the agent decide when to emit an artifact, or is it user-triggered ("open this
  as an artifact") from a rendered answer?
- Which artifact types are worth the dedicated surface first (team sheet vs. comparison
  vs. damage calc)?
- Are artifacts ephemeral (this session only) or persisted/shareable?

**Depends on:** Nothing for an ephemeral, in-session viewer; persisting or sharing
artifacts depends on B-1 (per-account) and overlaps B-3 (what's stored per conversation).

---

## B-5 — Competitive battling page

**Why:** Pokebot reasons about mechanics and legality, but it has no surface dedicated to
*competitive* play — the metagame layer that defines what people actually battle with.
The two core use cases (`requirements.md` §Overview) are mechanics reasoning and team
building; a competitive page would sit on top of both, organized around the live
competitive seasons rather than the raw dex. The catch is that the current index is built
**purely from `@pkmn`** (dex, learnsets, legality — see `docs/research/champions-data-sources.md`),
which carries **no metagame data**: no usage statistics, no tier placements, no sample
sets. That's the gap this item fills.

**Battle styles to model** — every competitive context spans **both Singles and
Doubles**, and each axis has distinct legality, rules, and set conventions:
- **VGC / Worlds (official cartridge)**
  - *Doubles* — VGC proper, the Worlds/Regionals format. Bring 6, pick 4; current
    regulation legality (the app already tracks a regulation string —
    `CHAMPIONS_REGULATION`, currently `Regulation M-B`), Tera, item clause, species clause.
  - *Singles* — Battle Stadium Singles (BSS), the official 3v3 singles ladder; its own
    legality set and set conventions, distinct from VGC doubles.
- **Showdown (Smogon)**
  - *Singles* — tier-based 6v6: Ubers / OU / UU / RU / NU / PU / LC, each with its own
    banlist and clauses (Sleep, Evasion, OHKO, Species).
  - *Doubles* — Doubles OU (DOU) plus the VGC-rules ladders Showdown mirrors. Tier and
    usage here are metagame facts, not dex facts.
- **Champions** — already a first-class format in the index (`format = "champions"`),
  with its own regulation; carries its own Singles/Doubles conventions as one more
  competitive lens.

**Movesets:** competitive sets are richer than the dex — full set detail (ability, item,
Tera type, nature, EV/IV spread, 4 moves) plus *why* the set is run. Usage-derived "sample
sets" and lead/teammate tendencies come from Showdown usage data, which the index does not
currently store.

**Candidate data source:** `ps-local` — a self-hosted Pokémon Showdown server
(https://github.com/AbhishekR3/ps-local). Showdown is already the upstream of the
`@pkmn` packages we ingest, so this stays in-ecosystem; `ps-local` additionally exposes
the battle-sim / usage side (formats config, usage stats, sample teams, replays) that the
pure-dex `@pkmn` build omits. Evaluate it as the metagame ingest source alongside the
existing `gen-provider.ts` integration point.

**Open questions:**
- Is this a *reference* page (browse formats / tiers / sample sets) or an *interactive*
  one (drive a battle, run damage calcs against a live opponent)? See the Live
  Competitive Battle UI exploration (`docs/research/live-competitive-battle-ui.md`).
- Does metagame data (usage %, tier, sample sets) become a new tool the agent can read?
  That collides with the fixed 11-tool contract (`docs/agent-design/tools.md`) — new
  format column vs. new tables vs. new tool is the design call.
- How is `ps-local` data ingested and refreshed (it's a live server, not a static
  package) without breaking the current "no network at ingest" guarantee?
- Which format do we ship first — VGC/Worlds (matches the existing regulation tracking)
  or Smogon singles tiers (a whole new tiering concept)?

**Depends on:** Standable as a read-only reference surface on its own; deeper integration
(save a competitive set, "is this set legal in Reg M?") overlaps B-2 (team building) and
benefits from B-1 (per-account).
