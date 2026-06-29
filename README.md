# Oak

A personal, single-user web chat agent that answers natural-language questions
about Pokémon — moves, abilities, types, stats, evolutions, items, and
game-mechanic interactions. The defining trait is that it **reasons on top of
data**: tools supply the raw building blocks (move priority values, ability
effect text, type charts, base stats) sourced from the
[`@pkmn`](https://github.com/pkmn) ecosystem, and the agent deduces how those
pieces interact.

> Example: _"does Fake Out work on Farigiraf?"_ → "Fake Out is a +3 priority
> move; Armor Tail negates priority moves; if Farigiraf has Armor Tail, Fake Out
> fails." Every answer carries its reasoning, the cited data, an explicit
> inference/uncertainty flag, and the generation/format it's based on (Gen 9
> baseline with flagged fallback).

It serves two blended use cases: **competitive team-building** (filter queries,
mechanics reasoning, battle math) and **general Pokédex curiosity** (lookups,
evolutions, matchups, items, trivia).

## Status

✅ **Implemented and deployed.** Runs in production on [Fly.io](https://fly.io)
(app `oak-gowtam`). The codebase is the source of truth; the docs below describe
the design intent.

## Stack

A single **TypeScript / Next.js (App Router) monolith** — one language across
frontend, API, agent loop, and the ingest CLI.

- **Data** — **Postgres + Drizzle ORM** (node-postgres), one row-set per format
  (`scarlet-violet` / `champions`). The index is built offline from the `@pkmn`
  ecosystem (`@pkmn/dex`, `@pkmn/data`, `@pkmn/mods`) — no network calls.
- **Agent** — a provider-agnostic tool-loop over 11+ tools that return structured
  facts; the model reasons on top and emits a Zod-validated `OakAnswer`.
- **Models** — **xAI Grok 4.3** (native Responses API) is the primary/default,
  with **Claude** and **GPT-5.5** selectable. The active model is server-controlled.
- **Transport** — **Server-Sent Events** stream tool activity then a token-by-token
  answer.
- **Validation** — **Zod** is the single source of truth (runtime validation,
  inferred types, and the provider tool / `submit_answer` JSON Schemas).
- **Tests** — **Vitest**, two projects (a Node project backed by an ephemeral
  Testcontainers Postgres, and a jsdom project for components).

## Getting started

Requires Node 20+ (`.nvmrc`) and a Docker daemon (for the local Postgres and the
test suite).

```bash
npm install
cp .env.example .env.local   # add XAI_API_KEY (required); ANTHROPIC_API_KEY / OPENAI_API_KEY optional
npm run docker:dev           # Postgres + next dev on :3000 (the intended dev environment)
npm run docker:migrate       # apply Drizzle migrations
npm run docker:ingest        # build the index from @pkmn (migrates first)
```

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
| `npm run ingest`          | (Re)build the Postgres index from `@pkmn` (migrates first).         |
| `npm run eval`            | Full LLM-judge golden suite (needs live `XAI_API_KEY` + `ANTHROPIC_API_KEY`). |
| `npm run docker:*`        | Docker-Compose helpers (`dev`, `down`, `migrate`, `ingest`, `logs`, `psql`, `sh`). |

## Deploy

Deployed to Fly via the production `Dockerfile` (`output: "standalone"`). The
release command runs `migrate.mjs` (a plain-ESM migration runner) before the new
version takes traffic, so migrations apply atomically on each deploy. See
[`docs/`](docs/) and the deployment notes for details.

## Documentation

| Doc                                                                      | What it covers                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`docs/requirements/requirements.md`](docs/requirements/requirements.md) | Business requirements — user stories, acceptance criteria, business rules.                              |
| [`docs/agent-design/`](docs/agent-design/)                               | The agent's internals (fixed): topology, tools, data sources, prompts, output schema, eval spec.        |
| [`docs/architecture/design.md`](docs/architecture/design.md)             | Technical design — stack, data store, ingest pipeline, file structure, interfaces, build phases.        |

> The architecture doc predates some implementation choices (notably the move from
> PokeAPI/SQLite to `@pkmn`/Postgres). Where they disagree, trust the code and
> `CLAUDE.md`.
