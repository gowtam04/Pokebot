# Artifact Viewer — Technical Design

## Overview
Mode: PM
Budget Tier: hobby

A docked side panel (full-screen overlay on mobile) that opens a structured output or a
clicked entity as a first-class, on-screen object while the chat stays usable. Two artifact
sources, with a clean split:

- **Entity-detail artifacts** (Pokémon / move / ability / item / type) — a **full profile**
  fetched on click from a **new server-side read endpoint** (`GET /api/entity`) that
  resolves the name→slug and composes the existing repo reads. This is the only part that
  touches a new data path.
- **Structured-view artifacts** (damage-calc breakdown, comparison) — **derived from the
  `PokebotAnswer` payload already in the committed turn** via a per-section "open in viewer"
  button. No fetch.

The viewer shows **one artifact at a time** with a **back stack** (mini-browser): entity
clicks, per-section buttons, and nested-entity drill-downs push; back pops; close clears.
Everything is **ephemeral / in-memory** (no persistence, no new infra). The endpoint reuses
the existing Postgres index through the **repo layer**, leaving the agent's fixed 11-tool
contract untouched.

Key consequences of the requirements, realized here:
- "Type-grid" and the "type" entity-detail artifact are **the same artifact**
  (`TypeMatchupsDetail`) — one renderer, reachable by clicking a type badge or drilling in.
- "Team sheet" is **deferred to backlog B-2** (no team data model exists yet) — see
  Technical Decisions.

## Requirements Reference
- Business requirements: `docs/features/artifact-viewer/requirements/requirements.md`
  (AV-US-1..11, BR-AV-1..10, AC-*, NFR-1..5).
- Backlog context: `docs/backlog.md` (B-4, and B-6 which this absorbs).
- No `agent-design/` doc governs this feature — it's a UI + data-fetch concern. The agent's
  internals (`docs/agent-design/`) are **inputs/constraints**, not things this redesigns.

## Tech Stack
No new technology. Existing stack: TypeScript (strict, ESM, `@/`→`src/`), Next.js App
Router, node-postgres + Drizzle, Zod (single source of truth for schemas/types), Vitest
(node + jsdom projects). Frontend styling is **BEM class names + CSS custom-property tokens**
in `globals.css` (no Tailwind, no CSS modules). One new client-side concept: a React
**context** for viewer state. No new npm packages.

## Data Model
**No schema changes, no migrations.** The feature is read-only over existing format-scoped
tables: `pokemon`, `learnset` (has a `method` column: level-up / machine / tutor),
`reference_cache` (move/ability/type/evolution/item payloads), `searchable_names` (backs
`resolveEntity`). All reads honor the per-format `format` column.

**New repo reads** (no new tables; just queries the current schema can already answer):

| Read | File | Returns |
| --- | --- | --- |
| `movesForPokemon(pokemonId, format, db)` | `learnset-repo.ts` | `{ moveSlug, method }[]` for one Pokémon |
| `pokemonWithAbility(abilitySlug, format, db)` | `pokedex-repo.ts` | `{ slug, displayName }[]` species having that ability (matches `ability_slot1/2/hidden`) |
| `moveSummaries(moveSlugs, format, db)` | `reference-cache.ts` | `Map<slug, { displayName, type }>` — one batched read to hydrate movepool type badges |

## Component Design

### Backend

- **`src/data/entity-profile.ts`** *(new, `server-only`)* — the profile assembler. Single
  entry `assembleEntityProfile(kind, slug, format, db)`; composes existing repo reads into
  one full-profile object per entity kind, builds the grounding (`citations[]`, format/gen
  tag, fallback flag), and returns a result union (`ok` / `not_found` / `unavailable`). Owns
  all cross-repo composition; the route stays thin.
