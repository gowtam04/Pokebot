# Team Builder — Technical Design

## Overview

Mode: PM
Budget Tier: hobby
Backend Topology: existing Next.js monolith (unchanged)

This design lets a signed-in user **persist, edit, import/export, and reason
about competitive teams**, and lets the chat agent **read a per-conversation
active team** and **propose teams** the user applies. It extends three shipped
systems without disturbing them: **B-1 (Account Creation)** for identity/isolation,
**B-3 (Chat History)** for the per-conversation state pattern, and the fixed agent
runtime.

The central ideas:

1. **A team is one `team` row + a JSON `members` column** (the codebase's
   established nested-payload convention: `reference_cache.payload`,
   `conversation_message.answer_json`). The `members` array — validated by a
   **shared Zod schema** — is the one shape used everywhere: storage, the Teams
   API, Showdown import/export, and the agent's `proposed_team`.
2. **The active team is server-bound onto the agent context, exactly like
   `mode`.** The client sends an `active_team_id` on the chat request; the route
   resolves + authorizes it and binds the raw team onto `AgentContext.activeTeam`.
   The model never receives a team-selecting argument — it reads the bound team
   through a new read-only tool, **only when the user's question is about the
   team** (BR-T9). This preserves the "active format / active team is
   server-controlled, never a scope-widening LLM input" invariant.
3. **Validation is warn-but-allow and computed on demand** from the existing
   per-format index (no new `@pkmn` calls, no stored/staleable warnings).
4. **The agent proposes; the user applies.** A new optional `proposed_team` field
   on `OakAnswer` carries an inert suggestion; "Apply" is a normal
   authenticated write to the Teams API (BR-T8) — the agent never mutates a team.

> **Agent-internals note (deliberate deviation).** Per the chosen "inline it now"
> path, this doc specifies the agent-facing changes directly: a **12th tool**
> (`get_active_team`), additions to the system prompt + few-shot, and the
> `proposed_team` output field. The repo's standing rule is that agent internals
> live in `docs/agent-design/`. **Phase 11 reconciles** these specs into
> `docs/agent-design/{tools.md,prompts.md,output-formats.md}` so that source of
> truth does not drift. See Technical Decision **TEAM-AD-3**.

## Requirements Reference

- Business requirements: `docs/features/team-builder/requirements/requirements.md`
  (TEAM-US-1..11, BR-T1..11, AC-*).
- Refines backlog item **B-2** (`docs/backlog.md`).
- Builds on **B-1 — Account Creation** (`docs/features/account-creation/`):
  reuses `account` / `auth_session`, `getCurrentAccount()`, per-account isolation
  (BR-A9), and the `@/data/db` singleton + repo conventions.
- Builds on **B-3 — Chat History** (`docs/features/chat-history/`): reuses the
  `conversation` table and its lazy-create-on-first-turn lifecycle, the
  conversation API, and the "mode follows the conversation's stored format" rule
  (BR-H6). The per-conversation **active team** is a new column on `conversation`.
- **Agent internals are specified inline here** (per the chosen path) rather than
  deferred to a separate `agent-design/` pass; Phase 11 folds them back into
  `docs/agent-design/`.

## Tech Stack

Existing stack unchanged: TypeScript (strict, ESM, `@/`→`src/`), Next.js 15 App
Router, Drizzle ORM + node-postgres, Zod, pino, Vitest (node + jsdom).

- **One new dependency: `@pkmn/sets`** (`^0.10.x`, same ecosystem as the installed
  `@pkmn/dex|data|mods`) — the canonical Showdown/pokepaste parser+serializer.
  Imported **only** from `src/data/pkmn/team-paste.ts`, honoring the "all `@pkmn`
  imports live under `src/data/pkmn/`" convention. **Docker gotcha:** after adding
  it, refresh the anonymous `node_modules` volume (see CLAUDE.md Gotchas) — a plain
  restart won't pick it up.
- **No other new infra.** Reuses the running Postgres; one new migration
  (`drizzle/0003_*.sql`). No new env vars, queues, caches, or external calls.
- **Reused pure modules** (no server-only imports, so client-importable):
  `src/agent/formulas/compute-stat.ts` (live computed stats in the editor),
  `src/data/teams/team-schema.ts` (new shared Zod), `src/data/formats.ts`.

## Data Model

One new table; one new column on `conversation`. Conventions match the existing
schema: snake_case columns, `bigint`/`mode:"number"` epoch-ms timestamps, **logical
(not physical) FKs** enforced in the repo, nested data as JSON TEXT.

### `team` — one row per saved team

| column          | type             | notes                                                                 |
|-----------------|------------------|-----------------------------------------------------------------------|
| `id`            | text PK          | UUID (`crypto.randomUUID()`)                                           |
| `account_id`    | text NOT NULL    | logical FK → `account.id`; every query filters by it (BR-T2 / BR-A9)  |
| `format`        | text NOT NULL    | `"scarlet-violet"` \| `"champions"`; fixed for the team's life (BR-T3) |
| `name`          | text NOT NULL    | user-facing; non-empty (default "Untitled team", BR-T1/AC-1.2)        |
| `members`       | text NOT NULL    | JSON: `TeamMember[]` (0–6), validated by `teamMembersSchema`           |
| `created_at`    | bigint NOT NULL  | epoch ms                                                              |
| `updated_at`    | bigint NOT NULL  | epoch ms; drives list ordering                                        |

Indexes:
- PK on `id`.
- `team_account_updated_idx` on `(account_id, updated_at)` — backs the per-account
  list (`ORDER BY updated_at DESC`), scoped by `account_id`. Format is filtered in
  the query (tiny N per account).

`members` is stored as a whole (teams are always read/written as a unit — no
cross-member SQL is required). Validity warnings are **not** stored (computed on
demand, TEAM-AD-2).

### `conversation` — modified (add one column)

| new column        | type           | notes                                                                  |
|-------------------|----------------|------------------------------------------------------------------------|
| `active_team_id`  | text NULL      | logical FK → `team.id`; the conversation's active team (BR-T9). NULL = none (AC-8.1). |

No index needed (read with the conversation row by PK). On delete of a team, the
repo clears it from any conversation that referenced it (BR-T10).

### `TeamMember` (shared Zod — `src/data/teams/team-schema.ts`)

