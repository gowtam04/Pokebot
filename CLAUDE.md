# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Oak is a single-user web chat agent that answers natural-language Pokémon questions (filters, lookups, mechanics reasoning, battle math). Its defining trait is that it **reasons on top of data**: tools supply raw facts (move priority, ability effect text, type charts, base stats) and the agent deduces how they interact. Every answer carries reasoning, cited sources, explicit inference/uncertainty flags, and the generation/format it's based on.

The agent's internals (topology, the 11 tools, prompts, the `OakAnswer` output schema, eval spec) are **fixed by design** in `docs/agent-design/`. The surrounding system (data store, ingest, tool wiring, web API, frontend, eval harness) is specified in `docs/architecture/design.md`. When agent internals and the architecture doc disagree, agent-design wins on internals; the architecture doc wins on stack/storage/layout.

> Note: `README.md` is stale — it claims "design phase, no code yet." The app is fully implemented. Trust the code and `docs/`, not the README's status line.

## Commands

```bash
npm run dev          # next dev (local)
npm run build        # next build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # vitest run (unit + integration + deterministic eval subset) — NEEDS Docker (Testcontainers Postgres)
npm run db:migrate   # tsx src/data/migrate.ts — apply Drizzle migrations to $DATABASE_URL
npm run ingest       # tsx src/ingest/run.ts — (re)build the Postgres index from @pkmn (runs migrations first)
npm run eval         # tsx eval/run.ts — full LLM-judge golden suite (live model)
```

Run a single test file or test:

```bash
npx vitest run src/agent/formulas/compute-stat.test.ts   # one file
npx vitest run -t "Garchomp Speed"                        # by test-name pattern
npx vitest run --project node                             # only the node project
```

Ingest variants and eval modes are flag-driven:

```bash
npm run ingest -- --formats=scarlet-violet        # build one format only (default: both)
tsx eval/run.ts --deterministic                   # offline CI subset (mocked model, fixture DB)
tsx eval/run.ts --rebuild                          # post-ingest regression set (G1/G5/G6/G7/G17)
tsx eval/run.ts --case=G4,G11                      # specific golden cases
```

Docker dev (the intended dev environment — see Gotchas):

```bash
npm run docker:dev      # build + up (Postgres `db` + next dev on :3000)
npm run docker:migrate  # apply migrations inside the container
npm run docker:ingest   # run ingest inside the container (migrates first)
npm run docker:psql     # psql shell into the Postgres service
npm run docker:logs     # tail web logs
npm run docker:sh       # shell into the web container
npm run docker:down
```

Node 20+ is required (`.nvmrc`). `typecheck`, `lint`, and the jsdom component tests run with no Docker; **`npm test` (the node project) needs a running Docker daemon** — Testcontainers spins up an ephemeral `postgres:16` for the run. The full judged `eval`/live model need a real `ANTHROPIC_API_KEY`. `@pkmn` is a local package, so `ingest` never hits the network (but it does need a reachable Postgres via `DATABASE_URL`).

## Architecture

A single **TypeScript / Next.js (App Router) monolith**. One language across frontend, API, agent loop, and the ingest CLI. TS `strict`, ESM, path alias `@/` → `src/`. Files kebab-case; types/components PascalCase; DB columns snake_case (Drizzle maps to camelCase).

### Request flow

```
POST /api/chat (SSE)  →  runOak (tool-loop)  →  11 tools  →  repos  →  Postgres
   src/app/api/chat/route.ts      src/agent/runtime.ts   src/agent/tools/   src/data/repos/   node-postgres @ $DATABASE_URL
```