- **`src/app/api/entity/route.ts`** *(new)* — `GET` handler. Validates query params (Zod),
  calls `resolveEntity` (name/slug → canonical slug), then `assembleEntityProfile`, and maps
  the result to the HTTP envelope. `runtime = "nodejs"`, `dynamic = "force-dynamic"`. No
  auth gate (public Pokédex data; works for guests). Never throws for in-domain misses —
  returns `not_found` / `unavailable` envelopes (mirrors the tool-layer seam).
- **`src/agent/formulas/type-chart.ts`** *(new, pure)* — the dual-type defensive
  combination logic **extracted** from `get-type-matchups.ts` so both the tool and the
  assembler call one implementation (no reimplementation of mechanics). `get-type-matchups.ts`
  is refactored to consume it (behavior-preserving; guarded by its existing tests).

### Shared contract

- **`src/lib/entity-artifact.ts`** *(new, client-safe — pure Zod + inferred types)* — the
  `EntityArtifactResponse` envelope and per-kind data shapes, composed from the existing
  entity Zod types in `@/agent/schemas` (`PokemonProfile`, `MoveDetail`, `AbilityDetail`,
  `TypeMatchupsDetail`, `ItemDetail`, `EvolutionChainDetail`, `citationSchema`). Imported by
  **both** the route (server) and the viewer (client) so there's one contract. Must not
  import anything `server-only`.

### Frontend

- **`ArtifactViewerProvider` + `useArtifactViewer()`** *(new)* — React context holding the
  viewer state machine: the `stack` (history), derived `current`, `isOpen`, `isLoading`,
  `error`. Exposes `openEntity`, `openStructured`, `back`, `close`. `openEntity` fetches
  `/api/entity`; structured opens carry their payload inline (no fetch). Default context
  value is **no-ops**, so existing leaf components still render in isolation tests without a
  provider. Also receives `onAskInChat(message)` from the page.
- **`ArtifactViewer`** *(new)* — the panel shell: header (title, format/generation tag,
  back, close, "ask about this in chat"), loading/`not_found`/`unavailable` states, and a
  dispatch to the right renderer by artifact type. Hidden when `!isOpen`.
- **Per-kind renderers** *(new, parallelizable)* — `PokemonArtifact`, `MoveArtifact`,
  `AbilityArtifact`, `ItemArtifact`, `TypeMatchupsArtifact` (also the "type-grid"),
  `ComparisonArtifact` (payload-derived), `DamageCalcArtifact` (payload-derived; reuses
  `DamageReadout`). A shared `ArtifactSources` reuses `SourceList` styling for grounding.
- **Modified existing leaves** — `SpriteCard`, `TypeBadge`, `CandidateTable` rows,
  `SourceList` citations become clickable via `useArtifactViewer()`. `AnswerCard` gains
  per-section "open in viewer" buttons (damage-calc, comparison). `page.tsx` mounts the
  provider + panel and lifts the composer draft for pre-fill. `Composer` accepts a
  controlled draft value.

## API Design

### `GET /api/entity`

Fetches a full entity profile for the active format. One endpoint, kind-discriminated.

**Query params**
| Param | Type | Notes |
| --- | --- | --- |
| `kind` | `"pokemon" \| "move" \| "ability" \| "item" \| "type"` | Always known at the click site (sprite→pokemon, badge→type, citation `kind/slug`→kind). |
| `q` | string | A display name (`"Charizard"`, `"Mr. Mime"`) **or** a canonical slug (`"armor-tail"`). Resolved server-side. |
| `format` | `"scarlet-violet" \| "champions"` | **Required** — passed explicitly (snapshot at open; BR-AV-7). Frontend derives it from the Champions toggle at click time. |

**Response — `EntityArtifactResponse`** (200 in all in-domain cases; `4xx` only for malformed params):
```ts
type EntityArtifactResponse =
  | { status: "ok"; kind: EntityKind; format: Format;
      resolved: { slug: string; display_name: string };
      generation: string; is_fallback: boolean; fallback_note?: string;
      citations: Citation[];           // reuses citationSchema { source, detail, endpoint_url? }
      data: EntityArtifactData }       // discriminated by kind, see Interface Definitions
  | { status: "not_found"; kind: EntityKind; format: Format; query: string; suggestions: string[] }
  | { status: "unavailable"; kind: EntityKind; format: Format };
```

