# Oak — Technical Design

## Overview

Mode: Developer
Budget Tier: hobby

Oak is a personal, single-user web chat agent that answers natural-language
Pokémon questions (filters, lookups, mechanics reasoning, battle math), with every
answer carrying its reasoning, cited PokeAPI data, inference flags, and the
generation it's based on. The **agent itself is already fully designed** in
`docs/agent-design/` (Mode B — "the agent IS the product"): one Sonnet-4.6
tool-loop with 11 fixed tools, a fixed `OakAnswer` output schema, and a fixed
eval spec. **This document does not redesign any of that.**

This is a **thin architecture pass**: it designs the _surrounding system_ the
agent needs to run — the local data store and ingest pipeline (the largest build
item), the data-access and tool-wiring layers, the streaming web API, the
frontend renderer, the eval harness, and the build phases. Technical approach:

> A single **TypeScript / Next.js monolith**. The frontend (React) and the
> `POST /api/chat` SSE endpoint live in one Next.js app; the agent loop, tool
> implementations, and ingest pipeline are Node modules/scripts in the same repo.
> Derived data (Pokédex index, Gen-9 learnsets, reference cache) lives in an
> on-disk **SQLite** database accessed through **Drizzle ORM**. Runtime
> validation and all tool/`submit_answer` schemas derive from **Zod**. Logs are
> structured **pino** JSON to stdout. One language, one deployable, mostly-free
> infrastructure — right-sized for a single user.

## Implementation status & drift from the original design

**The system is fully built.** This document was written as a pre-build
architecture pass; the sections below have been reconciled with the shipped code.
Five things changed materially after the original design and are reflected
throughout this doc — recorded here as well so the divergence is explicit:

1. **Data source: PokeAPI → the `@pkmn` ecosystem.** All index data now comes
   from local npm packages (`@pkmn/dex`, `@pkmn/data`, `@pkmn/mods`) — there is
   **no network call, no throttle/retry, and no read-through cache**. The
   throttled `src/data/pokeapi-client.ts` and `src/ingest/warm-cache.ts` were
   never built; their role is filled by `src/data/pkmn/gen-provider.ts` (the
   single `@pkmn` integration point) and an ingest that builds the
   `reference_cache` **eagerly** (`src/ingest/build-reference.ts`). BR-8 (PokeAPI
   fair-use) is therefore moot — nothing calls upstream.
2. **Two formats (standard + Champions).** Every data table carries a `format`
   discriminator (`"scarlet-violet"` | `"champions"`) and composite PKs include
   it. The active format is derived from a **server-controlled** `AgentMode`
   (`"standard"` | `"champions"`), bound onto `AgentContext.mode` and read by
   repos + the runtime — never an LLM-visible tool field. See `src/data/formats.ts`
   and `src/agent/prompts/champions.ts`.
3. **`tool_choice` is `"auto"`, not forced.** Thinking + a forced `tool_choice`
   is a hard 400 on Sonnet 4.6, so the loop runs `tool_choice: "auto"` with
   adaptive thinking and drives `submit_answer` through the system prompt + the
   max-iteration guard (the iteration cap is what guarantees termination).
4. **The SSE protocol streams the answer.** Beyond `tool_activity` + the terminal
   `answer`, the route emits `answer_start` / `answer_delta` events that stream
   `answer_markdown` token-by-token (extracted from the streaming `submit_answer`
   input). The request body gained a `champions_mode` boolean.
5. **`learnset` is keyed by `format`, not `version_group`.** Multi-move
   intersection (BR-7) is unchanged (SQL `GROUP BY … HAVING COUNT(DISTINCT)=N`).
   Ingest's "reuse-last-good on upstream failure" path is gone (no upstream).

## Requirements Reference

- Business requirements: `docs/requirements/requirements.md`
- **Agent design (fixed constraints — do not redesign):** `docs/agent-design/`
  - `overview.md` (topology, decisions D1–D10, dependency list), `tools.md`
    (the 11 tool contracts), `data-sources.md` (DS-1…DS-5 logical schemas),
    `integration.md` (invocation signature, error surface, observability hooks,
    guardrails), `output-formats.md` (the `OakAnswer` JSON Schema + consumer
    contract), `ux-design.md` (UI interaction contract), `prompts.md` (system
    prompt + few-shot — transcribed into code, not authored here),
    `evaluation.md` (golden cases G1–G24 + metrics — the spec the eval _harness_
    must satisfy).

`dev-team` must load **both** this folder and `docs/agent-design/`. Where they
overlap, the agent-design folder wins on agent internals; this doc wins on stack,
storage, file layout, and phasing.

## Tech Stack

| Layer               | Choice                                                    | Notes                                                                                                         |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Language / runtime  | TypeScript on Node 20+                                    | Single language across frontend, API, agent, ingest.                                                          |
| App framework       | **Next.js (App Router)**                                  | React UI + `/api/chat` route handler in one deployable.                                                       |
| Local store         | **SQLite** via `better-sqlite3`                           | On-disk file; synchronous, fast reads; perfect for single-user.                                               |
| Data access         | **Drizzle ORM**                                           | Typed schema + queries over better-sqlite3; lightweight migrations for the ingest schema.                     |
| Streaming           | **Server-Sent Events (SSE)**                              | One-directional progress events + final answer over plain HTTP.                                               |
| Validation          | **Zod** (+ `zod-to-json-schema`)                          | Single source of truth → runtime validation, TS types, and the Anthropic tool / `submit_answer` JSON Schemas. |
| LLM SDK             | **`@anthropic-ai/sdk`**, model **Sonnet 4.6**             | Streaming tool-loop, prompt caching, `tool_choice: "auto"` + adaptive thinking (forced + thinking = 400; D2). |
| Fuzzy resolve       | `fuse.js`                                                 | In-memory matcher for `resolve_entity` over the names table.                                                  |
| Data source         | **`@pkmn/dex` · `@pkmn/data` · `@pkmn/mods`**             | Local packages — Showdown's dex/learnsets + the `champions` mod. **No network**; ingest builds offline.       |
| Logging             | **pino** → stdout                                         | Structured per-turn trace (see `integration.md`).                                                             |
| Tests               | **Vitest**                                                | Unit + integration; eval harness split (deterministic CI subset vs. nightly LLM-judge).                       |
| Tooling             | tsx (script runner), ESLint + Prettier, TypeScript strict | `npm run ingest`, `npm run eval` via tsx.                                                                     |

No vector store, no message queue, no managed cache — none are required (see
Deployment & Infrastructure for the rationale per ladder rung).

## Data Model

The **logical** data model is fixed by `docs/agent-design/data-sources.md`
(DS-2 Pokédex index, DS-3 Gen-9 learnsets, DS-4 reference cache, DS-5 in-session
history). This pass adds only the **physical schema** — the SQLite tables, column
types, and indexes that back those logical stores. All tables are _derived_ from
the **`@pkmn` packages** by the ingest pipeline; none hold user data (no PII, no
auth — single user).

> **Per-format storage.** Every data table below carries a `format` text column
> (`"scarlet-violet"` | `"champions"`) and includes it in the primary key, so one
> physical schema holds both the standard Gen-9 index and the Champions index.
> Repos filter by the format derived from the turn's `AgentMode`. The columns
> shown below are otherwise as originally designed.

### `pokemon` — DS-2 Pokédex index (one row per (format, battle-relevant form), D8)

| Column                 | Type          | Notes                                                        |
| ---------------------- | ------------- | ------------------------------------------------------------ |
| `format`               | text PK       | `scarlet-violet` \| `champions`. Part of the composite PK.   |
| `id`                   | text PK       | PokeAPI-style `pokemon` slug, e.g. `tauros-paldea-aqua`.     |
| `species_name`         | text          | e.g. `tauros`.                                               |
| `form_name`            | text null     | e.g. `paldea-aqua`; null for base form.                      |
| `display_name`         | text          | Disambiguating label, e.g. "Tauros (Paldean Aqua)".          |
| `national_dex_number`  | integer       |                                                              |
| `type1`                | text          | One of the 18 type slugs.                                    |
| `type2`                | text null     | Null for mono-type.                                          |
| `ability_slot1`        | text          |                                                              |
| `ability_slot2`        | text null     |                                                              |
| `ability_hidden`       | text null     |                                                              |
| `stat_hp`…`stat_speed` | integer ×6    | hp, attack, defense, special_attack, special_defense, speed. |
| `base_stat_total`      | integer       | Precomputed sum (for BST sort/threshold).                    |
| `sprite_url`           | text          |                                                              |
| `artwork_url`          | text          |                                                              |
| `generation`           | text          | e.g. `gen-9` (standard) / `champions`.                       |
| `is_gen9_native`       | integer (0/1) | BR-1. In Champions every indexed row is legal ⇒ always 1.    |
| `source_generation`    | text null     | Set when `is_gen9_native=0` (BR-1), e.g. `gen-8`.            |

