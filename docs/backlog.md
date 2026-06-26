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