**Behavior**
- `resolveEntity(q, kind, 5, format)`; no match → `not_found` with `suggestions` (top display
  names). Exact slugs (from citations) match at score 1 — same path, no special-casing.
- Repo read returns `index_unavailable` → `unavailable`. Repo `found:false` → `not_found`.
- The route reads the `@/data/db` singleton and passes the handle to the repos. (Note:
  `resolveEntity` reads the singleton internally — see Testing.)

**Auth / limits:** none. Cheap local read; single-user. (If abuse ever matters, the existing
per-IP limiter can be reused — out of scope now.)

## File Structure
```
src/
├── lib/
│   └── entity-artifact.ts              — NEW. Zod + types for EntityArtifactResponse and per-kind
│                                          data; composed from @/agent/schemas entity types. Client-safe.
├── data/
│   ├── entity-profile.ts               — NEW (server-only). assembleEntityProfile(kind, slug, format, db):
│   │                                      composes getPokemon + getReference + new reads + grounding into
│   │                                      one profile; returns ok/not_found/unavailable.
│   └── repos/
│       ├── learnset-repo.ts            — MODIFY. + movesForPokemon(pokemonId, format, db)
│       ├── pokedex-repo.ts             — MODIFY. + pokemonWithAbility(abilitySlug, format, db)
│       └── reference-cache.ts          — MODIFY. + moveSummaries(moveSlugs, format, db) (batched)
├── agent/
│   ├── formulas/
│   │   └── type-chart.ts               — NEW (pure). combineDefensiveMatchups(...) extracted from the tool.
│   └── tools/
│       └── get-type-matchups.ts        — MODIFY. Refactor to call type-chart.ts (behavior-preserving).
├── app/
│   ├── api/entity/
│   │   └── route.ts                    — NEW. GET handler: validate → resolveEntity → assemble → envelope.
│   └── page.tsx                        — MODIFY. Mount ArtifactViewerProvider + ArtifactViewer in
│                                          chat-page__body; lift composer draft for pre-fill; wire onAskInChat.
└── components/
    ├── Composer.tsx                    — MODIFY. Accept controlled draft value + onChange (for pre-fill).
    ├── AnswerCard.tsx                  — MODIFY. Per-section "open in viewer" buttons (damage, comparison).
    ├── SpriteCard.tsx                  — MODIFY. Clickable → openEntity("pokemon", subject.name).
    ├── TypeBadge.tsx                   — MODIFY. Optional clickable → openEntity("type", type).
    ├── CandidateTable.tsx              — MODIFY. Row name → openEntity("pokemon", name) (alongside onSelect).
    ├── SourceList.tsx                  — MODIFY. Citation click → openEntity(parse(source)); keep ↗ link.
    ├── types.ts                        — MODIFY. Re-export artifact prop types (single owner: Phase 5).
    └── artifact/                       — NEW directory
        ├── ArtifactViewerProvider.tsx  — Context + state machine (stack/current/isOpen/isLoading/error) + fetch.
        ├── useArtifactViewer.ts        — Hook returning the context API (no-op default).
        ├── ArtifactViewer.tsx          — Panel shell: header, back/close/ask, status states, renderer dispatch.
        ├── ArtifactSources.tsx         — Shared grounding (format/gen tag + SourceList-style citations + caveats).
        ├── PokemonArtifact.tsx         — Full profile: stats, abilities+effects, movepool (grouped+clickable),
        │                                  type matchups, evolution.
        ├── MoveArtifact.tsx            — MoveDetail (+ learner count).
        ├── AbilityArtifact.tsx         — AbilityDetail + learned-by (clickable species list).
        ├── ItemArtifact.tsx            — ItemDetail (+ held_by_wild).
        ├── TypeMatchupsArtifact.tsx    — TypeMatchupsDetail (offensive/defensive) — also the type-grid.
        ├── ComparisonArtifact.tsx      — Payload-derived comparison grid from candidates/subjects.
        └── DamageCalcArtifact.tsx      — Payload-derived; wraps DamageReadout.
src/app/artifact-viewer.css             — NEW. BEM styles + mobile overlay media query. (Co-located per convention.)
```
Ownership: each existing file is edited by exactly one phase (see Build Manifest) — no two
builders touch the same file.

