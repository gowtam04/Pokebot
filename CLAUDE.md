# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Oak is a web chat agent that answers natural-language Pokémon questions (filters, lookups, mechanics reasoning, battle math). Its defining trait is that it **reasons on top of data**: tools supply raw facts (move priority, ability effect text, type charts, base stats) and the agent deduces how they interact. Every answer carries reasoning, cited sources, explicit inference/uncertainty flags, and the generation/format it's based on.

It is usable as a **guest** (in-memory, per-session) and supports optional **email/OTP accounts** that unlock durable chat history and the team builder (see `docs/features/`). It is not a single-tenant app — auth, conversations, and teams are all account-scoped.

The agent's internals (topology, the original T1–T11 tools, prompts, the `OakAnswer` output schema, eval spec) are **fixed by design** in `docs/agent-design/`. Three feature tools were appended after that contract — T12 `get_active_team`, T13 `save_team` (team-builder, reconciled into agent-design), T14 `get_encounters` (PokeAPI catch data) — for **14 tools** total. The surrounding system (data store, ingest, tool wiring, web API, frontend, eval harness) is specified in `docs/architecture/design.md`. When agent internals and the architecture doc disagree, agent-design wins on internals; the architecture doc wins on stack/storage/layout.

> `README.md` is current and accurate — it tracks the implemented app. The architecture doc, by contrast, predates several choices (the `@pkmn`/Postgres move, the multi-user account/history/team features). Where docs disagree, trust the code, then `README.md`/`CLAUDE.md`.

## Git workflow

Commit on the **current branch** — never create a new branch for a commit unless the user explicitly asks for one. This holds even when the current branch is `main`/the default branch.

## Repository layout