- **`route.ts`** validates the body `{ session_id, message, champions_mode }`, applies the input-length cap + per-session rate limit *before* opening the stream, resolves prior history from the in-memory session store, then streams SSE events: `tool_activity`\* (one per tool call) → `answer_start`/`answer_delta`\* (token-by-token `answer_markdown`) → exactly one terminal `answer`. Only a transport/API fault emits an `error` event — every in-domain failure rides a normal `answer` event with the appropriate `status`. `runtime = "nodejs"`, `dynamic = "force-dynamic"`; the runtime is **dynamically imported** inside the request so `next build` doesn't evaluate `env` (which throws on a missing API key) at build time.
- **`runtime.ts`** drives one Claude tool-loop turn (model is `ANTHROPIC_MODEL`, default Sonnet 4.6). It assembles a byte-identical, prompt-cached prefix (system + few-shot + 11 tool defs), appends history + message, loops ≤ `MAX_ITERATIONS` (10), and validates the `submit_answer` payload against the `OakAnswer` Zod schema (≤2 re-emits on failure, else synthesizes an `insufficient_data` answer). It **never throws for in-domain failures** — those return a valid `OakAnswer`; only transport faults propagate.
- **Tools** (`src/agent/tools/`, T1–T11, names fixed by `docs/agent-design/tools.md`) wrap repos + formulas and return the exact structured shapes the model reasons about. They **never throw in-domain** — they return documented shapes like `{ found:false, suggestions }`, `{ unresolved:[…] }`, `{ error:"index_unavailable" }`. `index.ts` is the barrel exporting `tools` and `dispatch`.

### Data layer — built from `@pkmn`, not PokeAPI

**Important divergence from `docs/architecture/design.md`:** the design describes a throttled PokeAPI crawler + read-through reference cache (`src/data/pokeapi-client.ts`, `warm-cache.ts`). That was **replaced by the `@pkmn` ecosystem** (`@pkmn/dex`, `@pkmn/data`, `@pkmn/mods`). Those files don't exist; there is no network call and no upstream-outage handling. All index data is built offline from local npm packages.