## Interface Definitions

### Shared contract — `src/lib/entity-artifact.ts`
```ts
export type EntityKind = "pokemon" | "move" | "ability" | "item" | "type";

// Per-kind payloads reuse the existing Zod-inferred entity types from @/agent/schemas,
// minus the `found` discriminator, plus profile-only additions for Pokémon/ability.
export type PokemonArtifactData = Omit<PokemonProfile, "found"> & {
  abilities_detail: { slot: "slot1" | "slot2" | "hidden"; name: string; effect_short: string }[];
  movepool: { method: "level-up" | "machine" | "tutor"; moves: { slug: string; display_name: string; type: TypeName }[] }[];
  type_matchups: Omit<TypeMatchupsDetail, "found">;   // combined defensive (+ offensive when single-typed)
  evolution?: Omit<EvolutionChainDetail, "found">;
};
export type EntityArtifactData =
  | { kind: "pokemon";  pokemon: PokemonArtifactData }
  | { kind: "move";     move: Omit<MoveDetail, "found"> }
  | { kind: "ability";  ability: Omit<AbilityDetail, "found"> & { learned_by: { slug: string; display_name: string }[] } }
  | { kind: "item";     item: Omit<ItemDetail, "found"> }
  | { kind: "type";     type: Omit<TypeMatchupsDetail, "found"> };
// EntityArtifactResponse: see API Design. Define the Zod schema and infer all types from it.
```

### Assembler — `src/data/entity-profile.ts`
```ts
type AssembleResult =
  | { status: "ok"; resolved: { slug: string; display_name: string };
      generation: string; is_fallback: boolean; fallback_note?: string;
      citations: Citation[]; data: EntityArtifactData }
  | { status: "not_found"; suggestions: string[] }
  | { status: "unavailable" };

export async function assembleEntityProfile(
  kind: EntityKind, slug: string, format: Format, db: PokebotDb
): Promise<AssembleResult>;
```
Composition per kind:
- **pokemon**: `getPokemon` → if miss, `not_found`. Then in parallel: `movesForPokemon` +
  `moveSummaries` (→ grouped movepool with type badges), `getReference("ability", …)` per
  slot, `getReference("type", …)` per type → `combineDefensiveMatchups`,
  `getReference("evolution", species)`. Build `citations` from the data
  (`pokemon/<slug>` etc. with `endpoint_url` where known).
- **move**: `getReference("move", slug)` (+ `gen9LearnerCount`).
- **ability**: `getReference("ability", slug)` + `pokemonWithAbility`.
- **item**: `getReference("item", slug)`. **type**: `getReference("type", slug)`.
- Any repo `index_unavailable` → `unavailable`.

### New repo reads
```ts
// learnset-repo.ts
export async function movesForPokemon(pokemonId: string, format: Format, db: PokebotDb):
  Promise<{ moveSlug: string; method: string }[]>;
// pokedex-repo.ts
export async function pokemonWithAbility(abilitySlug: string, format: Format, db: PokebotDb):
  Promise<{ slug: string; display_name: string }[]>;
// reference-cache.ts  (one query over reference_cache; parses payloads for display_name+type)
export async function moveSummaries(moveSlugs: string[], format: Format, db: PokebotDb):
  Promise<Map<string, { display_name: string; type: TypeName }>>;
```