```ts
// 0..255 raw (Showdown lets users type 255); validation flags >252 / total>508.
const statSpread = z.object({
  hp: z.number().int().min(0).max(255), atk: z.number().int().min(0).max(255),
  def: z.number().int().min(0).max(255), spa: z.number().int().min(0).max(255),
  spd: z.number().int().min(0).max(255), spe: z.number().int().min(0).max(255),
}).strict();

export const teamMemberSchema = z.object({
  species:   z.string().nullable(),          // slug; null = empty slot (BR-T4)
  ability:   z.string().nullable(),          // slug
  item:      z.string().nullable(),          // slug
  moves:     z.array(z.string()).max(4),     // slugs; may be < 4 (partial ok)
  nature:    z.string().nullable(),          // one of 25
  evs:       statSpread,
  ivs:       statSpread,                      // each 0..31 expected; warn if not
  tera_type: z.string().nullable(),          // one of 18
  level:     z.number().int().min(1).max(100), // default 50 (both formats)
  // cosmetic — preserved on import/export, not competitively significant (BR-T1)
  nickname:  z.string().nullable().optional(),
  gender:    z.enum(["M", "F", "N"]).nullable().optional(),
  shiny:     z.boolean().optional(),
}).strict();

export const teamMembersSchema = z.array(teamMemberSchema).max(6);
export type TeamMember = z.infer<typeof teamMemberSchema>;
```

This file imports **nothing server-only** so it is shared by repos, the API,
validation, the frontend, and `src/agent/schemas.ts` (the `proposed_team` field).

### ERD sketch

```
account 1 ── * team            (team.account_id → account.id)
account 1 ── * conversation    (conversation.account_id → account.id)
conversation * ── 0..1 team    (conversation.active_team_id → team.id, nullable)
```

No physical FK / cascade — `deleteTeam` removes the row and nulls
`conversation.active_team_id` references in one transaction (BR-T10), matching the
schema's logical-FK convention.

## Component Design

DB access stays in repos (the "repos are the sole Postgres readers" rule). Services
that compose repos + index reads live under `src/server/teams/`. The `@pkmn`
boundary stays under `src/data/pkmn/`.

- **`team-repo` (`src/data/repos/team-repo.ts`)** — sole reader/writer for `team`.
  Async; every method takes `accountId` and filters by it (BR-T2). Owns
  transactional `createTeam`, `updateTeam`, `deleteTeam` (+ null out conversation
  references), `duplicateTeam`. Parses/serializes the `members` JSON column.
- **`conversation-repo` (modified)** — add `active_team_id` to reads/writes:
  `appendTurnPair` upserts it per turn, `getConversation` returns it, and a new
  `setActiveTeam(accountId, conversationId, teamId|null)` for the PATCH path.
- **`validate-team` (`src/server/teams/validate-team.ts`)** — pure-ish
  `validateTeam(members, format, db): Promise<TeamWarning[]>`. Composes existing
  index reads (`pokedex-repo.getPokemon` for species legality + legal abilities;
  `learnset-repo` for move legality; `searchable_names` for item/Tera/ability
  master lists) plus pure EV/IV/clause math. Never throws, never blocks (BR-T6).
- **`team-paste` (`src/data/pkmn/team-paste.ts`)** — the `@pkmn/sets` boundary:
  `parseShowdown(text): PokemonSet[]` and `serializeShowdown(sets): string`. Knows
  only `@pkmn/sets`; deals in `@pkmn`'s `PokemonSet` (display names). No DB.
- **`import-export` (`src/server/teams/import-export.ts`)** — composes `team-paste`
  with name↔slug resolution (`resolve-index` / `searchable_names`) to map between
  `PokemonSet` and `TeamMember`, emitting resolve-or-clarify `ImportNote[]` (BR-T7)
  and clamping/keeping out-of-range values (warn-but-allow, BR-T6/T11).
- **`active-team` (`src/server/teams/active-team.ts`)** — `resolveActiveTeam(
  accountId, teamId, mode, db)` (ownership + format-match guard → the raw
  `ActiveTeam` bound onto context, or `null`); and `enrichActiveTeam(team, db)`
  used by the tool to add display names + computed `validateTeam` warnings.
- **Agent (inlined):**
  - **`get-active-team` tool (`src/agent/tools/get-active-team.tool.ts`)** — T12.
    No team-selecting args; returns the context-bound active team enriched with
    display names + validity warnings, or `{ active: false }`.
  - **`schemas.ts` (modified)** — `TOOL_NAMES += "get_active_team"`; the tool's
    Zod I/O; `proposed_team` optional field on `oakAnswerSchema`.
  - **`types.ts` (modified)** — `AgentContext.activeTeam?: ActiveTeam`.
  - **`context.ts` (modified)** — bind `activeTeam` when the route supplies it.
  - **`runtime.ts` (modified)** — the tool auto-joins `TOOL_DEFS`; add an
    "Active team" section to the standard **and** Champions system prompts and a
    few-shot example to each (both cached prefixes; one-time invalidation).
- **Teams API (`src/app/api/teams/*`)** — thin HTTP adapters over the repo +
  services; resolve identity via `getCurrentAccount()` (the conversations-route
  pattern). Signed-in only.
- **`chat/route.ts` (modified)** — accept `active_team_id`, resolve+authorize+bind
  `ctx.activeTeam`, and pass it to `appendTurnPair` for persistence.
- **`conversations/[id]/route.ts` (modified)** — return `active_team_id` on GET;
  accept it on PATCH (immediate set on an existing conversation).
- **Frontend** — a `/teams` page (list + editor) and chat-side `ActiveTeamSelector`
  + `ProposedTeamCard`, plus `teams-client.ts` / `use-teams.ts`. Reuses
  `SpriteCard`, `TypeBadge`, `EntityLink`, and `compute-stat`.

## API Design

All routes are `runtime = "nodejs"`, return JSON, resolve identity via
`getCurrentAccount()`, and reuse the existing `{ code, message }` error envelope.
**Isolation (BR-T2, mirroring BR-H1):** every read/write filters by the resolved
`account.id`; a team owned by another account is **404**, never 403. Guests
(`account === null`) get **401 `unauthorized`** on all `/api/teams/*` routes
(teams are signed-in only).

### `GET /api/teams?format=<scarlet-violet|champions>`
- → **200** `{ teams: TeamSummary[] }`, ordered `updated_at DESC`; `format` filter
  optional. Guest → **401**. (TEAM-US-1, TEAM-US-4)

### `POST /api/teams`
- Body: `{ name?: string, format: string, members?: TeamMember[] }`. Validates
  `members` against `teamMembersSchema`; empty/partial allowed (BR-T4). Name
  defaults to "Untitled team" (AC-1.2).
- → **200** `{ team: Team, validation: TeamWarning[] }` (warn-but-allow). This is
  also the **"apply proposed team as new"** path (AC-6.3). (TEAM-US-1, TEAM-US-3)

### `GET /api/teams/[id]`
- Owns it → **200** `{ team: Team, validation: TeamWarning[] }` (full members +
  computed warnings for the editor, AC-5.4). Else **404**. (TEAM-US-2, TEAM-US-5)