PK `(format, id)`. Indexes: `national_dex_number`; each of the six `stat_*`
columns + `base_stat_total` (threshold/superlative queries, AC-3.x); `type1`,
`type2` (type filters, US-2).

### `learnset` — DS-3 Gen-9 learnset index (D6, BR-2)

| Column       | Type      | Notes                                                                    |
| ------------ | --------- | ------------------------------------------------------------------------ |
| `pokemon_id` | text      | FK → `pokemon.id` (within the same format).                              |
| `move_slug`  | text      | Canonical move slug.                                                     |
| `format`     | text      | `scarlet-violet` \| `champions`. Part of the composite PK.               |
| `method`     | text null | `level-up` / `machine` / `tutor`. Egg moves **excluded** (out of scope). |

PK `(pokemon_id, move_slug, format)`. Indexes: `move_slug` ("what learns X",
AC-1.2); `pokemon_id`. Multi-move **intersection** (BR-7) is a single SQL
`GROUP BY pokemon_id HAVING COUNT(DISTINCT move_slug) = N` — computed in the DB,
never by the model.

### `reference_cache` — DS-4 reference detail (pre-built per format at ingest)

Originally designed as a lazy read-through cache over PokeAPI (BR-8). Since the
`@pkmn` migration it is **pre-built eagerly** by ingest (`build-reference.ts`):
the `get_*` tools read it from SQLite only — there is no upstream to fall back to
and no TTL.

| Column          | Type        | Notes                                                                                                 |
| --------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `format`        | text PK     | `scarlet-violet` \| `champions`. Part of the composite PK.                                             |
| `resource_key`  | text PK     | e.g. `move/fake-out`, `ability/armor-tail`, `type/ground`, `evolution-chain/eevee`, `item/leftovers`. |
| `resource_kind` | text        | `move` / `ability` / `type` / `evolution` / `item`.                                                   |
| `payload`       | text (JSON) | The **normalized** detail shape the tool returns (not raw source JSON).                                |
| `endpoint_url`  | text        | Source label for citations (e.g. `@pkmn/dex (Pokémon Showdown)`).                                      |
| `fetched_at`    | integer     | Epoch ms the row was built (informational; **no TTL**).                                                |

PK `(format, resource_key)`.

### `searchable_names` — backs `resolve_entity` (T1, BR-9)

| Column         | Type | Notes                                             |
| -------------- | ---- | ------------------------------------------------- |
| `format`       | text | `scarlet-violet` \| `champions`. Part of the PK.  |
| `kind`         | text | `pokemon` / `move` / `ability` / `type` / `item`. |
| `slug`         | text | Canonical slug.                                   |
| `display_name` | text | Human label.                                      |

PK `(format, kind, slug)`. Loaded into an in-memory fuzzy index; `resolve_entity`
ranks candidates over the active format's rows.

### `ingest_meta` — pipeline bookkeeping (one row **per format**)

Columns: `format` (PK), `last_success_at`, `pokemon_count`, `learnset_count`,
`names_count`, `schema_version`. Lets the app detect a missing/stale/empty index
and return `index_unavailable` gracefully (per `data-sources.md` failure behavior)
instead of crashing. (The original single-row `version_groups` design was dropped
with the move to per-format storage.)

> DS-5 (in-session history) is **not** in SQLite — it lives in an in-memory
> session store (D9, no persistence). See Component Design § Session Store.

## Component Design

Agent **internals** (prompt content, tool I/O semantics, loop policy, output
schema) are fixed by `docs/agent-design/`. The components below are the
surrounding system; for the tool layer and agent runtime, this pass owns _where
code lives and how it's wired_, not _what the agent does_.

| Component                                              | Responsibility                                                                                                                                                                                                                                                                                                         | Exposes                                                         | Depends on                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| **Ingest pipeline** (`src/ingest/`)                    | Build `pokemon`, `learnset`, `searchable_names`, `reference_cache` **per format** from the `@pkmn` packages; write `ingest_meta`. Build-all-in-memory then swap each table in one transaction; idempotent. `@pkmn` is local → no upstream, no reuse-last-good.                                                          | `runIngest(opts): Promise<IngestReport>`; `npm run ingest` CLI. | gen-provider, Drizzle schema.      |
| **`@pkmn` provider** (`src/data/pkmn/gen-provider.ts`) | The _only_ code that touches `@pkmn`. `loadFormat(format)` resolves the gen-scoped or modded dex, the legal roster, moves/abilities/items/types, and `getLearnset`. No network.                                                                                                                                       | `loadFormat(format): Promise<FormatSource>`; `slugFor`.         | `@pkmn/dex`, `@pkmn/mods`.         |
| **Data-access repositories** (`src/data/repos/`)       | Typed reads over SQLite, scoped to the turn's format. `PokedexRepo` (dynamic filter/sort/threshold SQL for `query_pokedex`), `LearnsetRepo` (intersection), `ReferenceCache` (reads the pre-built rows), `ResolveIndex` (in-memory fuzzy).                                                                             | Repo methods returning Result unions.                           | Drizzle.                           |
| **Formula functions** (`src/agent/formulas/`)          | Deterministic `compute_stat` / `estimate_damage` (D5) — pure functions, per-step flooring.                                                                                                                                                                                                                             | `computeStat(...)`, `estimateDamage(...)`.                      | none.                              |
| **Tool layer** (`src/agent/tools/`)                    | The 11 tool implementations (T1–T11) wrapping repos + formulas; each returns the exact structured shape in `tools.md`; Zod input/output schemas → JSON Schema for the SDK.                                                                                                                                             | `tools: ToolDef[]`; `submitAnswerSchema`.                       | repos, formulas, Zod.              |
| **Agent runtime** (`src/agent/runtime.ts`)             | `runOak`: assemble cached prefix (system + tools + few-shot; a Champions-mode prefix variant) → append history + message → streaming Sonnet tool-loop (max 10, `tool_choice: auto` + adaptive thinking) → drive `submit_answer` via prompt + iteration guard → validate `OakAnswer`, retry ≤2 on schema fail → return payload. Emits progress + answer-delta callbacks; assembles the per-turn log trace. | `runOak(message, history, ctx, onProgress?, onAnswerStart?, onAnswerDelta?): Promise<OakAnswer>`. | Anthropic SDK, tool layer, logger. |
| **Web API** (`src/app/api/chat/route.ts`)              | `POST /api/chat` SSE handler: input-length cap + per-session rate limit; derive `AgentMode` from the body's `champions_mode`; resolve history from session store; call `runOak` with hooks streaming `tool_activity` then `answer_start`/`answer_delta`; emit the terminal `answer` event; map errors per `integration.md`.                                                                 | HTTP SSE endpoint.                                              | Agent runtime, session store.      |
| **Session store** (`src/server/session-store.ts`)      | In-memory `Map<session_id, ChatMessage[]>` (DS-5, D9). Append turns; trim oldest when near context budget. No persistence.                                                                                                                                                                                             | `getHistory`, `appendTurn`, `trim`.                             | none.                              |
| **Logger** (`src/server/logger.ts`)                    | pino instance + helper to assemble the per-turn trace (request_id, session_id, model, tokens, full tool-call trace, latency, status, citation count).                                                                                                                                                                  | `logger`, `logTurn(trace)`.                                     | pino.                              |
| **Frontend renderer** (`src/app/` + `src/components/`) | Chat shell + `AnswerCard` component tree rendering `OakAnswer` field-by-field; SSE client hook; progress UI. **Visual styling deferred to the `frontend-design` skill.**                                                                                                                                           | React components.                                               | SSE endpoint.                      |
| **Eval harness** (`eval/`)                             | G1–G24 cases, runner, LLM-judge, fixture DB; deterministic subset exported for Vitest CI.                                                                                                                                                                                                                              | `npm run eval`; `deterministicCases` for Vitest.                | Agent runtime, fixture DB.         |