### Viewer state — `useArtifactViewer()`
```ts
type ArtifactRef =
  | { source: "entity"; kind: EntityKind; query: string; format: Format }     // needs fetch
  | { source: "structured"; view: "comparison" | "damage"; payload: unknown   // from PokebotAnswer
      ; title: string; format: Format };

interface ArtifactViewerApi {
  isOpen: boolean;
  current: ArtifactRef | null;
  canGoBack: boolean;
  // entity fetch state for the current entity ref:
  status: "idle" | "loading" | "ok" | "not_found" | "unavailable";
  response: EntityArtifactResponse | null;   // for entity refs
  openEntity(kind: EntityKind, query: string, format: Format): void;  // pushes + fetches
  openStructured(view: "comparison" | "damage", payload: unknown, title: string, format: Format): void;
  back(): void;     // pop; disabled when !canGoBack
  close(): void;    // clear stack + hide
  askInChat(): void; // pre-fills composer with a follow-up about current entity
}
```
State rules (satisfying BR-AV-4 / AV-US-5,6): `stack` is the history; `current` = top; opening
**replaces** what's shown but **pushes** so `back` returns to the prior (one visible at a
time). `close` empties the stack. Each entity ref drives one `/api/entity` fetch; results may
be cached by `(kind, slug, format)` within the session.

### Citation → entity parse (SourceList)
`citation.source` is `"<kind>/<slug>"` (e.g. `"ability/armor-tail"`, `"pokemon/garchomp"`,
`"type/ground"`, `"learnset/will-o-wisp (gen-9)"`). Parse the prefix to `EntityKind`
(map `learnset`→`move` using the slug before any parenthetical); unknown prefixes render as
plain text (no crash). Keep the existing external `↗` `endpoint_url` link (AV-3.2).

## Implementation Phases

**Phase 1 — Shared contract**
- Build: `src/lib/entity-artifact.ts` (Zod + inferred types for envelope + per-kind data,
  composed from `@/agent/schemas`).
- Depends on: nothing. Produces: the contract both server and client build to.
- Parallel: none (foundational). Test focus: schema parse/round-trip; `not_found`/`unavailable`
  variants parse; rejects malformed shapes.
- Requirement refs: AV-US-1, AV-US-3, BR-AV-3, BR-AV-6.

**Phase 2 — Repo reads + profile assembler**
- Build: `movesForPokemon`, `pokemonWithAbility`, `moveSummaries`; extract
  `src/agent/formulas/type-chart.ts` and refactor `get-type-matchups.ts` to use it;
  `src/data/entity-profile.ts`.
- Depends on: Phase 1. Produces: `assembleEntityProfile` + reads.
- Parallel: the three repo reads are independent; the type-chart extraction is independent.
- Test focus: oracle tests vs `seed: "tools"` fixture DB — per-kind assembly (pokemon full
  profile incl. grouped movepool + combined matchups, move, ability+learned_by, item, type),
  `not_found`, `unavailable`; **regression**: existing `get_type_matchups` tests still pass.
- Requirement refs: AV-US-1, AV-US-3, AV-US-9, AV-US-10, BR-AV-3, BR-AV-5, BR-AV-6, BR-AV-7, NFR-2.

**Phase 3 — Read endpoint**
- Build: `src/app/api/entity/route.ts`.
- Depends on: Phase 2 (+1). Produces: `GET /api/entity`.
- Parallel: none. Test focus: integration tests against fixture DB — `ok` for each kind,
  `not_found` (+suggestions) for a typo, `unavailable` when index empty, `format` param
  switches data, malformed params → 4xx. **Must `installAsSingleton(fix)`** because
  `resolveEntity` reads the `@/data/db` singleton (not a passed handle).
- Requirement refs: AV-US-1, AV-US-3, AV-US-9, AV-US-11, BR-AV-3, BR-AV-5, BR-AV-7, NFR-1, NFR-2.

**Phase 4 — Viewer state (context + hook)**
- Build: `ArtifactViewerProvider.tsx`, `useArtifactViewer.ts` (stack/current/isOpen state
  machine; client fetch of `/api/entity`; per-session result cache; no-op default).