### `PUT /api/teams/[id]`
- Body: `{ name?: string, members?: TeamMember[] }` (replace). Validates shape;
  warn-but-allow. → **200** `{ team, validation }`. Also the **"apply proposed
  team onto an existing team"** path (AC-6.3, AC-7.1). Else **404**. (TEAM-US-2,4)

### `DELETE /api/teams/[id]`
- Permanent; transactional (delete row + null `conversation.active_team_id`
  references, BR-T10). Idempotent (absent id → **404**, treated as success by the
  client). Else **404**. (TEAM-US-4, AC-4.3)

### `POST /api/teams/[id]/duplicate`
- Clones members into a new team named `"<name> copy"`; independent thereafter
  (AC-4.2). → **200** `{ team, validation }`. (TEAM-US-4)

### `POST /api/teams/import`
- Body: `{ format: string, paste: string }` — Showdown text. Parses (`team-paste`)
  + resolves names → `TeamMember[]`; **never aborts wholesale** — unresolved
  entries become `notes`, the rest import (AC-10.2); illegal/invalid values are
  preserved/clamped with warnings (AC-10.3). Creates a team.
- → **200** `{ team, validation, notes: ImportNote[] }`. (TEAM-US-10, BR-T7/T11)

### `GET /api/teams/[id]/export`
- → **200** `{ paste: string }` — Showdown text round-tripping every represented
  field (AC-11.1/11.2). Else **404**. (TEAM-US-11)

### `POST /api/chat` (modified)
The orchestration guardrails and SSE contract are **unchanged**. One added input,
gated on `account !== null`:
- Body gains optional `active_team_id?: string | null`. Before opening the stream,
  `resolveActiveTeam(account.id, active_team_id, mode, db)` runs: it loads the team
  (account-scoped) and **binds it only if `team.format === formatForMode(mode)`**
  (BR-T3, AC-8.3); otherwise binds `null`. The resolved `ActiveTeam` is set on
  `ctx.activeTeam`. Guests / missing id → `null`.
- On success, `appendTurnPair` persists `active_team_id` onto the conversation
  (last-selected-wins), so resume restores it. An aborted turn persists nothing
  (existing guard). (TEAM-US-8, TEAM-US-9)

### `GET/PATCH /api/conversations/[id]` (modified)
- GET response gains `active_team_id`. PATCH body gains optional `active_team_id`
  (set/clear on an existing conversation without chatting); validated as
  account-owned + format-matching, else ignored. (TEAM-US-8, AC-8.2)

## File Structure

```
src/
├── data/
│   ├── schema.ts                         — MODIFY: add `team` table; add conversation.active_team_id
│   ├── teams/
│   │   └── team-schema.ts                — NEW: shared Zod TeamMember/teamMembersSchema + types (no server-only)
│   ├── pkmn/
│   │   └── team-paste.ts                 — NEW: @pkmn/sets boundary — parseShowdown / serializeShowdown
│   └── repos/
│       ├── team-repo.ts                  — NEW: sole reader/writer for `team` (CRUD + duplicate, account-scoped, tx)
│       └── conversation-repo.ts          — MODIFY: active_team_id (append/get/import + setActiveTeam)
├── server/
│   └── teams/
│       ├── validate-team.ts              — NEW: validateTeam(members, format, db) → TeamWarning[] (warn-but-allow)
│       ├── import-export.ts              — NEW: importPaste / exportPaste (compose team-paste + name resolution)
│       └── active-team.ts                — NEW: resolveActiveTeam (bind) + enrichActiveTeam (tool view)
├── agent/                                 — (INLINED agent internals; reconciled to docs/agent-design in Phase 11)
│   ├── schemas.ts                        — MODIFY: TOOL_NAMES += get_active_team; tool I/O; proposed_team on OakAnswer
│   ├── types.ts                          — MODIFY: AgentContext.activeTeam?: ActiveTeam
│   ├── context.ts                        — MODIFY: bind activeTeam from the route
│   ├── runtime.ts                        — MODIFY: "Active team" prompt section + few-shot (standard & champions prefixes)
│   └── tools/
│       ├── get-active-team.tool.ts       — NEW: T12 — returns ctx-bound active team (enriched + warnings), no team-arg
│       └── index.ts                      — MODIFY: register getActiveTeamTool
├── app/
│   ├── api/
│   │   ├── teams/
│   │   │   ├── route.ts                  — NEW: GET list / POST create
│   │   │   ├── [id]/route.ts             — NEW: GET detail+validation / PUT replace / DELETE
│   │   │   ├── [id]/duplicate/route.ts   — NEW: POST clone
│   │   │   ├── [id]/export/route.ts      — NEW: GET Showdown paste
│   │   │   └── import/route.ts           — NEW: POST Showdown paste → team
│   │   ├── chat/route.ts                 — MODIFY: accept/resolve/bind/persist active_team_id
│   │   └── conversations/[id]/route.ts   — MODIFY: return + PATCH active_team_id
│   ├── teams/
│   │   └── page.tsx                      — NEW: Teams page (list + editor; signed-in)
│   └── page.tsx                          — MODIFY: ActiveTeamSelector, active_team_id state, ProposedTeamCard apply, /teams nav
├── components/
│   ├── teams/
│   │   ├── TeamList.tsx                  — NEW: team list (format filter, new/duplicate/delete, incomplete badge)
│   │   ├── TeamEditor.tsx                — NEW: single-team editor (name, 6 member panels, team-level warnings)
│   │   ├── TeamMemberPanel.tsx          — NEW: one set (species/ability/item/moves/nature/EV/IV/tera/level + live stats)
│   │   ├── TeamWarnings.tsx             — NEW: render TeamWarning[] (per-slot + team-level)
│   │   ├── PasteImportDialog.tsx        — NEW: paste Showdown text → import (shows notes)
│   │   ├── ExportDialog.tsx             — NEW: show/copy Showdown text
│   │   ├── ActiveTeamSelector.tsx       — NEW: chat-side picker (format-scoped, defaults none)
│   │   └── ProposedTeamCard.tsx         — NEW: render answer.proposed_team + Apply (save-new / apply-existing)
│   ├── AnswerCard.tsx                    — MODIFY: render proposed_team via ProposedTeamCard
│   └── types.ts                          — MODIFY: ChatTurn answer type carries proposed_team (from schema)
└── lib/
    ├── teams-client.ts                   — NEW: typed fetch helpers over /api/teams/* (never throw)
    └── use-teams.ts                      — NEW: list/editor state hook

drizzle/
└── 0003_*.sql                            — NEW: generated migration (team table + conversation.active_team_id)

package.json                              — MODIFY: add @pkmn/sets

Tests (co-located, existing infixes):
  src/data/teams/team-schema.test.ts                       (pure Zod)
  src/data/repos/team-repo.test.ts                         (oracle vs Testcontainers)
  src/data/pkmn/team-paste.test.ts                         (parse/serialize round-trip)
  src/server/teams/validate-team.test.ts                   (oracle vs fixture DB — each warning code)
  src/server/teams/import-export.test.ts                   (resolve-or-clarify + warn-but-allow)
  src/agent/tools/get-active-team.oracle.test.ts           (null / enriched+warnings)
  src/agent/schemas.test.ts                                (MODIFY: proposed_team optional + backward-compat)
  src/app/api/teams/teams.integration.test.ts             (CRUD, isolation, guest, import/export)
  src/app/api/chat/route.test.ts                           (MODIFY: active_team_id bind/persist/format-match)
  src/components/teams/*.test.tsx                           (jsdom)
  src/lib/use-teams.test.ts                                 (jsdom, mocked fetch)
  src/app/page.fullstack.test.tsx                          (MODIFY: active selector + proposed-team apply)
```