## API Design

The HTTP contract (`POST /api/chat`, request/response, error surface) is fixed by
`docs/agent-design/integration.md`. This pass formalizes only the **SSE event
protocol** the route emits (the architect's seam to nail down):

```
POST /api/chat   Body: { session_id: string, message: string, champions_mode?: boolean }
Response: text/event-stream, events emitted in order:

  event: tool_activity
  data: { "tool": "query_pokedex", "label": "📊 querying Pokédex…" }
  …(zero or more, as the loop calls tools)…

  event: answer_start                           // submit_answer began streaming
  data: {}                                       // resets the client's in-flight buffer
  event: answer_delta                            // zero or more, token-by-token
  data: { "text": "It depends on Farigiraf's…" } // newly-decoded answer_markdown fragment

  event: answer
  data: { "answer": <OakAnswer> }          // exactly one, terminal + authoritative

  event: error                                  // only on transport failure
  data: { "code": "agent_error", "message": "…" }   // → maps to HTTP-level retry affordance
```

- `champions_mode: true` scopes the whole turn to the Champions index; omitted /
  false is standard Gen-9 behavior. It is server-controlled (an `AgentMode` on the
  context), never a model-visible tool field.
- `answer_start` / `answer_delta` stream `answer_markdown` as the model emits the
  `submit_answer` input; a re-emitted answer (after a validation failure) sends a
  fresh `answer_start` so the client replaces rather than appends. The terminal
  `answer` event remains authoritative.

- All non-transport conditions (unresolved entity, clarification, PokeAPI down,
  index missing, loop-max-without-answer, invalid-after-retry) are delivered as a
  **normal `answer` event** carrying a `OakAnswer` with the appropriate
  `status` (`resolution_failed` / `clarification_needed` / `insufficient_data`) —
  never as an `error` event. The `error` event is reserved for model/API
  transport faults (`integration.md` error table, last two rows).
- Clicking a suggestion chip or candidate row is a **normal follow-up POST** with
  the same `session_id` — no special protocol (`ux-design.md`).

## File Structure

Ownership map — each file has one purpose; no two phases edit the same file
(collision points are listed in the Build Manifest's `shared`).

```
oak/
├── package.json                       — scripts: dev, build, start, test, typecheck, lint, ingest, eval
├── next.config.ts                     — Next.js config (App Router, server external packages for better-sqlite3)
├── tsconfig.json                      — strict TS
├── drizzle.config.ts                  — Drizzle migration config (SQLite dialect)
├── vitest.config.ts                   — Vitest config (node + jsdom projects)
├── .eslintrc.cjs / .prettierrc        — lint/format
├── .env.example                       — ANTHROPIC_API_KEY, OAK_DB_PATH, POKEAPI_BASE_URL, etc.
│
├── data/                              — gitignored runtime artifacts
│   └── oak.sqlite                 — the built index + cache (produced by ingest)
│
├── src/
│   ├── env.ts                         — typed env loader (Zod-validated process.env)
│   │
│   ├── data/
│   │   ├── db.ts                      — better-sqlite3 connection + Drizzle instance (server-only singleton)
│   │   ├── schema.ts                  — Drizzle table defs (each carries a `format` col): pokemon, learnset,
│   │   │                                reference_cache, searchable_names, ingest_meta (+ indexes)
│   │   ├── formats.ts                 — Format type + AgentMode→Format mapping + Champions regulation string
│   │   ├── pkmn/
│   │   │   └── gen-provider.ts        — the ONLY @pkmn integration point: loadFormat(format) → FormatSource
│   │   └── repos/
│   │       ├── pokedex-repo.ts        — query_pokedex dynamic SQL (filters/sort/threshold); get_pokemon read
│   │       ├── learnset-repo.ts       — learnset membership + multi-move intersection (BR-7)
│   │       ├── reference-cache.ts     — reads the pre-built reference_cache rows (move/ability/type/evo/item)
│   │       └── resolve-index.ts       — in-memory fuzzy matcher over searchable_names (resolve_entity)
│   │
│   ├── ingest/
│   │   ├── run.ts                     — CLI (`npm run ingest`): per-format build → swap; writes ingest_meta
│   │   ├── build-pokedex.ts           — DS-2: @pkmn roster → pokemon rows (D8 forms rule)
│   │   ├── build-learnsets.ts         — DS-3: per kept form, @pkmn learnset → rows (source-string method; D6)
│   │   ├── build-names.ts             — searchable_names from DS-2 + the @pkmn name lists
│   │   └── build-reference.ts         — pre-builds reference_cache (move/ability/type/evo/item) per format
│   │
│   ├── agent/
│   │   ├── runtime.ts                 — runOak: prefix assembly, streaming tool-loop (auto + adaptive
│   │   │                                thinking), submit_answer validate+retry, answer-delta streaming
│   │   ├── types.ts                   — cross-phase contract types (AgentContext, AgentMode, ToolDef, callbacks)
│   │   ├── context.ts                 — AgentContext factory (binds db handle, logger, request_id, mode)
│   │   ├── schemas.ts                 — Zod schemas for tool I/O + OakAnswer; zod-to-json-schema exports
│   │   ├── prompts/
│   │   │   ├── system.ts              — standard system prompt (from agent-design/prompts.md)
│   │   │   ├── few-shot.ts            — standard few-shot examples (from agent-design/prompts.md)
│   │   │   └── champions.ts           — Champions-mode system prompt + few-shot variant
│   │   ├── formulas/
│   │   │   ├── compute-stat.ts        — T9 pure function (+ HP/Shedinja edge case)
│   │   │   └── estimate-damage.ts     — T10 pure function (min–max roll)
│   │   └── tools/
│   │       ├── index.ts               — assembles the ToolDef[] + tool dispatch table
│   │       ├── resolve-entity.ts      — T1
│   │       ├── query-pokedex.ts       — T2 (the workhorse)
│   │       ├── get-pokemon.ts         — T3
│   │       ├── get-move.ts            — T4
│   │       ├── get-ability.ts         — T5
│   │       ├── get-type-matchups.ts   — T6
│   │       ├── get-evolution-chain.ts — T7
│   │       ├── get-item.ts            — T8
│   │       ├── compute-stat.tool.ts   — T9 (wraps formula)
│   │       ├── estimate-damage.tool.ts— T10 (wraps formula)
│   │       └── submit-answer.ts       — T11 (structured-output / terminal)
│   │
│   ├── server/
│   │   ├── session-store.ts           — in-memory in-session history (DS-5, D9)
│   │   ├── rate-limit.ts              — per-session limiter + input-length cap
│   │   └── logger.ts                  — pino instance + logTurn(trace)
│   │
│   ├── app/
│   │   ├── layout.tsx                 — root layout
│   │   ├── page.tsx                   — chat page (thread + composer)
│   │   └── api/
│   │       └── chat/route.ts          — POST /api/chat SSE handler (input cap, rate limit, error mapping)
│   │
│   ├── components/                    — AnswerCard tree + chat shell (styled per docs/design-system/)
│   │   ├── ChatThread.tsx             — message list
│   │   ├── Composer.tsx               — input box
│   │   ├── ChampionsToggle.tsx        — Champions-mode switch (sets champions_mode on the POST)
│   │   ├── ThemeToggle.tsx            — light/dark theme switch
│   │   ├── Markdown.tsx               — react-markdown + remark-gfm renderer
│   │   ├── AnswerCard.tsx             — top-level renderer of a OakAnswer
│   │   ├── AnswerBody.tsx             — answer_markdown
│   │   ├── ReasoningBlock.tsx         — reasoning_markdown (collapsible)
│   │   ├── SpriteCard.tsx             — subjects[] sprite/artwork + name
│   │   ├── TypeBadge.tsx              — one of 18 types → color badge (palette from frontend-design)
│   │   ├── CandidateTable.tsx         — candidates (N of M when truncated)
│   │   ├── SourceList.tsx             — citations[] (collapsible)
│   │   ├── InferenceCallout.tsx       — inferences[]
│   │   ├── CaveatStrip.tsx            — uncertainty_flags + generation_basis.fallback
│   │   ├── DamageReadout.tsx          — damage_calc (assumptions + estimate tag)
│   │   └── SuggestionChips.tsx        — suggestions[] (click → follow-up POST)
│   │
│   └── lib/
│       ├── sse-client.ts              — client hook: POST /api/chat, parse SSE, surface progress + answer
│       ├── sse-types.ts               — shared SSE event names/data map + formatSseEvent + ChatRequestBody
│       └── result.ts                  — Result<T,E> discriminated-union helpers
│
└── eval/
    ├── run.ts                         — full golden-suite runner (`npm run eval`): live Sonnet + LLM-judge
    ├── cases.ts                       — G1–G24 case definitions (input + expected behavior + req refs)
    ├── judge.ts                       — LLM-as-judge rubric + scoring
    ├── deterministic.ts               — exported subset for Vitest CI (G3/G11/G15/tool-efficiency)
    └── fixtures/
        └── seed-fixture-db.ts         — builds a small deterministic SQLite fixture for evals/tests
```

## Interface Definitions

Developer mode + an agentic implementer that can't ask back → **high detail at
every seam.** Types below use Result unions per the Code Conventions.

### Result type (`src/lib/result.ts`)

```ts
type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E = string> = Ok<T> | Err<E>;
```

Tool/data-layer functions return either a Result or one of the **domain-specific
structured shapes** mandated by `tools.md` (e.g. `{ found: false, suggestions }`,
`{ error: "upstream_unavailable" }`, `{ total_count: 0, results: [] }`). Those
shapes are the contract the _model_ reasons about and **take precedence** over a
generic Result at the tool boundary — do not wrap them away.

### Data-access repositories (`src/data/repos/`)

```ts
// pokedex-repo.ts
interface PokedexFilters {
  types?: string[]; // ALL listed (AND)
  abilities?: string[]; // ANY listed (OR over slot1/slot2/hidden)
  moveIds?: string[]; // ALL listed in Gen-9 (intersection via LearnsetRepo)
  statFilters?: {
    stat: StatKey;
    op: ">" | ">=" | "<" | "<=" | "==";
    value: number;
  }[];
  sortBy?: StatKey | "national_dex_number";
  order?: "asc" | "desc";
  limit?: number; // default 20, max 100
}
// Returns the T2 output shape (total_count/truncated/sort/results) OR
//   { error: "index_unavailable" } OR { unresolved: string[] } for unknown slugs.
function queryPokedex(f: PokedexFilters, ctx: DbCtx): QueryPokedexResult;
function getPokemon(slug: string, ctx: DbCtx): GetPokemonResult; // T3 shape or {found:false,suggestions}

// learnset-repo.ts — intersection done in SQL (GROUP BY … HAVING COUNT(DISTINCT)=N)
function pokemonLearningAll(
  moveIds: string[],
  versionGroups: string[],
  ctx: DbCtx,
): string[]; // pokemon ids
function gen9LearnerCount(moveId: string, ctx: DbCtx): number;

// reference-cache.ts — reads the pre-built reference_cache row for the active format
// (no upstream fetch; `upstream_unavailable` is retained in the union for a missing row)
function getReference(
  kind: RefKind,
  slug: string,
  ctx: DbCtx,
): Promise<
  | RefRecord
  | { found: false; suggestions: string[] }
  | { error: "upstream_unavailable" }
>;

// resolve-index.ts — fuzzy over searchable_names (in-memory index built at startup)
function resolveEntity(
  query: string,
  kind: EntityKind | "any",
  limit: number,
): {
  matches: {
    kind: EntityKind;
    slug: string;
    display_name: string;
    score: number;
  }[];
};
```

### Formula functions (`src/agent/formulas/`)

```ts
// Exact in-game formulas with per-step flooring (D5). Pure, no I/O.
function computeStat(p: {
  base_stat: number;
  is_hp?: boolean;
  iv?: number;
  ev?: number;
  level?: number;
  nature_effect?: "boosted" | "neutral" | "hindered";
}):
  | { value: number; breakdown: string; inputs_echo: Record<string, unknown> }
  | { error: "invalid_input"; detail: string };

function estimateDamage(p: {
  level?: number;
  power: number;
  attack_stat: number;
  defense_stat: number;
  stab?: boolean;
  type_effectiveness?: number;
  other_modifier?: number;
}):
  | {
      min_damage: number;
      max_damage: number;
      is_estimate: true;
      breakdown: string;
      inputs_echo: object;
    }
  | { error: "invalid_input"; detail: string };
```

Non-HP: `floor((floor((2*Base + IV + floor(EV/4)) * Level/100) + 5) * NatureMod)`.
HP: `floor((2*Base + IV + floor(EV/4)) * Level/100) + Level + 10` (Shedinja = 1).
Damage base: `floor(floor(floor((2*Level/5+2)*Power*A/D)/50)+2)` then `×STAB(1.5)
× type × other × roll[0.85..1.0]`; report min (0.85) and max (1.0).

### Tool layer (`src/agent/tools/`)

```ts
interface AgentContext {
  // built per request (src/agent/context.ts)
  db: DbCtx; // bound repos
  logger: Logger;
  requestId: string;
  mode: AgentMode; // "standard" | "champions" — server-controlled query scope
}
interface ToolDef {
  name: string; // matches tools.md T1–T11 names exactly
  description: string; // from tools.md "Description (for the model)"
  inputSchema: JsonSchema; // zod-to-json-schema(zodInput)
  run(args: unknown, ctx: AgentContext): Promise<unknown>; // returns the tools.md output shape
}
// index.ts exports: tools: ToolDef[]  and  dispatch(name, args, ctx): Promise<unknown>
// Tool input/output Zod schemas + the OakAnswer Zod schema live in src/agent/schemas.ts;
// the SDK tool list and submit_answer schema are DERIVED from those Zod definitions.
```

### Agent runtime (`src/agent/runtime.ts`)

```ts
type ChatMessage = { role: "user" | "assistant"; content: string }; // in-session history (DS-5)

async function runOak(
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: (e: { tool: string; label: string }) => void,
  onAnswerStart?: () => void, // submit_answer block began streaming
  onAnswerDelta?: (text: string) => void, // newly-decoded answer_markdown fragment
): Promise<OakAnswer>;
// - Builds cached prefix: system + tool defs + few-shot (a Champions-mode variant when
//   ctx.mode === "champions"); prompt-cached and byte-identical across turns.
// - Streaming loop ≤10 iterations; each tool call → onProgress(label) → dispatch → append
//   result; answer_markdown is streamed out of the submit_answer input via onAnswerStart/Delta.
// - tool_choice: "auto" + adaptive thinking (forced tool_choice + thinking = 400 on Sonnet 4.6);
//   submit_answer is driven by the system prompt + the iteration guard. Validates the payload
//   against the OakAnswer Zod schema; on failure returns the error and re-emits ≤2 times,
//   else synthesizes an insufficient_data OakAnswer.
// - Always returns a valid OakAnswer (never throws for in-domain failures); transport/API
//   errors propagate to the route as exceptions.
```

### Ingest pipeline (`src/ingest/run.ts`)

```ts
interface FormatReport {
  format: Format; // "scarlet-violet" | "champions"
  pokemon: number;
  learnsets: number;
  names: number;
  references: number;
}
interface IngestReport {
  formats: FormatReport[]; // one entry per built format
  pokemon: number; // totals across all built formats
  learnsets: number;
  names: number;
  references: number;
  startedAt: number;
  finishedAt: number;
}
async function runIngest(opts?: {
  formats?: Format[]; // default both: ["scarlet-violet", "champions"]
  onProgress?: (msg: string) => void;
}): Promise<IngestReport>;
// Build-then-swap: every format is built into in-memory arrays, then each table is replaced
// in one synchronous transaction (DELETE all + chunked INSERT). @pkmn is local, so there is
// no upstream and no reuse-last-good path — a rebuild is simply idempotent.
```

### Eval harness (`eval/`)

```ts
interface GoldenCase {
  id: string; // "G1"…"G24"
  input: string | string[]; // [] for multi-turn (e.g. G19 follow-up)
  expect: {
    // asserted against OakAnswer fields + tool trace
    status?: OakAnswer["status"];
    minCandidates?: number;
    mustCite?: string[];
    mustInclude?: string[];
    toolEfficiency?: { usedTool: string; maxPerPokemonFetches: number };
    deterministic?: boolean; // true → runs in Vitest CI subset
  };
  covers: string[]; // requirement IDs
}
function runDeterministic(
  cases: GoldenCase[],
  ctx: AgentContext,
): Promise<AssertResult[]>; // for Vitest
function runJudged(
  cases: GoldenCase[],
  ctx: AgentContext,
): Promise<JudgeResult[]>; // live Sonnet + judge
```

## Implementation Phases

8 phases, dependency-ordered. Each carries Developer-mode **Success criteria** and
**Review / test split**. Internal parallelism is noted per phase.

> **Historical — the build is complete.** The phase plan and the Build Manifest
> below are the _original_ build order and are kept for provenance. Where they name
> `src/data/pokeapi-client.ts`, a PokeAPI crawl, lazy cache warming, or
> `version_group` learnsets, see **Implementation status & drift** above for what
> shipped instead (`@pkmn` provider, offline per-format ingest, pre-built
> reference cache, `format`-keyed tables, Champions mode). A Champions-mode phase
> was added after the original eight.

### Phase 1 — Scaffolding & tooling _(flags: scaffold)_

- **Builds:** Next.js App-Router app; TS strict; ESLint/Prettier; Vitest config;
  `src/env.ts` (Zod-validated env); `package.json` scripts; `.env.example`;
  better-sqlite3 + Drizzle + Zod + `@anthropic-ai/sdk` + pino + fuse.js installed;
  `src/lib/result.ts`; `src/server/logger.ts`.
- **Depends on:** nothing.
- **Produces:** runnable dev server, green empty test suite, `typecheck`/`lint`/`build` wired.
- **Parallel:** logger and result helpers independent of app shell.
- **Test focus:** toolchain sanity — build/typecheck/lint/test all pass on an empty app.
- **Requirement refs:** none (foundation).
- **Success criteria:** `npm run build`, `npm run typecheck`, `npm run lint`,
  `npm test` all succeed; env loader rejects a missing `ANTHROPIC_API_KEY`.
- **Review / test split:** unit only (logger emits structured JSON; env loader
  validation). No external calls. Standard code review.

### Phase 2 — Store schema & data-access primitives

- **Builds:** `src/data/schema.ts` (5 tables + indexes), Drizzle migration,
  `src/data/db.ts` (connection singleton), `src/data/pokeapi-client.ts`
  (throttle + retry + User-Agent).
- **Depends on:** Phase 1.
- **Produces:** migratable SQLite schema; the sole PokeAPI client.
- **Parallel:** schema/migration vs. pokeapi-client are independent.
- **Test focus:** migration applies cleanly on an empty DB; client throttles,
  retries on 5xx/429, and returns a structured error (not a throw) when upstream
  is unreachable (mock fetch).
- **Requirement refs:** BR-8 (fair-use throttle), DS-2/3/4 schema.
- **Success criteria:** migration creates all tables + indexes on a fresh file;
  `EXPLAIN QUERY PLAN` confirms stat/type/move-slug lookups hit indexes; client
  honors a configured rate cap.
- **Review / test split:** unit (schema introspection, client behavior with mocked
  fetch — no live PokeAPI). Review gate: confirm indexes match the query patterns
  in Phase 4.

### Phase 3 — Ingest pipeline _(the largest build item)_

- **Builds:** `src/ingest/build-pokedex.ts` (D8 forms rule), `build-learnsets.ts`
  (D6 version-group filtering, egg moves excluded), `build-names.ts`,
  `warm-cache.ts` (optional), `run.ts` CLI + `ingest_meta` write + reuse-last-good.
- **Depends on:** Phase 2.
- **Produces:** a fully built `data/oak.sqlite`; `npm run ingest`.
- **Parallel:** build-pokedex / build-learnsets / build-names can be developed in
  parallel against the Phase-2 schema; orchestration in `run.ts` joins them.
- **Test focus:** transform correctness against recorded PokeAPI fixtures (no live
  crawl in tests) — Farigiraf has 3 abilities incl. `armor-tail`; Garchomp stats
  `[108,130,95,80,85,102]`, BST 600; `will-o-wisp` Gen-9 learner set non-empty;
  a known non-Gen-9 species gets `is_gen9_native=0` + `source_generation`; egg-only
  moves are absent.
- **Requirement refs:** BR-1, BR-2, BR-8, D6, D8; DS-2, DS-3.
- **Success criteria:** a real ingest run populates ~1300 `pokemon` rows + tens of
  thousands of `learnset` rows; re-running is idempotent (same counts);
  simulating an upstream failure mid-build leaves the prior DB intact and sets
  `reusedLastGood=true`.
- **Review / test split:** unit (transform fns on fixtures) + one **integration**
  test doing a _small_ real crawl (a handful of species) behind a `LIVE_INGEST`
  env flag, excluded from CI. Review gate: verify the forms-collapse rule and the
  Gen-9 version-group list.

### Phase 4 — Tool layer + formulas _(flags: ai)_

- **Builds:** repos (`pokedex-repo`, `learnset-repo`, `reference-cache`,
  `resolve-index`), formulas (`compute-stat`, `estimate-damage`),
  `src/agent/schemas.ts` (Zod + JSON-Schema exports), all 11 tools in
  `src/agent/tools/`, `src/agent/context.ts`.
- **Depends on:** Phase 3 (tools read the built index) — formulas depend only on Phase 1.
- **Produces:** `tools: ToolDef[]`, `dispatch()`, `AgentContext`.
- **Parallel:** formulas + their two tools are independent of the DB repos; among
  repos, pokedex/learnset/reference/resolve are independent once the schema exists;
  reference-cache-backed tools (get_move/ability/type/evolution/item) are mutually
  independent.
- **Test focus:** **the deterministic heart of the system.** `compute_stat`
  Garchomp Speed → **169** (G15); `estimate_damage` returns min<max + `is_estimate`
  (G16); `query_pokedex` multi-move intersection over a fixture (G1), combined
  type+ability+move filter (G5), `sort_by=speed desc` (G6), `attack>130` threshold
  (G7); `get_type_matchups(["ground"])` reports Flying as **immune** 0× (G11);
  `resolve_entity("Will-o-Whisp")` → `will-o-wisp` top match (G3); structured
  errors (`index_unavailable`, `unresolved`, `found:false`) returned, never thrown.
- **Requirement refs:** US-1/2/3/4/6/7/8, AC-1.x/2.x/3.x/6.1/9.x, BR-2/5/6/7/9, D5/D6.
- **Success criteria:** every G-case that is tool-assertable passes against the
  fixture DB without any LLM call; JSON Schemas derived from Zod validate the
  sample payloads in `tools.md`/`output-formats.md`.
- **Review / test split:** unit-heavy, all against the **fixture DB** (real SQLite,
  no live PokeAPI, no LLM). reference-cache miss path tested with a mocked client.
  Review gate: confirm tool output shapes match `tools.md` byte-for-byte (the model
  depends on them) and that no tool throws.

### Phase 5 — Agent runtime _(flags: ai)_

- **Builds:** `src/agent/prompts/system.ts` + `few-shot.ts` (transcribed from
  `prompts.md` — content not authored here), `src/agent/runtime.ts` (`runOak`),
  OakAnswer Zod validation + retry, prompt-cache prefix, per-turn log trace.
- **Depends on:** Phase 4.
- **Produces:** `runOak(message, history, ctx, onProgress)`.
- **Parallel:** prompt transcription vs. loop wiring can proceed in parallel, joined at the loop.
- **Test focus:** loop terminates on forced `submit_answer`; max-iteration guard
  synthesizes `insufficient_data`; invalid `submit_answer` triggers ≤2 re-emits
  then falls back; `onProgress` fires per tool call; multi-turn refinement (G19)
  reads prior history; conditional Farigiraf answer carries an `inferences[]` entry
  (G4). Uses a **stubbed/recorded** Anthropic client for determinism.
- **Requirement refs:** US-7/10/12/13, AC-7.x/10.x/12.x, BR-1/3/4; D2/D10; integration.md.
- **Success criteria:** given recorded tool-call transcripts, `runOak` always
  returns a schema-valid `OakAnswer`; the assembled log trace contains every
  field `integration.md` requires.
- **Review / test split:** integration tests with a **mocked Anthropic client**
  (recorded tool-loop transcripts) + the real tool layer/fixture DB. Live-Sonnet
  behavior is covered by the eval harness (Phase 8), not here. Review gate: verify
  `tool_choice` forces `submit_answer` and the retry/fallback path.

### Phase 6 — Web API + session

- **Builds:** `src/app/api/chat/route.ts` (SSE), `src/server/session-store.ts`,
  `src/server/rate-limit.ts` (input cap + per-session limit).
- **Depends on:** Phase 5.
- **Produces:** the live `POST /api/chat` SSE endpoint.
- **Parallel:** session store + rate limiter independent of the route, joined in the handler.
- **Test focus:** SSE emits `tool_activity`\* then exactly one `answer`; in-domain
  failures arrive as an `answer` with the right `status` (not an `error` event);
  transport faults emit `error`; oversized input is rejected; per-session rate
  limit bounds runaway loops; history is threaded across turns in one session.
- **Requirement refs:** US-10, integration.md (invocation + error surface + guardrails), BR-8.
- **Success criteria:** an end-to-end request against the fixture DB streams a valid
  `OakAnswer` for G1 and G4; reload drops session memory (D9).
- **Review / test split:** integration (route handler + session store + mocked
  runtime). **Security-lite review gate:** input cap + rate limit present;
  confirm no `ANTHROPIC_API_KEY` leakage into responses/logs.

### Phase 7 — Frontend renderer _(flags: ui)_

- **Builds:** chat shell (`page.tsx`, `ChatThread`, `Composer`), the full
  `AnswerCard` tree, `src/lib/sse-client.ts`, progress UI.
- **Depends on:** Phase 6.
- **Produces:** the usable chat UI (structure; visuals later).
- **Parallel:** the leaf components (SpriteCard, TypeBadge, CandidateTable,
  SourceList, InferenceCallout, CaveatStrip, DamageReadout, SuggestionChips) are
  independent and parallelizable once `AnswerCard` defines its props.
- **Test focus:** each `OakAnswer` field renders to its mapped component
  (`output-formats.md` consumer table); truncated candidates show "N of M";
  fallback/uncertainty render the caveat strip; suggestion-chip click POSTs a
  follow-up with the same `session_id`; SSE hook surfaces progress then the answer.
- **Requirement refs:** US-4/11/12/13, AC-4.1/11.x/12.x, ux-design.md, output-formats.md.
- **Success criteria:** rendering each canonical example payload from
  `output-formats.md` produces the expected component tree (component tests); the
  app streams and renders a real answer end-to-end. **Type-color palette + visual
  polish are explicitly deferred to the `frontend-design` skill.**
- **Review / test split:** component tests (Vitest + jsdom/Testing Library) against
  fixture payloads + one E2E smoke. UI review gate; defer visual-design review to
  the `frontend-design` pass.

### Phase 8 — Eval harness & integration

- **Builds:** `eval/cases.ts` (G1–G24), `eval/run.ts` (judged runner),
  `eval/judge.ts` (LLM-judge rubric), `eval/deterministic.ts` (CI subset),
  `eval/fixtures/seed-fixture-db.ts`; CI wiring.
- **Depends on:** Phase 5 (judged suite needs the runtime); Phase 7 (full E2E).
- **Produces:** `npm run eval` + the Vitest-wired deterministic subset.
- **Parallel:** fixture builder, case definitions, and judge rubric are independent.
- **Test focus:** the deterministic subset (G3 suggestion, G11 immunity, G15 = 169,
  tool-efficiency asserts) runs green in CI; the judged suite scores G1–G24 with
  the rubric; tool-efficiency metric asserts `query_pokedex` is used and
  per-Pokémon fetches stay ≤ a small constant on G1/G5/G6/G8.
- **Requirement refs:** all (the eval suite is the cross-cutting acceptance check);
  evaluation.md G1–G24.
- **Success criteria:** CI subset passes deterministically; a full `npm run eval`
  run produces a scored report; index-rebuild regression set (G1/G5/G6/G7/G17)
  is runnable on demand.
- **Review / test split:** the harness _is_ the test asset. Deterministic subset →
  CI on every PR; full LLM-judge suite → nightly/release (not PR-blocking). Review
  gate: confirm CI subset is genuinely deterministic (no live Sonnet in the PR path).

### Integration checkpoints

- **After Phase 3 — `ingest-produces-valid-index`:** a real ingest yields the
  expected row counts and spot-check rows (Farigiraf abilities, Garchomp stats,
  non-empty Gen-9 `will-o-wisp` learner set, a flagged non-Gen-9 fallback row).
- **After Phase 6 — `backend-stack-e2e`:** `POST /api/chat` streams a valid
  `OakAnswer` for G1 (intersection) and G4 (conditional/inference) against the
  real fixture DB — backend proven before any frontend work.
- **After Phase 7 — `full-stack-e2e`:** the browser renders an `AnswerCard` from a
  live SSE stream, including sprites, candidate table, citations, and an inference
  callout.

## Build Manifest

```yaml
commands:
  test: "vitest run"
  test_one: "vitest run {file}"
  typecheck: "tsc --noEmit"
  build: "next build"
  lint: "eslint ."
  ingest: "tsx src/ingest/run.ts"
  eval: "tsx eval/run.ts"
phases:
  - id: p1
    name: Scaffolding & tooling
    depends_on: []
    owns:
      [
        "package.json",
        "next.config.ts",
        "tsconfig.json",
        "vitest.config.ts",
        "drizzle.config.ts",
        ".eslintrc.cjs",
        ".prettierrc",
        ".env.example",
        "src/env.ts",
        "src/lib/result.ts",
        "src/server/logger.ts",
      ]
    shared: []
    requirement_refs: []
    test_focus: "toolchain sanity: build/typecheck/lint/test green on empty app"
    flags: [scaffold]
  - id: p2
    name: Store schema & data-access primitives
    depends_on: [p1]
    owns:
      [
        "src/data/schema.ts",
        "src/data/db.ts",
        "src/data/pokeapi-client.ts",
        "drizzle/**",
      ]
    shared: []
    requirement_refs: [BR-8]
    test_focus: "migration applies; indexes hit; client throttles/retries; structured errors"
  - id: p3
    name: Ingest pipeline
    depends_on: [p2]
    owns: ["src/ingest/**"]
    shared: ["data/oak.sqlite"]
    requirement_refs: [BR-1, BR-2, BR-8]
    test_focus: "DS-2/DS-3 transforms on fixtures; forms (D8); gen-9 learnsets (D6); reuse-last-good"
  - id: p4
    name: Tool layer + formulas
    depends_on: [p3]
    owns:
      [
        "src/data/repos/**",
        "src/agent/formulas/**",
        "src/agent/tools/**",
        "src/agent/schemas.ts",
        "src/agent/context.ts",
      ]
    shared: []
    requirement_refs:
      [
        US-1,
        US-2,
        US-3,
        US-4,
        US-6,
        US-7,
        US-8,
        AC-1.1,
        AC-1.2,
        AC-1.3,
        AC-2.1,
        AC-2.2,
        AC-3.1,
        AC-3.2,
        AC-3.3,
        AC-6.1,
        AC-9.1,
        AC-9.2,
        BR-2,
        BR-5,
        BR-6,
        BR-7,
        BR-9,
      ]
    test_focus: "compute_stat=169; damage range; pokedex filters/intersection; immunity; resolve; structured errors"
    flags: [ai]
  - id: p5
    name: Agent runtime
    depends_on: [p4]
    owns: ["src/agent/runtime.ts", "src/agent/prompts/**"]
    shared: []
    requirement_refs:
      [
        US-7,
        US-10,
        US-12,
        US-13,
        AC-7.1,
        AC-7.2,
        AC-7.3,
        AC-10.1,
        AC-10.2,
        AC-12.1,
        AC-12.2,
        BR-1,
        BR-3,
        BR-4,
      ]
    test_focus: "forced submit_answer; max-iter fallback; validate+retry; onProgress; multi-turn"
    flags: [ai]
  - id: p6
    name: Web API + session
    depends_on: [p5]
    owns:
      [
        "src/app/api/chat/route.ts",
        "src/server/session-store.ts",
        "src/server/rate-limit.ts",
      ]
    shared: []
    requirement_refs: [US-10, BR-8]
    test_focus: "SSE order; in-domain failure as answer not error; input cap; rate limit; session history"
  - id: p7
    name: Frontend renderer
    depends_on: [p6]
    owns:
      [
        "src/app/layout.tsx",
        "src/app/page.tsx",
        "src/components/**",
        "src/lib/sse-client.ts",
      ]
    shared: []
    requirement_refs:
      [US-4, US-11, US-12, US-13, AC-4.1, AC-11.1, AC-11.2, AC-12.1, AC-12.2]
    test_focus: "field→component mapping; N-of-M truncation; caveat strip; chip follow-up; SSE hook"
    flags: [ui]
  - id: p8
    name: Eval harness & integration
    depends_on: [p5, p7]
    owns: ["eval/**"]
    shared: []
    requirement_refs: [US-1, US-7, BR-1, BR-3, BR-4, BR-6, BR-7]
    test_focus: "deterministic CI subset (G3/G11/G15/efficiency); judged G1-G24; rebuild regression set"
integration_checkpoints:
  - after: [p3]
    name: ingest-produces-valid-index
    verifies: "real ingest yields expected counts + spot-check rows (Farigiraf, Garchomp, will-o-wisp learners, a fallback row)"
  - after: [p6]
    name: backend-stack-e2e
    verifies: "POST /api/chat streams a valid OakAnswer for G1 + G4 against the real fixture DB"
  - after: [p7]
    name: full-stack-e2e
    verifies: "browser renders an AnswerCard from a live SSE stream (sprites, table, citations, inference callout)"
```

## Technical Decisions

| #   | Decision                                                             | Alternatives                                                      | Why / tradeoff                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **TypeScript / Next.js monolith**                                    | TS frontend + Express/Vite split; Python backend + React frontend | One language, one deploy; matches the TS `runOak` signature + React component map in agent-design. Tradeoff: ingest data-munging is slightly less ergonomic than Python — accepted, the corpus is small and the type-sharing win is larger.                                                             |
| A2  | **SQLite (better-sqlite3) on disk**                                  | in-memory + JSON snapshots; DuckDB                                | `query_pokedex` needs indexed filter/sort/threshold over ~1300 rows + a tens-of-thousands-row learnset join, and the reference cache must persist across restarts. SQLite gives all three for free. Tradeoff: a file dependency vs. pure in-memory — accepted for the query power and no re-ingest on boot. |
| A3  | **Drizzle ORM**                                                      | raw better-sqlite3 SQL; Kysely                                    | Typed schema + queries + lightweight migrations the tools and tests lean on. Tradeoff: a thin abstraction over SQL — accepted; dynamic `query_pokedex` filters still assemble cleanly.                                                                                                                      |
| A4  | **SSE** for `/api/chat`                                              | WebSocket                                                         | One-directional progress→answer fits SSE exactly; trivial in a Next.js route; client only POSTs discrete turns. Tradeoff: no server-push beyond the active request — not needed.                                                                                                                            |
| A5  | **Zod single source of truth** (+ zod-to-json-schema)                | hand-written JSON Schema + Ajv; Valibot                           | One definition drives runtime validation, TS types, and the Anthropic tool / `submit_answer` schemas — no drift from `output-formats.md`. Tradeoff: the JSON Schemas are _generated_, so a review gate confirms they match the agent-design samples.                                                        |
| A6  | **Result unions in the tool/data layer; exceptions at the web edge** | exceptions everywhere; Result everywhere                          | agent-design _requires_ tools return structured, model-readable errors (never throw); the HTTP edge stays idiomatic Next.js (try/catch → error mapping). Tradeoff: two error styles in one codebase — bounded cleanly at the runtime/route seam.                                                            |
| A7  | **pino → stdout, no vendor**                                         | logs-as-a-service tier; + Sentry                                  | Single user, hobby tier — stdout structured logs carry the full per-turn trace and double as the eval/prod-sampling source. Tradeoff: no retained/queryable history or alerting — acceptable now; ladder-up path noted below.                                                                               |
| A8  | **Vitest + split eval harness**                                      | all evals in Vitest; Jest                                         | Deterministic subset in CI keeps PRs fast/cheap/stable; the live-Sonnet LLM-judge suite runs nightly/on release per `evaluation.md`. Tradeoff: a second runner script (`eval/run.ts`) outside Vitest — intentional, keeps nondeterminism out of CI.                                                         |
| A9  | **No vector store; `resolve_entity` is fuzzy string matching**       | embed names into pgvector/sqlite-vss                              | There is no RAG; resolution is name→slug over a known finite set. An in-memory fuzzy index is simpler, faster, and free. Tradeoff: none meaningful at this corpus size.                                                                                                                                     |
| A10 | **Ingest is a manual/scheduled CLI, not a queue**                    | in-process worker; managed queue                                  | The corpus is static between rebuilds; `npm run ingest` (optionally cron'd weekly/on deploy) is sufficient. The reference detail is pre-built at ingest, so there are no runtime cache misses to service. Tradeoff: no async job system — none needed.                                                                                  |

## Deployment & Infrastructure

**Budget tier: hobby / prototype.** Single user, mostly-free footprint; the only
guaranteed cost is Anthropic API tokens.

**Runnable commands (source of truth; mirrored in the Build Manifest):**

- `test`: `vitest run` · `test_one`: `vitest run {file}` · `typecheck`: `tsc --noEmit`
- `build`: `next build` · `lint`: `eslint .`
- `ingest`: `tsx src/ingest/run.ts` (alias `npm run ingest`)
- `eval`: `tsx eval/run.ts` (alias `npm run eval`)

| Concern                     | Choice                                                                                                   | Why this fits hobby tier                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hosting / runtime**       | Run locally (`next start`) or a single small VM / one PaaS instance (Fly.io / Railway free-ish).         | One user; no need for autoscale or a container platform. SQLite wants a persistent local disk → a single long-lived instance (not multi-instance serverless). |
| **Database hosting**        | **Embedded SQLite file** (`data/oak.sqlite`) on the instance disk.                                   | No DB service to run or pay for; the corpus is a few MB. Built by `npm run ingest`.                                                                           |
| **Background jobs / queue** | **None.** Ingest is a manual/scheduled CLI; reference detail is pre-built (no runtime fetches).            | No async workload requires a queue (A10).                                                                                                                     |
| **Object storage**          | **None.** Sprites are PokeAPI URLs rendered directly by the frontend.                                    | No assets to host.                                                                                                                                            |
| **Caching**                 | The reference cache **is** SQLite (DS-4); resolve index in memory.                                       | No Redis/managed cache needed for one user.                                                                                                                   |
| **Observability**           | **pino structured JSON → stdout** (the platform's log viewer). Full per-turn trace per `integration.md`. | Free; doubles as the eval/prod-sampling source (A7).                                                                                                          |
| **Secrets**                 | `ANTHROPIC_API_KEY` via host env / `.env.local` (gitignored); platform secret store if hosted.           | One key, single user — a secrets manager is overkill.                                                                                                         |
| **Environments**            | **Just-prod** (your machine or one instance).                                                            | Single-user personal tool; staging would be ceremony.                                                                                                         |

**Agent infra ladder (rungs picked, per `agent-features.md`):**

- _Vector store_ — **none** (A9; no RAG). Step up only if semantic search is added later.
- _Background queue_ — **none** (A10; in-process/CLI). Step up to `pg-boss`/managed Redis only if ingest grows heavy or goes async.
- _Observability_ — **stdout pino** (cheapest rung). Step up to Axiom/Better Stack (~$0–20/mo) only if you want retained, searchable logs.
- _Secrets_ — **host env vars** (cheapest rung). Step up to a platform secret store when hosted.
- _LLM spend_ — **Sonnet 4.6** (fixed by agent-design D2), with the **prompt-cached prefix** (system + tools + few-shot) to cut per-turn input cost; single-user volume keeps spend low. Opus upgrade is eval-gated (agent-design).

**Rough monthly cost estimate: ~$0 infra + LLM tokens (low — single user).** Self-hosted or local = $0; a small always-on PaaS instance would be ~$5–10/mo. Anthropic token spend scales with your own usage (a handful of Sonnet turns/day is dollars/month). This sits squarely in the hobby tier.

## Code Conventions

_(Developer mode. Where this pass ran without a separate dev team in the room,
choices the owner confirmed via the design questions are recorded as decided; any
remaining code-level defaults are marked **Proposed — confirm** and listed under
Unresolved.)_

- **Language / module style:** TypeScript `strict`; ESM; path alias `@/` → `src/`.
  One default-or-named export per file matching its filename purpose.
- **Naming:** files kebab-case (`query-pokedex.ts`); types/components PascalCase;
  functions/vars camelCase; DB columns snake_case (Drizzle maps to camelCase in TS).
  Tool **names** and tool **output field names** match `tools.md` / `output-formats.md`
  exactly — the model depends on them; never rename.
- **Module boundaries:** repos are the sole SQLite readers; tools call repos;
  `runtime.ts` only knows the tool layer (`ToolDef[]`/`dispatch`), not repos.
  `src/data/pkmn/gen-provider.ts` is the _only_ file that touches `@pkmn`, and only
  the ingest pipeline imports it — runtime/tools never do (they read the built
  index). (There is no PokeAPI client; BR-8 is moot — nothing calls upstream.)
- **Error handling (A6):** tool/data-layer functions return Result unions or the
  domain-specific structured shapes from `tools.md` (`{found:false,suggestions}`,
  `{error:"upstream_unavailable"}`, `{error:"index_unavailable"}`, `{unresolved:[…]}`)
  and **never throw** for in-domain conditions. The route handler uses try/catch →
  maps to a `OakAnswer` status (in-domain) or an `error` SSE event / HTTP 5xx
  (transport) per `integration.md`. `runOak` never throws for in-domain failure.
- **Validation (A5):** Zod schemas in `src/agent/schemas.ts` are the single source;
  TS types are inferred from them and the Anthropic tool / `submit_answer` JSON
  Schemas are generated via `zod-to-json-schema`. No hand-maintained duplicate of
  the `output-formats.md` JSON Schema.
- **Logging (A7):** pino, JSON to stdout. **Required fields on every turn log:**
  `request_id`, `session_id`, `model`, `input_tokens`, `output_tokens`,
  `thinking_tokens`, `tool_trace[]` (tool, args, latency_ms, cache_hit, error),
  `turn_latency_ms`, `status`, `citation_count` (the `integration.md` set). No
  secrets or full user PII (none exists) in logs.
- **Concurrency / transactions:** better-sqlite3 is synchronous; ingest builds all
  formats in memory, then replaces each table in one transaction (DELETE all +
  chunked INSERT) — idempotent, no reuse-last-good path (`@pkmn` is local, so a
  failed build just re-runs). Read paths need no transactions. No cross-request
  shared mutable state except the in-memory session store and resolve index.
- **Frontend state (Proposed — confirm):** local React state + a small `useReducer`
  (or a tiny Zustand store) for the chat thread; **no** React Query/SWR (the single
  streaming POST is handled by the `sse-client` hook). Rationale: server-state libs
  add little for one streaming endpoint with no cache-invalidation needs.
- **Lint/format:** ESLint (typescript-eslint recommended) + Prettier; CI runs
  `lint` + `typecheck`. Bundler/lockfile/plugin-version choices left to the builder.

## Testing Strategy

- **Framework:** Vitest (node project for backend; jsdom project for components).
- **Unit vs integration split:**
  - _Unit_ — formulas (`compute_stat`/`estimate_damage`), repo query builders,
    ingest transforms, Zod schemas, logger, resolve fuzzy ranking.
  - _Integration_ — repos against a **real fixture SQLite DB**; `runOak` against
    a **mocked Anthropic client** (recorded tool-loop transcripts) + the real tool
    layer; the `/api/chat` route + session store with a mocked runtime; component
    tests rendering canonical `OakAnswer` payloads.
- **Mocking policy — what's real vs faked:**
  - _Real:_ SQLite (fixture DB), the tool layer, formulas, Zod validation.
  - _Faked in unit/integration:_ the Anthropic API (mocked client with recorded
    transcripts). `@pkmn` is local and deterministic, so ingest transforms are
    tested directly against it — there is no network layer to mock.
  - _Live:_ only the **judged eval suite** (`npm run eval`) hits real Sonnet, and
    it is excluded from the PR path. Ingest itself is offline (no live crawl).
- **Eval harness wiring (A8, `evaluation.md`):** `eval/cases.ts` defines G1–G24.
  `eval/deterministic.ts` exports the deterministically-checkable subset (G3
  suggestion, G11 immunity, G15 = 169, tool-efficiency asserts) which is imported
  into a Vitest test so it runs on every PR. `eval/run.ts` runs the full LLM-judge
  suite nightly/on release (not PR-blocking). The index-rebuild regression set
  (G1/G5/G6/G7/G17) is runnable on demand after each ingest.
- **Fixtures:** `eval/fixtures/seed-fixture-db.ts` builds a small, deterministic
  SQLite DB (a curated set incl. Garchomp, Farigiraf, a Fire/Flash-Fire mon, a
  non-Gen-9 fallback species, Tauros forms) used by both eval and integration tests.
- **Coverage target (Proposed — confirm):** ~90%+ on the deterministic core
  (formulas, repos, ingest transforms, schema validation); the agent loop and UI
  are covered behaviorally (transcript/payload tests + the eval suite) rather than
  by a line-coverage number.
- **CI gate:** `typecheck` + `lint` + `vitest run` (unit + integration + the
  deterministic eval subset) must pass on every PR; full judged eval runs nightly.

## Unresolved from Requirements

**Resolved by agent-design (carried in as fixed constraints, no longer open):**

- _Damage-calc defaults_ → agent-design D7 (lvl 50, 31 IV, 0 EV, neutral nature, no
  weather/items unless named; always state assumptions + estimate flag).
- _Forms & regional variants_ → D8 (each battle-relevant form is a distinct indexed
  row; agent disambiguates).
- _Chat history persistence_ → D9 (in-session memory only; no DB).

**Resolved by this architecture pass:**

- _Data freshness flagging_ → the ingest cadence is manual/scheduled; PokeAPI lag is
  acceptable (`data-sources.md`), and `ingest_meta.last_success_at` is available to
  surface staleness if desired later. The generation-fallback flag (BR-1) is already
  handled in the answer schema.
- _Latency target_ → "a few seconds" accepted; the prompt-cached prefix + local
  index keep compound queries interactive; no firm SLO set (single user).

**Code-level defaults marked “Proposed — confirm with dev team”** (architect ran
without a separate dev team; keep or override before `dev-team` picks this up):

1. Frontend state = local React + small reducer/Zustand, **no** React Query/SWR.
2. Test coverage posture (~90% on deterministic core; behavioral coverage for loop/UI).
3. Fuzzy library for `resolve_entity` (`fuse.js` vs `fastest-levenshtein`) — either fits.
4. Ingest scheduling (manual `npm run ingest` vs a weekly cron / on-deploy hook).

**Still genuinely open (need the owner's call at some point, not blocking the build):**

- How interactive damage-calc should be when inputs are missing — D7 says "compute
  with defaults + invite refinement"; whether to ever _ask back_ first is a prompt-
  level tuning question owned by agent-design, not this pass.

```

```