- Depends on: Phase 1 (types); Phase 3 (endpoint — mock `fetch` in tests, real in checkpoint).
- Parallel: with Phase 5 renderers (different files; integrate in Phase 6).
- Test focus (jsdom, `fetch` mocked): open→loading→ok; `not_found`/`unavailable` states;
  drill-down push + `back` pop; one-at-a-time replace; `close` clears; format snapshot on open.
- Requirement refs: AV-US-4, AV-US-5, AV-US-6, AV-US-7, AV-US-11, BR-AV-1, BR-AV-4, BR-AV-7, NFR-5.

**Phase 5 — Artifact renderers + panel shell**
- Build: `ArtifactViewer.tsx`, `ArtifactSources.tsx`, the seven per-kind/structured
  renderers, `artifact-viewer.css`; `types.ts` re-exports.
- Depends on: Phase 4 (hook), Phase 1 (types). Produces: the visible panel.
- Parallel: **the per-kind renderers can be built simultaneously** (independent files).
- Test focus (jsdom, from fixtures): each renderer renders its shape; movepool groups +
  clickable rows; grounding chrome (format tag, sources, fallback caveat) present;
  loading/`not_found`/`unavailable`; back/close controls; `canGoBack` disables back.
- Requirement refs: AV-US-1, AV-US-5, AV-US-7, AV-US-9, AV-US-10, AV-US-11, BR-AV-6, BR-AV-8, NFR-3, NFR-4.

**Phase 6 — Wire-up & integration**
- Build: make `SpriteCard` / `TypeBadge` / `CandidateTable` rows / `SourceList` citations
  clickable via the hook; add per-section "open in viewer" buttons in `AnswerCard`
  (damage-calc, comparison); mount provider + panel in `page.tsx` (`chat-page__body` flex
  child; mobile overlay); lift composer draft + wire `askInChat` pre-fill; `onAskInChat`.
- Depends on: Phase 5, Phase 4. Produces: the working feature.
- Parallel: the per-leaf wiring tasks are independent of each other.
- Test focus (jsdom + fullstack): clicking a sprite/citation/type/candidate opens the entity
  (fetch mocked); a citation parses to the right kind/slug; per-section button opens the
  structured artifact from payload; `askInChat` pre-fills the composer; nested click drills +
  back returns; the ↗ external link still works.
- Requirement refs: AV-US-1, AV-US-2, AV-US-3, AV-US-4, AV-US-5, AV-US-7, AV-US-8, BR-AV-2, BR-AV-8, BR-AV-9, BR-AV-10.

**Integration checkpoints**
- **After Phase 3** (`backend-entity-e2e`): route → assembler → repos → fixture DB returns a
  correct full profile per kind, and the right `not_found` / `unavailable` envelopes.
- **After Phase 6** (`frontend-entity-e2e`): in a rendered answer, clicking an entity fetches
  `/api/entity` and the panel renders the profile; drill-down + back work; mobile overlay
  renders; chat stays usable with the panel open (BR-AV-10).