## Interface Definitions

Biased to high detail at the seams — an autonomous implementer may build this and
can't ask back. All repo/service methods are async; repos take `accountId` and
filter by it; nothing throws in-domain (a genuine DB fault propagates as a
transport error, as elsewhere).

### `src/data/repos/team-repo.ts`
```ts
import type { TeamMember } from "@/data/teams/team-schema";

export interface Team {
  id: string; accountId: string; format: string; name: string;
  members: TeamMember[]; createdAt: number; updatedAt: number;
}
export interface TeamSummary {            // list view — no full members
  id: string; name: string; format: string;
  memberCount: number; incomplete: boolean; updatedAt: number;
}

export function listTeams(accountId: string, opts?: { format?: string }): Promise<TeamSummary[]>;
export function getTeam(accountId: string, id: string): Promise<Team | null>;
export function createTeam(args: {
  accountId: string; format: string; name: string; members: TeamMember[]; now: number;
}): Promise<Team>;
export function updateTeam(args: {
  accountId: string; id: string; name?: string; members?: TeamMember[]; now: number;
}): Promise<Team | null>;             // null if not owned
export function duplicateTeam(accountId: string, id: string, now: number): Promise<Team | null>;
// tx: delete the row AND null conversation.active_team_id where it referenced this team (BR-T10)
export function deleteTeam(accountId: string, id: string): Promise<void>;
```
`incomplete = members.length < 6 || any member missing species/4 moves` — cheap,
computed without index reads (full warnings come from `validateTeam` on detail).

### `src/server/teams/validate-team.ts`
```ts
import type { TeamMember } from "@/data/teams/team-schema";
import type { Format } from "@/data/formats";
import type { OakDb } from "@/data/db";

export type WarningCode =
  | "incomplete"            // informational (BR-T4)
  | "ev_total_exceeded"     // sum(evs) > 508
  | "ev_stat_exceeded"      // an EV > 252
  | "iv_out_of_range"       // an IV outside 0..31
  | "species_illegal"       // species not in the format roster
  | "ability_not_for_species" // ability not one of the species' legal abilities
  | "item_illegal"          // item not legal in the format
  | "move_not_in_learnset"  // move not in the species' learnset for the format
  | "duplicate_species"     // species clause
  | "duplicate_item";       // item clause

export interface TeamWarning {
  code: WarningCode; message: string;
  slot?: number;            // 0..5; absent ⇒ team-level (e.g. clauses)
  field?: string;           // e.g. "evs.atk", "moves[2]", "ability"
}

// Never throws; returns [] when clean. Composes getPokemon / learnset / searchable_names.
export function validateTeam(members: TeamMember[], format: Format, db: OakDb): Promise<TeamWarning[]>;
```

### `src/data/pkmn/team-paste.ts` (the only `@pkmn/sets` importer)
```ts
import type { PokemonSet } from "@pkmn/sets";
export function parseShowdown(text: string): PokemonSet[];        // tolerant; skips unparseable blocks
export function serializeShowdown(sets: PokemonSet[]): string;
```

### `src/server/teams/import-export.ts`
```ts
export interface ImportNote {
  slot: number; kind: "pokemon" | "move" | "ability" | "item" | "nature" | "tera";
  raw: string; resolvedTo?: string; message: string;   // resolve-or-clarify (BR-T7)
}
export function importPaste(paste: string, format: Format, db: OakDb):
  Promise<{ members: TeamMember[]; notes: ImportNote[] }>;
export function exportPaste(members: TeamMember[], format: Format, db: OakDb):
  Promise<string>;
```

### `src/server/teams/active-team.ts`
```ts
import type { AgentMode } from "@/agent/types";
export interface ActiveTeam {                  // bound onto AgentContext (raw slugs)
  id: string; name: string; format: string; members: TeamMember[];
}
// Loads account-scoped; returns null unless team.format === formatForMode(mode) (BR-T3, AC-8.3).
export function resolveActiveTeam(
  accountId: string, teamId: string | null | undefined, mode: AgentMode, db: OakDb,
): Promise<ActiveTeam | null>;

// The agent-facing view (display names + computed warnings); used by the T12 tool.
export interface EnrichedActiveTeam {
  name: string; format: string;
  members: Array<{
    species: string | null; species_display: string | null;
    ability: string | null; ability_display: string | null;
    item: string | null; item_display: string | null;
    moves: string[]; moves_display: string[];
    nature: string | null; evs: Record<string, number>; ivs: Record<string, number>;
    tera_type: string | null; level: number;
  }>;
  warnings: TeamWarning[];
}
export function enrichActiveTeam(team: ActiveTeam, db: OakDb): Promise<EnrichedActiveTeam>;
```

### Agent seam (inlined — `src/agent/types.ts`, `schemas.ts`)
```ts
// types.ts — additive field; the agent layer still never sees account_id.
export interface AgentContext {
  db: DbCtx; logger: Logger; requestId: string; mode: AgentMode; signal?: AbortSignal;
  activeTeam?: import("@/server/teams/active-team").ActiveTeam;   // server-bound; default undefined
}

// schemas.ts — T12 tool I/O. Input takes NO team-selecting argument (server-bound,
// not a scope-widening LLM input — mirrors how `mode` is handled).
export const getActiveTeamInputSchema = z.object({}).strict();
export type GetActiveTeamOutput =
  | { active: false }
  | { active: true; team: EnrichedActiveTeam };

// schemas.ts — additive optional field on the .strict() OakAnswer. Optional ⇒
// old stored answer_json stays valid (no unknown key); new answers may carry it.
proposed_team: z.object({
  name: z.string(),
  format: z.enum(["scarlet-violet", "champions"]),
  members: teamMembersSchema,
}).strict().optional()
```