The app lives in **`web/`** — the Next.js app plus all of its config (`package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `drizzle.config.ts`), `src/`, `test/`, `eval/`, `drizzle/`, `scripts/`, and deployment files (`Dockerfile*`, `docker-compose.dev.yml`, `fly.toml`, `migrate.mjs`). A future mobile client gets a sibling folder (e.g. `mobile/`). Only `docs/`, `README.md`, `CLAUDE.md`, and `.git/` stay at the repo root. **All `src/…`, `test/…`, `eval/…`, and `drizzle/` paths in this document are relative to `web/`**, and the `@/` alias resolves to `web/src/`.

## Commands

Run every command below from **`web/`** (`cd web` first) — that's where `package.json` lives. Deploy with `cd web && fly deploy`.

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

Node 20+ is required (`.nvmrc`). `typecheck`, `lint`, and the jsdom component tests run with no Docker; **`npm test` (the node project) needs a running Docker daemon** — Testcontainers spins up an ephemeral `postgres:16` for the run. The full judged `eval` needs **both** a real `XAI_API_KEY` (the agent runs on Grok) and a real `ANTHROPIC_API_KEY` (the judge runs on Claude). `@pkmn` is a local package, so `ingest` never hits the network (but it does need a reachable Postgres via `DATABASE_URL`).

## Architecture

A single **TypeScript / Next.js (App Router) monolith**, rooted at `web/` (see Repository layout). One language across frontend, API, agent loop, and the ingest CLI. TS `strict`, ESM, path alias `@/` → `src/` (i.e. `web/src/` from the repo root). Files kebab-case; types/components PascalCase; DB columns snake_case (Drizzle maps to camelCase).

### Request flow

```
POST /api/chat (SSE)  →  runOak (tool-loop)  →  14 tools  →  repos  →  Postgres
   src/app/api/chat/route.ts      src/agent/runtime.ts   src/agent/tools/   src/data/repos/   node-postgres @ $DATABASE_URL
```

- **`route.ts`** validates the body `{ session_id, message, champions_mode, images? }`, applies the input-length cap + per-session rate limit *before* opening the stream, resolves prior history from the in-memory session store, then streams SSE events: `tool_activity`\* (one per tool call) → `answer_start`/`answer_delta`\* (token-by-token `answer_markdown`) → exactly one terminal `answer`. Only a transport/API fault emits an `error` event — every in-domain failure rides a normal `answer` event with the appropriate `status`. `runtime = "nodejs"`, `dynamic = "force-dynamic"`; the runtime is **dynamically imported** inside the request so `next build` doesn't evaluate `env` (which throws on a missing API key) at build time.
- **Image input (vision).** A turn can attach ≤4 images (`images: { mimeType, data(base64) }[]`). `validateImages` (`src/server/image-upload.ts`) runs before the stream opens — count cap, **magic-byte MIME sniff** (the sniffed type is canonical; Anthropic 400s on a mismatched `media_type`), and per-image/total decoded-byte caps (413), plus a `Content-Length` pre-check. The canonical images bind onto **`AgentContext.images`** (server-controlled, like `mode`/`model`/`activeTeam`) and are read once at the `provider.createTranscript(history, message, ctx.images)` call — **consume-on-turn**: images ride only on the *current* user message and are **never** stored in history (`ChatMessage`/session store/DB are untouched). Each provider formats them natively (Anthropic base64 `image` block w/ ephemeral cache breakpoint; OpenAI `image_url` data URL; Grok Responses `input_image` data URL); a text-only turn keeps `content` a plain string for byte-stability. `message` may be empty when an image is attached. All three models are vision-capable, so there's no per-model gate. Prompt guidance lives in the "Interpreting attached images" section of `prompts/domain.ts` + `champions.ts` (general reasoning, not just teams; flag illegible parts as uncertainty).
- **`runtime.ts`** drives one **provider-agnostic** tool-loop turn (`runWithProvider`). The default/primary model is **Grok 4.3** — the native xAI Responses provider (`src/agent/providers/grok-provider.ts`); Claude (`ANTHROPIC_MODEL`) and GPT-5.5 stay selectable per turn via `ctx.model`. It assembles a byte-stable, prompt-cached prefix (system + few-shot + tool defs; xAI caches a stable prefix automatically), appends history + message, loops ≤ `MAX_ITERATIONS` (10), and validates the `submit_answer` payload against the `OakAnswer` Zod schema (≤2 re-emits on failure, else synthesizes an `insufficient_data` answer). It **never throws for in-domain failures** — those return a valid `OakAnswer`; only transport faults propagate.
- **Tools** (`src/agent/tools/`, T1–T14; T1–T11 names fixed by `docs/agent-design/tools.md`, T12–T14 appended last so the cached prefix is unchanged) wrap repos + formulas and return the exact structured shapes the model reasons about. They **never throw in-domain** — they return documented shapes like `{ found:false, suggestions }`, `{ unresolved:[…] }`, `{ error:"index_unavailable" }`. `index.ts` is the barrel exporting `tools` and `dispatch`.

### Data layer — built from `@pkmn`, not PokeAPI

**Important divergence from `docs/architecture/design.md`:** the design describes a throttled PokeAPI crawler + read-through reference cache (`src/data/pokeapi-client.ts`, `warm-cache.ts`). That was **replaced by the `@pkmn` ecosystem** (`@pkmn/dex`, `@pkmn/data`, `@pkmn/mods`). Those files don't exist; there is no network call and no upstream-outage handling. All index data is built offline from local npm packages.

- **`src/data/pkmn/gen-provider.ts`** is the *single* `@pkmn` integration point. `loadFormat(format)` returns a `FormatSource` with the resolved dex, roster, moves/abilities/items/types, and `getLearnset`. Every `@pkmn` quirk (legality gates, Mega resolution, slugifying display names to legacy PokeAPI-style slugs) lives here — ingest builders never import `@pkmn` directly.
- **Ingest** (`src/ingest/run.ts`) builds every format fully in memory, then replaces each table in one async transaction (DELETE all + chunked INSERT, 500 rows/chunk — well under Postgres' 65535 bind-param cap). Idempotent. It runs under `tsx` as its own process, opens its **own** `pg.Pool` over `DATABASE_URL`, and applies migrations before writing (it cannot import `@/data/db`, which is `server-only`).
- **Postgres via Drizzle + node-postgres** (`src/data/schema.ts`, `src/data/db.ts`). `db.ts` is `server-only` and memoizes one `pg.Pool` + Drizzle handle on `globalThis` (survives Next hot-reload). The pool is lazy, so the `db` export stays synchronous; migrations are **not** run on connect — apply them out-of-band via `npm run db:migrate` (or the ingest CLI). All repo reads/writes are `async`. Schema notes: `fetched_at`/`last_success_at` are `bigint` (epoch-ms overflows int4); `count(*)`/`count(distinct)` read into JS need `.mapWith(Number)` (node-postgres returns bigint as a string); `like` → `ilike` (Postgres `LIKE` is case-sensitive). Migrations live in `drizzle/` (a single Postgres baseline; the old SQLite migrations were dropped).
- **Repos** (`src/data/repos/`) are the *sole* Postgres readers, and they are **async**. The agent runtime knows only the tool layer (`ToolDef[]`/`dispatch`), never repos; tools call repos.

### Two formats (standard + Champions)

The index stores one row-set **per format**, discriminated by a `format` column on every data table (`"scarlet-violet"` | `"champions"`). The active format comes from `AgentMode`, which is **server-controlled** — derived from the request body's `champions_mode`, bound onto `AgentContext.mode`, and read by repos/runtime. It is deliberately **never an LLM-visible tool input**, so when the Champions toggle is on, the model has no parameter to widen scope. `src/data/formats.ts` holds the pure mode↔format mapping and the current Champions regulation string; `runtime.ts` selects a parallel Champions system-prompt prefix (`src/agent/prompts/champions.ts`).

### Models & providers (Grok primary)

The agent loop is **provider-agnostic** behind the `LLMProvider` seam (`src/agent/providers/`). Three providers plug in: **xAI Grok 4.3** — the primary/default, a *native* adapter on xAI's **Responses API** (`grok-provider.ts`); **Claude** (`anthropic-provider.ts`); and **OpenAI GPT-5.5** (`openai-compatible-provider.ts`, the Chat Completions shim). The split:

- **`models.ts`** — CLIENT-SAFE registry (no SDK / `@/env`): `ModelKey`, `MODELS` (display order — **Grok first**), `DEFAULT_MODEL_KEY = "grok-4.3"`, plus `modelLabel`/`isModelKey`. Adding a model is one line here + one `factory.ts` entry. (There is **no in-app model picker** — the registry just backs server-side resolution + labels.)
- **`factory.ts`** — SERVER-ONLY: maps a `ModelKey` to its wiring and constructs the provider, **validate-on-use** (a missing key throws `ProviderNotConfiguredError` → the route's clean 503, never at boot). Only `XAI_API_KEY` is required at boot; Anthropic/OpenAI keys are optional.
- **`types.ts`** — the pure contract (no SDK). The loop pushes an OPAQUE, provider-owned transcript it never inspects, and consumes NORMALIZED stream events — that's what lets one loop serve Anthropic content-blocks, OpenAI `{role,content,tool_calls}`, and Grok Responses `input` items identically.
- The active model is **operator-controlled**, NOT chosen per request: `factory.activeModelKey()` resolves the `ACTIVE_MODEL` secret (unset ⇒ `grok-4.3`) and the route binds it onto `AgentContext.model`. Any `model` field in the request body is ignored. Like `mode`, it is never an LLM-visible tool input; switching models is one secret change (`fly secrets set ACTIVE_MODEL=…`), no rebuild. The route fails fast with a clean 503 (`isModelConfigured`) if the selected model's provider key is absent. `buildSystemSegments` (`prompts/index.ts`) routes `mode × provider.kind` to a body + style.
- **Prompts are authored PER MODEL, not one body wrapped per provider.** Claude + OpenAI share the **Markdown** domain body (`prompts/domain.ts` standard + `prompts/champions.ts`) behind thin style wrappers (`style-claude.ts` pass-through; `style-openai.ts` agent/output contracts). **Grok — the default model — runs on its OWN, XML-sectioned body** (`prompts/domain-grok.ts`, both modes) authored in xAI's idiom: hard `<constraints>` + the brittle `<output_contract>` front-loaded, a `<tool_routing>` map, a single `<stop_condition>`; `style-grok.ts` is a thin two-segment builder over it (no `<playbook>` wrapper anymore).
- **PARITY (non-negotiable):** the Claude/OpenAI body and the Grok body carry the SAME domain facts in two prompt structures. Any change to domain **semantics** — data/generation rules, tool routing, the output contract, scope, the active-team/image rules, or a worked few-shot example — MUST land in **BOTH** `domain.ts`/`champions.ts` AND `domain-grok.ts`. `style.test.ts` (Grok block) + `domain-grok.test.ts` pin the Grok body's *structure*, but they cannot catch *semantic* drift between the two prompts — that's on the author.

### Key conventions

- **Zod is the single source of truth** (`src/agent/schemas.ts`): runtime validation, inferred TS types, and the provider tool / `submit_answer` JSON Schemas (via `zod-to-json-schema`) all derive from one definition — the same JSON Schema feeds Anthropic, OpenAI, and the Grok Responses adapter. Don't hand-maintain a duplicate JSON Schema.
- **Tool names and tool output field names are a contract** the model depends on (`tools.md` / `output-formats.md`). Never rename them.
- **Error styles split at the runtime/route seam:** Result unions / structured shapes in the tool+data layer (never throw in-domain); try/catch → error mapping at the HTTP edge.
- **Frontend** (`src/components/`) renders a `OakAnswer` field-by-field (`AnswerCard` tree, under `src/components/answer-card/`). Component tests render fixture payloads only and must **never** import db/repos/runtime — they pull `server-only`/open a Postgres pool, and the jsdom project has no Testcontainers Postgres.

### Portable modules (mobile-readiness)

A future mobile client would talk to the same **`POST /api/chat` (SSE)** seam the web app uses; no LLM keys or DB access live on the client. If a JS/TS client (e.g. React Native) is ever built, these modules are already pure and platform-agnostic (no Node/Next/React/`server-only`/DB imports) and could be reused verbatim — or lifted into a shared package with no rewrite:

- `src/agent/schemas.ts` — Zod schemas + the `OakAnswer` output contract.
- `src/agent/formulas/*` — battle math (`compute-stat`, `estimate-damage`, `natures`, `type-chart`); pure, deterministic, test-guarded.
- `src/lib/sse/sse-types.ts` — the request body + SSE event types (the wire contract).
- `src/data/teams/team-schema.ts` — the team data model.
- `src/data/formats.ts` — the mode↔format mapping.
- `src/agent/models.ts` — the client-safe model registry.

Everything else (repos/`db.ts`, `src/server/auth/*`, `env.ts`, the React components) is server- or DOM-bound and stays behind the API. No shared package exists today — this is a map for when one is needed, not an existing boundary to maintain.

## Testing

Vitest with two projects (`vitest.config.ts`): a **node** project (`src/**`, `test/**`, `eval/**` `*.test.ts`) and a **jsdom** project (`*.test.tsx` component/full-stack tests). A dummy `XAI_API_KEY` (the now-required primary key) and a dummy `ANTHROPIC_API_KEY` are injected for all runs so `src/env.ts` imports succeed, Claude stays selectable, and tests can never reach the real API. Test-file infixes are human conventions, not separate runners: `*.oracle.test.ts` (deterministic tool checks vs. a fixture DB), `*.integration.test.ts`, `*.fullstack.test.tsx`.

The **node project** starts ONE Postgres container per run via a Testcontainers `globalSetup` (`test/support/pg-global-setup.ts`) and publishes its URI through Vitest `provide`/`inject`. Each DB test carves an isolated **schema** via `createPgSchema({ seed })` (`test/support/pg.ts`) and, when it exercises `resolve_entity`, installs that schema as the `@/data/db` singleton with `installAsSingleton()`. Two curated datasets exist: `seed: "tools"` (`test/fixtures/tools-fixture.ts`) and `seed: "eval"` (`eval/fixtures/seed-fixture-db.ts`); `seed: "none"` is migrated-but-empty. The **jsdom project has no globalSetup** and needs no Docker.

What's real vs. faked: Postgres (a real migrated+seeded schema), the tool layer, formulas, and Zod validation are **real**; `@pkmn` quirks and the provider clients (Anthropic / OpenAI / xAI) are **mocked/recorded** (each provider has a recorded-stream test, e.g. `grok-provider.test.ts`). Only the judged `eval` suite hits a live model. The deterministic eval subset (`eval/deterministic.ts`) is imported into Vitest so it gates every run.

## Gotchas (learned the hard way)

- **Dev runs in Docker; host `npm install` doesn't reach the container.** After adding a dependency, refresh the anonymous `node_modules` volume (it masks the host's macOS modules with the container's Linux build) — a plain restart won't pick up new packages.
- **`npm test` needs a Docker daemon** (Testcontainers Postgres for the node project). `typecheck`, `lint`, and `npm run test:components` (jsdom) run without Docker.
- **Migrate + re-ingest after any schema change.** Migrations are no longer applied on connect. Run `npm run db:migrate` then `npm run ingest` (or just `npm run docker:ingest`, which migrates first); the ingest write path DELETEs + recreates table contents, so a stale/empty DB otherwise reads as `index_unavailable`.
- **`resolve_entity` (resolve-index) reads the `@/data/db` singleton, not `ctx.db`.** Tests that exercise resolution must `installAsSingleton(fix)` (which sets `globalThis.__oakDb` + resets the resolve cache), not only bind `ctx.db`.
- **Don't force `tool_choice` while thinking is on.** Thinking + a forced `tool_choice` is a hard 400 on Sonnet 4.6. The loop uses `tool_choice: "auto"` + adaptive thinking and drives `submit_answer` via the system prompt and the max-iteration guard. If you change this, keep the iteration cap.
- **The native Grok provider speaks xAI's Responses API, not Chat Completions.** `grok-provider.ts` uses `client.responses.create` (the OpenAI SDK pointed at `XAI_BASE_URL` — no extra dependency). Quirks vs. the OpenAI shim: tools use the FLATTENED Responses shape (`{type:"function", name, …}`, *not* `{function:{…}}`); `reasoning:{effort:"high"}` is set EXPLICITLY (grok-4.3 defaults to `low`); the turn is stateless (`store:false`) and echoes the whole `response.output` (reasoning + message + function_call) back, flattening the opaque transcript at request time — so the loop stays untouched; reasoning round-trips via `include:["reasoning.encrypted_content"]` (set `echoReasoning:false` if xAI ever rejects reasoning-as-input); and xAI delivers tool-call args in ONE chunk, so `answer_markdown` arrives in a single `answer_delta` (the `function_call_arguments.done` fallback covers it). Prompt caching is automatic on a stable prefix — no `cache_control`.
- **`env` is validated at module load and throws on a missing `XAI_API_KEY`** (Grok is the primary provider — its key is the only required one; `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are optional, validate-on-use). That's why the route dynamically imports the runtime and `drizzle.config.ts` reads `DATABASE_URL` directly instead of importing `src/env.ts`. (`DATABASE_URL` itself has a dev default, so it's not required to boot.)