## Build Manifest
```yaml
commands:
  test: "npm test"                                  # vitest run (node project needs Docker/Testcontainers)
  test_one: "npx vitest run <file>"                 # e.g. npx vitest run src/data/entity-profile.oracle.test.ts
  test_components: "npm run test:components"         # vitest run --project jsdom (no Docker)
  typecheck: "npm run typecheck"
  lint: "npm run lint"
  build: "npm run build"
phases:
  - id: p1
    name: Shared contract
    depends_on: []
    owns: ["src/lib/entity-artifact.ts"]
    shared: []
    requirement_refs: [AV-US-1, AV-US-3, BR-AV-3, BR-AV-6]
    test_focus: "envelope + per-kind Zod parse/round-trip; not_found/unavailable variants"
  - id: p2
    name: Repo reads + profile assembler
    depends_on: [p1]
    owns: ["src/data/entity-profile.ts", "src/data/repos/learnset-repo.ts",
           "src/data/repos/pokedex-repo.ts", "src/data/repos/reference-cache.ts",
           "src/agent/formulas/type-chart.ts", "src/agent/tools/get-type-matchups.ts"]
    shared: []
    requirement_refs: [AV-US-1, AV-US-3, AV-US-9, AV-US-10, BR-AV-3, BR-AV-5, BR-AV-6, BR-AV-7]
    test_focus: "per-kind assembly vs fixture DB; not_found/unavailable; get_type_matchups regression"
  - id: p3
    name: Read endpoint
    depends_on: [p2]
    owns: ["src/app/api/entity/route.ts"]
    shared: []
    requirement_refs: [AV-US-1, AV-US-3, AV-US-9, AV-US-11, BR-AV-3, BR-AV-5, BR-AV-7]
    test_focus: "GET ok/not_found/unavailable per kind; format param; installAsSingleton; malformed params"
  - id: p4
    name: Viewer state
    depends_on: [p1, p3]
    owns: ["src/components/artifact/ArtifactViewerProvider.tsx", "src/components/artifact/useArtifactViewer.ts"]
    shared: []
    requirement_refs: [AV-US-4, AV-US-5, AV-US-6, AV-US-7, AV-US-11, BR-AV-1, BR-AV-4, BR-AV-7]
    test_focus: "open/back/close/drill state machine; one-at-a-time; loading/error; fetch mocked"
    flags: [ui]
  - id: p5
    name: Renderers + panel shell
    depends_on: [p4, p1]
    owns: ["src/components/artifact/ArtifactViewer.tsx", "src/components/artifact/ArtifactSources.tsx",
           "src/components/artifact/PokemonArtifact.tsx", "src/components/artifact/MoveArtifact.tsx",
           "src/components/artifact/AbilityArtifact.tsx", "src/components/artifact/ItemArtifact.tsx",
           "src/components/artifact/TypeMatchupsArtifact.tsx", "src/components/artifact/ComparisonArtifact.tsx",
           "src/components/artifact/DamageCalcArtifact.tsx", "src/app/artifact-viewer.css",
           "src/components/types.ts"]
    shared: []
    requirement_refs: [AV-US-1, AV-US-5, AV-US-7, AV-US-9, AV-US-10, AV-US-11, BR-AV-6, BR-AV-8]
    test_focus: "each renderer from fixtures; movepool groups/clickable; grounding chrome; status states"
    flags: [ui]
  - id: p6
    name: Wire-up & integration
    depends_on: [p5, p4]
    owns: ["src/app/page.tsx", "src/components/AnswerCard.tsx", "src/components/Composer.tsx",
           "src/components/SpriteCard.tsx", "src/components/TypeBadge.tsx",
           "src/components/CandidateTable.tsx", "src/components/SourceList.tsx"]
    shared: []
    requirement_refs: [AV-US-1, AV-US-2, AV-US-3, AV-US-4, AV-US-5, AV-US-7, AV-US-8, BR-AV-2, BR-AV-8, BR-AV-9, BR-AV-10]
    test_focus: "entity clicks open panel (fetch mocked); citation parse; per-section button; ask-in-chat prefill; drill+back"
    flags: [ui]
integration_checkpoints:
  - after: [p3]
    name: backend-entity-e2e
    verifies: "route → assembler → repos → fixture DB: correct full profile per kind; not_found/unavailable envelopes"
  - after: [p6]
    name: frontend-entity-e2e
    verifies: "click entity → /api/entity → panel renders profile; drill-down + back; mobile overlay; chat stays usable"
```

## Technical Decisions