**`get_active_team` tool behavior:** returns `{ active: false }` when
`ctx.activeTeam` is undefined; otherwise `{ active: true, team: enrichActiveTeam(
ctx.activeTeam, ctx.db) }`. Never throws (returns `{ active: false }` on any
in-domain miss). The model calls it **only when the user's question is about the
team** (prompt-guided, BR-T9); it is never forced (`tool_choice` stays `auto` —
see the thinking/tool_choice gotcha).

### `src/lib/teams-client.ts` (never throws; same-origin cookie)
```ts
import type { TeamMember } from "@/data/teams/team-schema";
export interface TeamSummary { id: string; name: string; format: string; memberCount: number; incomplete: boolean; updatedAt: number; }
export interface TeamDetail { id: string; name: string; format: string; members: TeamMember[]; validation: TeamWarning[]; }

export function listTeams(opts?: { format?: string }): Promise<TeamSummary[]>;
export function getTeam(id: string): Promise<TeamDetail | null>;
export function createTeam(input: { name?: string; format: string; members?: TeamMember[] }): Promise<TeamDetail | null>;
export function updateTeam(id: string, input: { name?: string; members?: TeamMember[] }): Promise<TeamDetail | null>;
export function deleteTeam(id: string): Promise<boolean>;
export function duplicateTeam(id: string): Promise<TeamDetail | null>;
export function importPaste(format: string, paste: string): Promise<{ team: TeamDetail; notes: ImportNote[] } | null>;
export function exportPaste(id: string): Promise<string | null>;
```

### Frontend behavioral contracts (`page.tsx`)
- **Active team state** is held per on-screen conversation (alongside
  `sessionId`/`turns`/`championsMode`): `activeTeamId: string | null`, default
  `null` (AC-8.1). Sent as `active_team_id` on every chat request.
- **Open conversation:** `getConversation(id)` returns `active_team_id` → set the
  selector. **Format toggle / open a different-format conversation:** clear
  `activeTeamId` if the selected team's format no longer matches (AC-8.3).
- **ActiveTeamSelector** lists `listTeams({ format })` for the current format only;
  selecting calls PATCH on an existing conversation (immediate persist) and always
  updates local state (so a not-yet-created conversation persists it on first turn).