- **`src/data/pkmn/gen-provider.ts`** is the *single* `@pkmn` integration point. `loadFormat(format)` returns a `FormatSource` with the resolved dex, roster, moves/abilities/items/types, and `getLearnset`. Every `@pkmn` quirk (legality gates, Mega resolution, slugifying display names to legacy PokeAPI-style slugs) lives here — ingest builders never import `@pkmn` directly.
- **Ingest** (`src/ingest/run.ts`) builds every format fully in memory, then replaces each table in one async transaction (DELETE all + chunked INSERT, 500 rows/chunk — well under Postgres' 65535 bind-param cap). Idempotent. It runs under `tsx` as its own process, opens its **own** `pg.Pool` over `DATABASE_URL`, and applies migrations before writing (it cannot import `@/data/db`, which is `server-only`).
- **Postgres via Drizzle + node-postgres** (`src/data/schema.ts`, `src/data/db.ts`). `db.ts` is `server-only` and memoizes one `pg.Pool` + Drizzle handle on `globalThis` (survives Next hot-reload). The pool is lazy, so the `db` export stays synchronous; migrations are **not** run on connect — apply them out-of-band via `npm run db:migrate` (or the ingest CLI). All repo reads/writes are `async`. Schema notes: `fetched_at`/`last_success_at` are `bigint` (epoch-ms overflows int4); `count(*)`/`count(distinct)` read into JS need `.mapWith(Number)` (node-postgres returns bigint as a string); `like` → `ilike` (Postgres `LIKE` is case-sensitive). Migrations live in `drizzle/` (a single Postgres baseline; the old SQLite migrations were dropped).
- **Repos** (`src/data/repos/`) are the *sole* Postgres readers, and they are **async**. The agent runtime knows only the tool layer (`ToolDef[]`/`dispatch`), never repos; tools call repos.

### Two formats (standard + Champions)

The index stores one row-set **per format**, discriminated by a `format` column on every data table (`"scarlet-violet"` | `"champions"`). The active format comes from `AgentMode`, which is **server-controlled** — derived from the request body's `champions_mode`, bound onto `AgentContext.mode`, and read by repos/runtime. It is deliberately **never an LLM-visible tool input**, so when the Champions toggle is on, the model has no parameter to widen scope. `src/data/formats.ts` holds the pure mode↔format mapping and the current Champions regulation string; `runtime.ts` selects a parallel Champions system-prompt prefix (`src/agent/prompts/champions.ts`).

### Key conventions

- **Zod is the single source of truth** (`src/agent/schemas.ts`): runtime validation, inferred TS types, and the Anthropic tool / `submit_answer` JSON Schemas (via `zod-to-json-schema`) all derive from one definition. Don't hand-maintain a duplicate JSON Schema.
- **Tool names and tool output field names are a contract** the model depends on (`tools.md` / `output-formats.md`). Never rename them.
- **Error styles split at the runtime/route seam:** Result unions / structured shapes in the tool+data layer (never throw in-domain); try/catch → error mapping at the HTTP edge.
- **Frontend** (`src/components/`) renders a `OakAnswer` field-by-field (`AnswerCard` tree). Component tests render fixture payloads only and must **never** import db/repos/runtime — they pull `server-only`/open a Postgres pool, and the jsdom project has no Testcontainers Postgres.

## Testing

Vitest with two projects (`vitest.config.ts`): a **node** project (`src/**`, `test/**`, `eval/**` `*.test.ts`) and a **jsdom** project (`*.test.tsx` component/full-stack tests). A dummy `ANTHROPIC_API_KEY` is injected for all runs so `src/env.ts` imports succeed and tests can never reach the real API. Test-file infixes are human conventions, not separate runners: `*.oracle.test.ts` (deterministic tool checks vs. a fixture DB), `*.integration.test.ts`, `*.fullstack.test.tsx`.

The **node project** starts ONE Postgres container per run via a Testcontainers `globalSetup` (`test/support/pg-global-setup.ts`) and publishes its URI through Vitest `provide`/`inject`. Each DB test carves an isolated **schema** via `createPgSchema({ seed })` (`test/support/pg.ts`) and, when it exercises `resolve_entity`, installs that schema as the `@/data/db` singleton with `installAsSingleton()`. Two curated datasets exist: `seed: "tools"` (`test/fixtures/tools-fixture.ts`) and `seed: "eval"` (`eval/fixtures/seed-fixture-db.ts`); `seed: "none"` is migrated-but-empty. The **jsdom project has no globalSetup** and needs no Docker.

What's real vs. faked: Postgres (a real migrated+seeded schema), the tool layer, formulas, and Zod validation are **real**; `@pkmn` quirks and the Anthropic client are **mocked/recorded**. Only the judged `eval` suite hits a live model. The deterministic eval subset (`eval/deterministic.ts`) is imported into Vitest so it gates every run.

## Gotchas (learned the hard way)

- **Dev runs in Docker; host `npm install` doesn't reach the container.** After adding a dependency, refresh the anonymous `node_modules` volume (it masks the host's macOS modules with the container's Linux build) — a plain restart won't pick up new packages.
- **`npm test` needs a Docker daemon** (Testcontainers Postgres for the node project). `typecheck`, `lint`, and `npm run test:components` (jsdom) run without Docker.
- **Migrate + re-ingest after any schema change.** Migrations are no longer applied on connect. Run `npm run db:migrate` then `npm run ingest` (or just `npm run docker:ingest`, which migrates first); the ingest write path DELETEs + recreates table contents, so a stale/empty DB otherwise reads as `index_unavailable`.
- **`resolve_entity` (resolve-index) reads the `@/data/db` singleton, not `ctx.db`.** Tests that exercise resolution must `installAsSingleton(fix)` (which sets `globalThis.__oakDb` + resets the resolve cache), not only bind `ctx.db`.
- **Don't force `tool_choice` while thinking is on.** Thinking + a forced `tool_choice` is a hard 400 on Sonnet 4.6. The loop uses `tool_choice: "auto"` + adaptive thinking and drives `submit_answer` via the system prompt and the max-iteration guard. If you change this, keep the iteration cap.
- **`env` is validated at module load and throws on a missing `ANTHROPIC_API_KEY`.** That's why the route dynamically imports the runtime and `drizzle.config.ts` reads `DATABASE_URL` directly instead of importing `src/env.ts`. (`DATABASE_URL` itself has a dev default, so it's not required to boot.)