**TD-1 — Dedicated read endpoint over the repo layer (not the tool layer, not payload
enrichment).** Full profiles need data absent from `PokebotAnswer` (BR-AV-3), so a fresh read
is required. The endpoint goes through repos (the sole DB readers per CLAUDE.md), keeping the
agent's 11-tool contract and tool-loop untouched. *Alternatives:* reuse the agent tool
run-functions (rejected — couples the UI fetch path to the agent layer); enrich the citation
payload to carry full profiles (rejected — bloats every answer, still can't hold a full
movepool). *Tradeoff:* a small amount of composition logic lives outside the tool layer; we
accept it to keep layering honest. **This reverses B-6's tentative "no fresh read /
frontend-derived" note** — see `docs/backlog.md`.

**TD-2 — Entity vs structured split.** Only entity-detail artifacts fetch; structured
artifacts (damage-calc, comparison) render from the committed answer payload. Keeps the data
path tiny and most artifacts instant. *Tradeoff:* two open paths in the provider — acceptable;
they share the same panel/stack.

**TD-3 — "Type-grid" = "type" entity artifact.** One `TypeMatchupsDetail` renderer, reached
by clicking a type badge or drilling in. Resolves the requirements' open question; avoids a
redundant payload-derived type-grid (answers carry no type-matchup field anyway).

**TD-4 — Team sheet deferred to B-2.** No team/set data model exists; a real team sheet would
require inventing one ahead of B-2 (scope creep). v1 ships entity-detail + comparison +
damage-calc + type-grid. *Tradeoff:* one named requirement type slips — documented and agreed.

**TD-5 — React context for viewer state (not prop-drilling).** Clickable entities are deep
in the tree (SourceList items, type badges, candidate rows). A context with a no-op default
lets leaves call `openEntity` directly while keeping them renderable in isolation tests.
*Tradeoff:* a few presentational leaves now read context — minor.

**TD-6 — Extract dual-type matchup logic into `type-chart.ts`.** The Pokémon profile's
combined defensive grid reuses the exact mechanics the `get_type_matchups` tool already
implements, factored into one pure module both call — no reimplementation, guarded by the
tool's existing tests. *Tradeoff:* a behavior-preserving edit to one agent tool file.

**TD-7 — "Ask about this in chat" pre-fills the composer.** Resolves the requirements' open
question (pre-fill, not auto-send); user reviews and sends. Implemented by lifting the
composer draft into page state. *Tradeoff:* a small controlled-input change to `Composer`.

## Deployment & Infrastructure
Budget tier: **hobby** — this feature adds **no infrastructure**.

Runnable commands (source of truth; mirrored in the Build Manifest):
- `test`: `npm test` · `test_one`: `npx vitest run <file>` · components: `npm run test:components`
- `typecheck`: `npm run typecheck` · `lint`: `npm run lint` · `build`: `npm run build`

- **Hosting / runtime:** unchanged — the existing Next.js app; the new endpoint is one more
  App Router route handler in the same process.
- **Database hosting:** unchanged — existing Postgres; read-only, no migrations.
- **Background jobs / object storage / caching:** none. (Entity fetches use an in-memory,
  per-session result cache in the client provider — not infra.)
- **Observability:** existing stdout logs; the route logs structured request/outcome lines
  consistent with the app.
- **Secrets:** none new.
- **Environments:** unchanged.

**Rough monthly cost added: $0.**

## Unresolved from Requirements
Resolved here:
- *Movepool presentation* → grouped by learn method (level-up / TM / tutor), moves clickable
  with type badges, hydrated by one batched `moveSummaries` read.
- *Live format re-render* → not implemented; artifacts snapshot the format at open and always
  tag it (BR-AV-7). Re-open to refresh.
- *"Ask about this in chat" behavior* → pre-fill the composer (TD-7).
- *Source-detail as its own type* → no; it's the entity-detail artifact opened from a citation
  (with the cited datum present in `citations[]`).
- *Type-grid vs type entity overlap* → merged (TD-3).

Still open (non-blocking, builder discretion):
- Exact desktop panel width / breakpoint for the mobile overlay switch — a design-system
  detail; pick a sensible default and refine visually.
- Whether very large movepools need virtualization — defer until observed; the grouped list
  is fine for typical sizes.
