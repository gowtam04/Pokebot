# Oak

A web chat agent that answers natural-language questions about Pokémon — moves,
abilities, types, stats, evolutions, items, catch locations, and game-mechanic
interactions. Its defining trait is that it **reasons on top of data**: tools
supply the raw building blocks (move priority values, ability effect text, type
charts, base stats) sourced from the [`@pkmn`](https://github.com/pkmn)
ecosystem, and the agent deduces how those pieces interact.

> Example: _"does Fake Out work on Farigiraf?"_ → "Fake Out is a +3 priority
> move; Armor Tail negates priority moves; if Farigiraf has Armor Tail, Fake Out
> fails." Every answer carries its reasoning, the cited data, an explicit
> inference/uncertainty flag, and the generation/format it's based on (Gen 9
> baseline with flagged fallback).

It serves two blended use cases: **competitive team-building** (filter queries,
mechanics reasoning, battle math) and **general Pokédex curiosity** (lookups,
evolutions, matchups, items, where-to-catch, trivia).

## Status

✅ **Implemented and deployed.** Runs in production on [Fly.io](https://fly.io)
(app `oak-gowtam`). The codebase is the source of truth; the docs below describe
the design intent.

## Features

- **Reasoned, cited answers.** Each response is a Zod-validated `OakAnswer`
  rendered field-by-field: the answer, the reasoning, cited sources, explicit
  inference/uncertainty flags, and the generation/format it's based on.
- **Accounts are optional.** Anyone can use Oak as a **guest** (in-memory,
  per-session multi-turn). Signing in with an **email one-time code** unlocks the
  durable, per-account features below. Guests and signed-in users get separate,
  tiered rate limits.
- **Durable chat history** (signed-in) — conversations persist in Postgres, with
  search, format filter, pin, rename, and delete. A guest thread is imported into
  the account on first sign-in.
- **Team builder** (signed-in) — create, edit, import, and export teams (Showdown
  paste format). A team can be set **active** for a conversation, scoping the
  agent's answers to that team.
- **Artifact viewer** — answers can open rich, interactive side-panel artifacts
  (Pokémon, moves, abilities, items, teams, comparisons, damage calcs, type
  matchups) with clickable entity links and citations.
- **Image input (vision)** — attach up to 4 images per turn ("what is this?",
  "rate this team sheet"); all three models are vision-capable.
- **Champions mode** — a header toggle switches the entire data scope between the
  standard Scarlet/Violet index and the **Champions** regulation format.

## Stack

A single **TypeScript / Next.js (App Router) monolith** — one language across
frontend, API, agent loop, and the ingest CLI.

- **Data** — **Postgres + Drizzle ORM** (node-postgres), one row-set per format
  (`scarlet-violet` / `champions`). The index is built offline from the `@pkmn`
  ecosystem (`@pkmn/dex`, `@pkmn/data`, `@pkmn/mods`). The one exception is
  encounter (catch-location) data, which comes from a **committed PokeAPI
  snapshot** — see [Data](#data) below.
- **Agent** — a provider-agnostic tool-loop over **14 tools** that return
  structured facts; the model reasons on top and emits a Zod-validated
  `OakAnswer`.
- **Models** — **xAI Grok 4.3** (native Responses API) is the primary/default,
  with **Claude** and **GPT-5.5** selectable. The active model is **operator-
  controlled** via the `ACTIVE_MODEL` secret — there is no in-app model picker.
- **Transport** — **Server-Sent Events** stream tool activity then a
  token-by-token answer.
- **Validation** — **Zod** is the single source of truth (runtime validation,
  inferred types, and the provider tool / `submit_answer` JSON Schemas).
- **Auth** — email + one-time-code (OTP) sessions; OTP email sent via
  [Resend](https://resend.com) (a console transport logs the code in local dev).
- **Tests** — **Vitest**, two projects (a Node project backed by an ephemeral
  Testcontainers Postgres, and a jsdom project for components).

## Data

All index data (Pokémon, moves, abilities, items, types, learnsets) is built
**offline** from the local `@pkmn` packages — `npm run ingest` makes no network
calls and is fully deterministic.

The single exception is **encounter / catch-location data**, which `@pkmn`
doesn't provide. It comes from a committed snapshot at
`src/ingest/data/encounters.json`, crawled from [PokeAPI](https://pokeapi.co/)
**manually and rarely** via `npm run fetch:encounters` (the only place Oak ever
touches the network). Ingest reads that committed file via `fs`, so the build
stays offline. Coverage is **Gen 1 → Sword/Shield + Let's Go only** — PokeAPI has
no encounter records for Scarlet/Violet, Legends: Arceus, or BDSP, and the agent
surfaces that gap transparently. Encounters are standard-mode only (Champions
ships none).

## Getting started

Requires Node 20+ (`.nvmrc`) and a Docker daemon (for the local Postgres and the
test suite).

```bash
npm install
cp .env.example .env.local   # add XAI_API_KEY (required); other keys are optional
npm run docker:dev           # Postgres + next dev on :3000 (the intended dev environment)
npm run docker:migrate       # apply Drizzle migrations
npm run docker:ingest        # build the index from @pkmn (migrates first)
```

Only `XAI_API_KEY` is required to boot (Grok is the default model). The other
keys are optional and validated on use:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — needed only if you point `ACTIVE_MODEL`
  at Claude or GPT-5.5.
- `AUTH_SECRET` — HMAC secret for OTP codes (a dev default is used locally; a
  strong value is required in production).
- `RESEND_API_KEY` — to send real OTP emails. Absent ⇒ the code is logged to the
  console (fine for local dev).

To run the Next dev server directly against a local Postgres instead of in Docker:

```bash
npm run db:migrate && npm run ingest && npm run dev
```

## Scripts

| Script                    | What it does                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run dev`             | Next dev server (local).                                             |
| `npm run build`           | Next production build (standalone output).                           |
| `npm start`               | Run the production server.                                           |
| `npm test`                | Full Vitest run (unit + integration + deterministic eval). Needs Docker. |
| `npm run test:node`       | Node project only (backend/unit). Needs Docker.                      |
| `npm run test:components` | jsdom project only (React components). No Docker.                    |
| `npm run typecheck`       | `tsc --noEmit`.                                                      |
| `npm run lint`            | `eslint .`.                                                          |
| `npm run db:generate`     | `drizzle-kit generate` — author a new migration from the schema.    |
| `npm run db:migrate`      | Apply Drizzle migrations to `$DATABASE_URL`.                         |
| `npm run ingest`          | (Re)build the Postgres index from `@pkmn` (migrates first). Offline. |
| `npm run fetch:encounters`| Re-crawl the PokeAPI encounter snapshot (manual, networked, rare).  |
| `npm run eval`            | Full LLM-judge golden suite (needs live `XAI_API_KEY` + `ANTHROPIC_API_KEY`). |
| `npm run docker:*`        | Docker-Compose helpers (`dev`, `down`, `migrate`, `ingest`, `logs`, `psql`, `sh`). |

## Models

Three providers plug into one provider-agnostic loop. **Grok 4.3** (xAI's native
Responses API) is the default; **Claude** and **GPT-5.5** are drop-in
alternatives. The active model is chosen by the operator, not the end user:

```bash
fly secrets set ACTIVE_MODEL=claude   # grok-4.3 (default) | claude | gpt-5.5
```

Switching is one secret change, no rebuild. The chosen model's provider key must
be configured or the request returns a clean 503; an unknown value fails fast at
boot.

## Deploy

Deployed to Fly via the production `Dockerfile` (`output: "standalone"`). The
release command runs `migrate.mjs` (a plain-ESM migration runner) before the new
version takes traffic, so migrations apply atomically on each deploy. A single
always-on machine backs the in-memory guest session store, rate limiter, and OTP
throttle; `/api/health` is a DB-free liveness probe. See [`docs/`](docs/) and the
deployment notes for details.

## Documentation

| Doc                                                                      | What it covers                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`docs/requirements/requirements.md`](docs/requirements/requirements.md) | Core business requirements — user stories, acceptance criteria, business rules.                         |
| [`docs/agent-design/`](docs/agent-design/)                               | The agent's internals (fixed): topology, tools, data sources, prompts, output schema, eval spec.        |
| [`docs/architecture/design.md`](docs/architecture/design.md)             | Technical design — stack, data store, ingest pipeline, file structure, interfaces, build phases.        |
| [`docs/features/`](docs/features/)                                       | Per-feature requirements + design: account creation, chat history, team builder, artifact viewer.       |
| [`docs/design-system/`](docs/design-system/)                             | Visual language — color, typography, spacing, component patterns.                                       |
| [`docs/eval-reports/`](docs/eval-reports/)                               | Judged eval runs (incl. a Grok-vs-Claude A/B).                                                           |

> The architecture doc predates some implementation choices — notably the move
> from PokeAPI/SQLite to `@pkmn`/Postgres (PokeAPI now survives only as the
> manual encounter snapshot), and the multi-user account/history/team features
> that landed after it. Where they disagree, trust the code and `CLAUDE.md`.
</content>
</invoke>