- **ProposedTeamCard** (in `AnswerCard`) renders `answer.proposed_team` with
  **Apply → Save as new** (`createTeam`) and **Apply to existing** (`updateTeam`,
  pick from the account's same-format teams). The agent never writes (BR-T8).

## Implementation Phases

Granular, build-order; per-phase tests gate the next. "Parallel" calls out
independent work.

### Phase 1 — Shared schema + data model & migration
- **Build:** `team-schema.ts`; `schema.ts` (`team` table + `conversation.active_team_id`);
  `npm run db:generate` → `drizzle/0003_*.sql`.
- **Depends on:** nothing.
- **Produces:** the table, the column, the `TeamMember` Zod + types.
- **Parallel:** the pure `team-schema.ts` and the migration are independent.
- **Test focus:** migration applies on a fresh Testcontainers DB; `team` shape +
  `(account_id, updated_at)` index; `conversation.active_team_id` nullable;
  `teamMembersSchema` validates full/partial members + rejects unknown keys.
- **Requirement refs:** BR-T1, BR-T2, BR-T3, BR-T4, TEAM-US-1, TEAM-US-2.

### Phase 2 — team-repo + conversation-repo active-team
- **Build:** `team-repo.ts` (CRUD + duplicate, tx delete that nulls conversation
  refs); modify `conversation-repo.ts` (`active_team_id` in append/get/import +
  `setActiveTeam`).
- **Depends on:** Phase 1.
- **Produces:** durable team CRUD + active-team persistence.
- **Parallel:** team-repo and the conversation-repo edits are independent.
- **Test focus (oracle vs Testcontainers):** create/get/list/update/delete;
  `members` JSON round-trip; **account isolation** (other account → `null`/`[]`/404
  no-op); `duplicateTeam` independence (AC-4.2); `deleteTeam` nulls active refs
  (BR-T10); conversation `active_team_id` round-trips on append/get and via
  `setActiveTeam`.
- **Requirement refs:** TEAM-US-1, TEAM-US-3, TEAM-US-4, TEAM-US-8, BR-T2, BR-T10.

### Phase 3 — Validation service
- **Build:** `validate-team.ts`.
- **Depends on:** Phase 1 (+ existing pokedex/learnset/searchable repos).
- **Produces:** `validateTeam`.
- **Parallel:** with Phase 2 and Phase 4 (all depend only on Phase 1 + existing repos).
- **Test focus (oracle vs `tools`/`eval` fixture DB):** each `WarningCode` fires on
  a crafted member and stays silent when clean; EV total/per-stat + IV range math;
  species/ability/item legality vs the fixture index; learnset legality; species +
  item clause; **never blocks** (always returns an array, BR-T6).
- **Requirement refs:** BR-T5, BR-T6, TEAM-US-5, AC-5.1, AC-5.2, AC-5.3, AC-5.4.

### Phase 4 — Showdown import/export
- **Setup:** add `@pkmn/sets`; refresh the Docker `node_modules` volume (gotcha).
- **Build:** `team-paste.ts` (`@pkmn/sets` boundary); `import-export.ts` (resolve +
  map + `ImportNote[]`).
- **Depends on:** Phase 1 (+ resolve-index/searchable_names).
- **Parallel:** with Phases 2–3.
- **Test focus:** parse→map→serialize round-trip preserves all represented fields
  incl. cosmetics (AC-11.2); unresolved name → `note` + slot field null, rest
  imports (AC-10.2); over-cap EVs / illegal move preserved with the validation
  warning, import not aborted (AC-10.3).
- **Requirement refs:** BR-T7, BR-T11, TEAM-US-10, TEAM-US-11.

### Phase 5 — Teams API routes
- **Build:** `teams/route.ts`, `teams/[id]/route.ts`, `teams/[id]/duplicate`,
  `teams/[id]/export`, `teams/import`.
- **Depends on:** Phases 2, 3, 4.
- **Produces:** the `/api/teams/*` surface.
- **Parallel:** the route files are independent of each other.
- **Test focus (integration):** CRUD happy paths; create/update/import return
  `validation`; import returns `notes`; export round-trips; **isolation** (other
  account → 404 on get/put/delete/duplicate/export); **guest → 401** everywhere;
  partial team saves (BR-T4).
- **Requirement refs:** TEAM-US-1..5, TEAM-US-10, TEAM-US-11, BR-T2, BR-T6, BR-T7,
  BR-T10, BR-T11.

### Phase 6 — Agent integration (inlined internals)
- **Build:** `schemas.ts` (TOOL_NAMES, tool I/O, `proposed_team`); `types.ts`
  (`activeTeam`); `get-active-team.tool.ts`; `tools/index.ts`; `context.ts` (bind);
  `active-team.ts` (`resolveActiveTeam` + `enrichActiveTeam`); `runtime.ts`
  (prompt "Active team" section + a few-shot example in **both** the standard and
  Champions prefixes).
- **Depends on:** Phase 2 (team-repo), Phase 3 (validateTeam).
- **Produces:** the model can read the active team via T12; answers may carry
  `proposed_team`.
- **Test focus:** tool returns `{ active:false }` with no bound team and
  `{ active:true, team }` (display names + warnings) when bound; `proposed_team`
  is optional and **old `answer_json` still parses** (backward-compat);
  `MAX_ITERATIONS`, `tool_choice:"auto"`, and the two-prefix caching shape are
  unchanged (the prefix changes once, then stays byte-identical).
- **Requirement refs:** TEAM-US-6, TEAM-US-7, TEAM-US-9, BR-T8, BR-T9, AC-9.1,
  AC-9.2, AC-9.3.

### Phase 7 — Chat route + conversation API wiring
- **Build:** modify `chat/route.ts` (accept `active_team_id`; `resolveActiveTeam`
  → bind `ctx.activeTeam`; persist via `appendTurnPair`); modify
  `conversations/[id]/route.ts` (return `active_team_id`; PATCH set/clear).
- **Depends on:** Phase 6 (`ctx.activeTeam`, `resolveActiveTeam`), Phase 2.
- **Produces:** per-conversation active team, server end-to-end.
- **Test focus:** valid id binds; **format mismatch → null** (AC-8.3); persisted on
  turn + restored on resume (TEAM-US-8); guest id ignored; PATCH sets/clears on an
  existing conversation; aborted turn persists nothing.
- **Requirement refs:** TEAM-US-8, TEAM-US-9, BR-T3, BR-T9, AC-8.1, AC-8.2, AC-8.3.

### Phase 8 — Teams client + hook
- **Build:** `teams-client.ts`, `use-teams.ts`.
- **Depends on:** Phase 5.
- **Test focus (jsdom, mocked fetch — no db/repo imports):** every helper maps
  success/error/transport-failure to safe values; the hook does list/create/
  update/delete/duplicate/import/export + refresh; disabled/empty for guests.
- **Requirement refs:** TEAM-US-1, TEAM-US-4, TEAM-US-10, TEAM-US-11.

### Phase 9 — Teams page UI (manual builder)
- **Build:** `app/teams/page.tsx`; `components/teams/{TeamList,TeamEditor,
  TeamMemberPanel,TeamWarnings,PasteImportDialog,ExportDialog}.tsx`. Reuse
  `SpriteCard`/`TypeBadge`/`EntityLink`; reuse `compute-stat` for live stats.
- **Depends on:** Phase 8.
- **Parallel:** list / editor / member-panel / dialogs build against prop contracts.
- **Test focus (jsdom):** create/name/rename/duplicate/delete-with-confirm;
  add/remove/reorder members; edit every set field; **live computed stats**;
  per-slot + team-level warnings; partial save (BR-T4); import dialog shows notes;
  export dialog shows copyable text; empty + guest states.
- **Requirement refs:** TEAM-US-1, TEAM-US-2, TEAM-US-3, TEAM-US-4, TEAM-US-5,
  TEAM-US-10, TEAM-US-11, AC-2.1, AC-2.2, AC-2.3, AC-3.1, AC-4.1, AC-4.2, AC-4.3,
  AC-5.1..5.4.

### Phase 10 — Chat-side UI (active selector + proposed-team apply)
- **Build:** `ActiveTeamSelector.tsx`, `ProposedTeamCard.tsx`; modify
  `AnswerCard.tsx` (+`types.ts`), `page.tsx` (active-team state, send
  `active_team_id`, restore on open, clear on format toggle, `/teams` nav link).
- **Depends on:** Phase 8 (teams-client), Phase 7 (chat wiring), Phase 6
  (`proposed_team`).
- **Test focus (jsdom/fullstack, mocked fetch/SSE):** selector lists only
  current-format teams, defaults none, sets `active_team_id` (sent in body +
  PATCH), restored on open, cleared on format toggle; `proposed_team` renders with
  Apply → save-new (`createTeam`) and apply-existing (`updateTeam`).
- **Requirement refs:** TEAM-US-6, TEAM-US-7, TEAM-US-8, TEAM-US-9, AC-6.1, AC-6.2,
  AC-6.3, AC-7.1, AC-8.1, AC-8.2, AC-8.3.

### Phase 11 — Integration, edge cases & docs reconcile
- **Build:** end-to-end lifecycle tests; **reconcile inlined agent internals into
  `docs/agent-design/`** (`tools.md` += `get_active_team`/T12; `prompts.md` +=
  the Active-team guidance; `output-formats.md` += `proposed_team`) and mark **B-2**
  in `docs/backlog.md` + add an architecture pointer.
- **Depends on:** all prior.
- **Test focus (fullstack):** manual build + Showdown import on `/teams` → set
  active in chat → ask a team question (agent calls `get_active_team`, surfaces a
  validity warning, AC-9.3) → agent proposes a team → apply (save-new /
  apply-existing); isolation holds end-to-end; guests have no teams.
- **Requirement refs:** TEAM-US-1..11 (end-to-end), BR-T1..T11.

### Integration checkpoints
- **After Phase 5 — `teams-backend-e2e`:** against a real Testcontainers DB —
  create/import a team → validation warnings computed → export round-trips →
  another account gets 404. Verifies the data+API+validation+paste seam before any
  agent or UI work.
- **After Phase 7 — `active-team-agent-e2e`:** a signed-in chat turn with
  `active_team_id` → `ctx.activeTeam` bound (format-matched) → `get_active_team`
  returns the enriched team + warnings → persisted + restored on resume → a
  mismatched-format team is not bound. Verifies the agent-read seam before UI.
- **After Phase 10 — `team-builder-ui-e2e`:** browser-level — manual build +
  import on `/teams`; active selection in chat; `proposed_team` apply (both paths).

## Build Manifest

```yaml
commands:
  test: "npm test"                 # vitest run (node + jsdom); node project NEEDS Docker (Testcontainers)
  test_one: "npx vitest run"       # append a file path or -t <name>
  typecheck: "npm run typecheck"   # tsc --noEmit
  build: "npm run build"           # next build
phases:
  - id: p1
    name: Shared schema + data model & migration
    depends_on: []
    owns: ["src/data/teams/team-schema.ts", "drizzle/0003_*.sql"]
    shared: ["src/data/schema.ts"]
    requirement_refs: [BR-T1, BR-T2, BR-T3, BR-T4, TEAM-US-1, TEAM-US-2]
    test_focus: "migration applies; team shape + (account_id,updated_at) idx; conversation.active_team_id nullable; teamMembersSchema validates full/partial, rejects unknown keys"
  - id: p2
    name: team-repo + conversation-repo active-team
    depends_on: [p1]
    owns: ["src/data/repos/team-repo.ts"]
    shared: ["src/data/repos/conversation-repo.ts"]
    requirement_refs: [TEAM-US-1, TEAM-US-3, TEAM-US-4, TEAM-US-8, BR-T2, BR-T10]
    test_focus: "CRUD; members JSON round-trip; account isolation; duplicate independence; delete nulls active refs; conversation active_team_id round-trip + setActiveTeam"
  - id: p3
    name: Validation service
    depends_on: [p1]
    owns: ["src/server/teams/validate-team.ts"]
    shared: []
    requirement_refs: [BR-T5, BR-T6, TEAM-US-5, AC-5.1, AC-5.2, AC-5.3, AC-5.4]
    test_focus: "each WarningCode fires/silent; EV+IV+clause math; species/ability/item/learnset legality vs fixture; never blocks"
  - id: p4
    name: Showdown import/export
    depends_on: [p1]
    owns: ["src/data/pkmn/team-paste.ts", "src/server/teams/import-export.ts"]
    shared: ["package.json"]
    flags: [scaffold]
    requirement_refs: [BR-T7, BR-T11, TEAM-US-10, TEAM-US-11]
    test_focus: "round-trip preserves all fields incl cosmetics; unresolved name → note + rest imports; over-cap/illegal preserved with warning, no wholesale abort"
  - id: p5
    name: Teams API routes
    depends_on: [p2, p3, p4]
    owns: ["src/app/api/teams/**"]
    shared: []
    requirement_refs: [TEAM-US-1, TEAM-US-2, TEAM-US-3, TEAM-US-4, TEAM-US-5, TEAM-US-10, TEAM-US-11, BR-T2, BR-T6, BR-T7, BR-T10, BR-T11]
    test_focus: "CRUD; create/update/import return validation; import notes; export round-trip; isolation 404; guest 401; partial save"
  - id: p6
    name: Agent integration (inlined internals)
    depends_on: [p2, p3]
    owns: ["src/agent/tools/get-active-team.tool.ts", "src/server/teams/active-team.ts"]
    shared: ["src/agent/schemas.ts", "src/agent/types.ts", "src/agent/context.ts", "src/agent/runtime.ts", "src/agent/tools/index.ts"]
    flags: [ai]
    requirement_refs: [TEAM-US-6, TEAM-US-7, TEAM-US-9, BR-T8, BR-T9, AC-9.1, AC-9.2, AC-9.3]
    test_focus: "tool null/enriched+warnings; proposed_team optional + old answer_json parses; MAX_ITERATIONS/tool_choice/two-prefix caching unchanged"
  - id: p7
    name: Chat route + conversation API wiring
    depends_on: [p6, p2]
    owns: []
    shared: ["src/app/api/chat/route.ts", "src/app/api/conversations/[id]/route.ts"]
    flags: [ai]
    requirement_refs: [TEAM-US-8, TEAM-US-9, BR-T3, BR-T9, AC-8.1, AC-8.2, AC-8.3]
    test_focus: "valid id binds; format mismatch → null; persist on turn + restore on resume; guest ignored; PATCH set/clear; abort persists nothing"
  - id: p8
    name: Teams client + hook
    depends_on: [p5]
    owns: ["src/lib/teams-client.ts", "src/lib/use-teams.ts"]
    shared: []
    requirement_refs: [TEAM-US-1, TEAM-US-4, TEAM-US-10, TEAM-US-11]
    test_focus: "helpers map success/error/transport; hook list/create/update/delete/duplicate/import/export/refresh; guest empty"
  - id: p9
    name: Teams page UI (manual builder)
    depends_on: [p8]
    owns: ["src/app/teams/**", "src/components/teams/TeamList.tsx", "src/components/teams/TeamEditor.tsx", "src/components/teams/TeamMemberPanel.tsx", "src/components/teams/TeamWarnings.tsx", "src/components/teams/PasteImportDialog.tsx", "src/components/teams/ExportDialog.tsx"]
    shared: []
    flags: [ui]
    requirement_refs: [TEAM-US-1, TEAM-US-2, TEAM-US-3, TEAM-US-4, TEAM-US-5, TEAM-US-10, TEAM-US-11, AC-2.1, AC-2.2, AC-2.3, AC-3.1, AC-4.1, AC-4.2, AC-4.3, AC-5.1, AC-5.2, AC-5.3, AC-5.4]
    test_focus: "create/rename/duplicate/delete-confirm; add/remove/reorder members; all set fields; live computed stats; warnings; partial save; import notes; export copy; empty/guest"
  - id: p10
    name: Chat-side UI (active selector + proposed-team apply)
    depends_on: [p8, p7, p6]
    owns: ["src/components/teams/ActiveTeamSelector.tsx", "src/components/teams/ProposedTeamCard.tsx"]
    shared: ["src/components/AnswerCard.tsx", "src/components/types.ts", "src/app/page.tsx"]
    flags: [ui]
    requirement_refs: [TEAM-US-6, TEAM-US-7, TEAM-US-8, TEAM-US-9, AC-6.1, AC-6.2, AC-6.3, AC-7.1, AC-8.1, AC-8.2, AC-8.3]
    test_focus: "selector format-scoped/defaults none/sets active_team_id (body+PATCH)/restore on open/clear on toggle; proposed_team Apply save-new + apply-existing"
  - id: p11
    name: Integration, edge cases & docs reconcile
    depends_on: [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10]
    owns: ["src/app/api/teams/teams.integration.test.ts"]
    shared: ["src/app/page.tsx", "docs/backlog.md", "docs/agent-design/tools.md", "docs/agent-design/prompts.md", "docs/agent-design/output-formats.md"]
    flags: [ai]
    requirement_refs: [TEAM-US-1, TEAM-US-2, TEAM-US-3, TEAM-US-4, TEAM-US-5, TEAM-US-6, TEAM-US-7, TEAM-US-8, TEAM-US-9, TEAM-US-10, TEAM-US-11, BR-T1, BR-T2, BR-T3, BR-T4, BR-T5, BR-T6, BR-T7, BR-T8, BR-T9, BR-T10, BR-T11]
    test_focus: "full lifecycle manual+import → active → team question (tool+warnings) → propose → apply; isolation; guests have no teams"
integration_checkpoints:
  - after: [p5]
    name: teams-backend-e2e
    verifies: "create/import team → validation computed → export round-trips → cross-account 404, against a real DB"
  - after: [p7]
    name: active-team-agent-e2e
    verifies: "signed-in turn with active_team_id binds ctx.activeTeam (format-matched) → get_active_team returns enriched team+warnings → persist/restore on resume → mismatch not bound"
  - after: [p10]
    name: team-builder-ui-e2e
    verifies: "manual build + import on /teams; active selection in chat; proposed_team apply (save-new + apply-existing)"
```

> Cross-boundary files (sequence these edits): `src/data/schema.ts` (p1),
> `conversation-repo.ts` (p2), the five `src/agent/*` files (p6),
> `chat/route.ts` + `conversations/[id]/route.ts` (p7), and
> `AnswerCard.tsx`/`types.ts`/`page.tsx` (p10, with `page.tsx` again in p11).
> Everything else is single-owner.

## Technical Decisions

- **TEAM-AD-1 — Active team is server-bound onto `AgentContext`, read via a
  no-arg tool.** *Alternatives:* (a) inject the team into the system prompt or
  history every turn; (b) let the model pass a `team_id`. *Chosen:* the route
  resolves + authorizes `active_team_id` and binds the raw team onto
  `ctx.activeTeam`; a new read-only `get_active_team` tool (no team-selecting arg)
  surfaces it on demand. *Why:* (a) bloats every turn and breaks "only when
  asked" (BR-T9), and the team in the cached prefix would break byte-identical
  caching; (b) would make the team a scope-widening LLM input, violating the same
  invariant `mode` is protected by. A no-arg tool reading server-bound context is
  the exact analogue of how the active format already works, keeps the prefix
  static (only the tool *definition* is added, once), and leaves `MAX_ITERATIONS`
  / `tool_choice:"auto"` untouched. *Tradeoff:* the "11-tool contract" becomes a
  **12-tool contract** — a real change to a documented invariant, accepted
  deliberately and reconciled into `docs/agent-design/` (TEAM-AD-3).

- **TEAM-AD-2 — A team is one row + JSON `members`; validity is computed, not
  stored.** *Alternatives:* a normalized `team_pokemon` table (~30 cols);
  storing precomputed warnings. *Chosen:* a single `members` JSON TEXT column
  (codebase convention) + on-demand `validateTeam`. *Why:* teams are always
  read/written whole (no cross-member SQL is required), so JSON is simpler and maps
  1:1 to Showdown sets and `proposed_team`; computing warnings on demand keeps them
  fresh across re-ingest (a stored warning would silently go stale when the index
  changes) and matches the "no cache, reason on current data" ethos. *Tradeoff:* no
  SQL querying inside teams (acceptable — not a requirement) and a few index reads
  per validation (cheap, and only on editor load / tool call — not per chat turn).

- **TEAM-AD-3 — Agent internals are specified inline here, then reconciled to
  `docs/agent-design/`.** *Alternatives:* defer all agent-facing changes to a
  separate `agent-design` pass (the repo's standing rule). *Chosen (per the
  user's "inline it now"):* specify the T12 tool, the prompt/few-shot additions,
  and the `proposed_team` field in this doc, and add an explicit Phase-11 step that
  folds them into `tools.md` / `prompts.md` / `output-formats.md`. *Why:* gives
  `dev-team` a single buildable spec now. *Tradeoff:* until Phase 11 lands,
  `docs/agent-design/` is temporarily behind this doc — the reconciliation step is
  mandatory, not optional, to prevent drift of the agent's source of truth.

- **TEAM-AD-4 — Active team flows on the chat request body and persists on the
  conversation.** *Alternatives:* eagerly create a conversation row when a team is
  selected. *Chosen:* the client holds `activeTeamId` per on-screen conversation
  and sends it as `active_team_id`; the route binds it and `appendTurnPair`
  persists it (last-selected-wins); an existing conversation can also set it via the
  conversation PATCH. *Why:* mirrors how `session_id` / `champions_mode` already
  flow and preserves chat-history's "no DB row until the first turn" invariant.
  *Tradeoff:* selecting a team and never sending a message persists nothing until
  the first turn (acceptable; the selection lives in client state meanwhile).

- **TEAM-AD-5 — `@pkmn/sets` for paste; warn-but-allow import.** *Alternatives:* a
  hand-rolled pokepaste parser. *Chosen:* add `@pkmn/sets`, isolated to
  `src/data/pkmn/team-paste.ts`. *Why:* robust round-trip for free, in the
  ecosystem already vendored; import resolves names (BR-T7) and never aborts on a
  bad entry (BR-T11). *Tradeoff:* one dependency + the Docker `node_modules`
  refresh gotcha.

- **TEAM-AD-6 — `proposed_team` is an additive optional field on the `.strict()`
  `OakAnswer`.** *Why:* an optional field keeps every previously-stored
  `answer_json` valid (no unknown key, no missing-required failure) and is the
  clean structured channel for an inert proposal the user applies (BR-T8) — better
  than parsing a team out of markdown. *Tradeoff:* the answer schema grows;
  rendering must treat it as optional (it usually is absent).

## Unresolved from Requirements

Resolved here (the requirements' Open Questions, pinned for this build):
- **Computed stats in the editor:** **yes** — read-only, via the existing pure
  `compute-stat.ts` reused on the client. (Requirements Open Q.)
- **Level default & format conventions:** **level 50** for both formats (matches
  the existing `computeStat` default); **species clause** and **item clause** apply
  as *warnings* in both formats; **Tera** unrestricted (any of 18). These are
  warn-level and easy to refine per regulation later.
- **Agent-proposal completeness:** the agent may propose partial sets; `proposed_team`
  reuses `teamMembersSchema` (partial allowed), and the user completes/edits before
  or after applying.

Still open (non-blocking):
- **Damage-calc hand-off** ("calc vs my team's Garchomp") — overlaps **B-5**;
  out of scope here (the agent can already estimate damage with explicit inputs).
- **Team-count backstop cap** — none for now; the per-account chat rate limit and
  manual creation bound growth (mirrors chat-history's retention stance).
- **`proposed_team` schema evolution** — same forward-compat concern chat-history
  flagged for `answer_json`; additive-only for now.
- **Per-regulation legality depth** — `validateTeam` covers the common rules; exact
  per-regulation banlists (restricted-legendary counts, etc.) can deepen later
  without changing the warn-but-allow contract.
