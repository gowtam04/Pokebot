# Pokebot — Agent Design Overview

## Problem

Pokebot is a personal, single-user, web-based chat agent that answers
natural-language questions about Pokémon — moves, abilities, types, stats,
evolutions, items, and **game-mechanic interactions**. The defining trait is
that it *reasons on top of data*: PokeAPI supplies raw building blocks (move
priority values, ability effect text, type charts, base stats), and the agent
deduces how those pieces interact ("Fake Out is a +3 priority move; Armor Tail
negates priority moves; therefore Fake Out fails against a Farigiraf that has
Armor Tail").

It serves two blended use cases equally: **competitive team-building**
(filter-style queries, mechanics reasoning, battle math) and **general Pokédex
curiosity** (lookups, evolutions, matchups, items, trivia).

Every answer carries the direct answer **plus** its reasoning, the cited PokeAPI
data, an explicit inference/uncertainty flag, and the generation the answer is
based on (Gen 9 baseline with flagged fallback).

## Source Docs

- Requirements: `docs/requirements/requirements.md`
- Architecture: _not yet written_ — run `solution-architect` after this design
  (see [Next Step](#next-step)).

## Mode

**Mode B (Post-Requirements).** Requirements exist; no architecture yet; the
agent **is** the product. This folder specifies the agent's internals (data,
tools, prompts, outputs, eval). The surrounding system (web server, cache/index
pipeline, frontend) is the architect's job and must treat this design as a fixed
constraint.

## Topology

**Single agent + agentic tool-loop.** One agent interprets the question, calls
data tools (local Pokédex index + on-demand PokeAPI detail fetches) in a loop,
reasons about mechanics and battle math, and emits a structured answer. The
steps are sequential and share context — the reasoning is what decides which
data to fetch next — so splitting fetch from reasoning would only add handoff
latency. No `orchestration.md` in this folder by design.

## Decisions

These are choices made during design. Each can be revisited; the rationale is
recorded so the dev team doesn't re-litigate.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Single agent**, not multi-agent | Sequential, context-sharing flow; reasoning drives fetching. Multi-agent adds 2–3× build/eval cost for no benefit here. |
| D2 | **Sonnet 4.6** as the reasoner | Strong competitive-mechanics reasoning at lower latency than Opus. A chat loop with 4–6 tool calls compounds latency; Sonnet keeps it interactive. Upgrade path to Opus is gated on eval (see `evaluation.md`). |
| D3 | **Local index + on-demand details** | Stat superlatives ("fastest"), thresholds ("Atk > 130"), and global filters can't be answered by per-query PokeAPI fetches without pulling ~1000+ resources — too slow and abuses fair-use (BR-8). A precomputed, queryable index makes filters O(index) and respects fair-use. |
| D4 | **Structured answer object** (via `submit_answer` tool) | Hard rendering requirements (sprites, type-color badges, separated reasoning/citations, uncertainty flags) need reliable typed fields, not free markdown. |
| D5 | **Deterministic `compute_stat` / `estimate_damage` tools** | The Pokémon stat/damage formulas floor at every step; LLM arithmetic slips on this. A deterministic tool guarantees the number while the agent owns the assumptions and shows its work (BR-6). The requirement's "computed by the agent — not a calculator endpoint" intent is preserved: PokeAPI provides inputs; we add an internal helper, not an external calc service. Drop it and let the model compute inline if preferred. |
| D6 | **Version-aware learnset index** keyed to the Gen 9 version group (`scarlet-violet`) | A move's `learned_by_pokemon` is cross-generation; BR-2 requires Gen-9-specific learnsets. The index is built by walking each Gen-9 Pokémon's `moves[].version_group_details` filtered to `scarlet-violet`. |
| D7 | **Damage calc:** compute with stated defaults, allow override | Level 50 (VGC), 31 IVs, 0 EVs, neutral nature, no weather/items unless named; always state assumptions, present as estimate, invite refinement (BR-6). |
| D8 | **Forms:** each battle-relevant form is a distinct indexed entity | Matches PokeAPI's model (each form is its own `pokemon` resource) and competitive reality (forms differ in type/stats/abilities). Agent disambiguates ambiguous names. |
| D9 | **In-session memory only** | Conversation context lives for the current session; no cross-session persistence. Matches requirements; keeps architecture simple. |
| D10 | **Final answer is a forced `submit_answer` tool call** | Stops the loop deterministically and yields validated structured output instead of "please return JSON". |

## Dependencies (must exist before the agent works)

> ⚠️ The agent is designed around data and tools that **do not exist yet**.
> These are engineering tasks for the architect / dev team. The agent cannot
> function without them.

1. **Local Pokédex index** — a queryable derived dataset of every Gen-9-legal
   Pokémon form (id, species, form, dex #, types, abilities incl. hidden, base
   stats + BST, sprite/artwork URL, generation/source flag). Powers
   `query_pokedex`, `get_pokemon`. _(See `data-sources.md` DS-2.)_
2. **Local Gen-9 learnset index** — `(pokemon, move)` membership for the
   `scarlet-violet` version group, built per D6. Powers multi-move intersection
   and "what can learn X". _(DS-3.)_
3. **Local PokeAPI reference cache** — lazily-populated key-value cache of move,
   ability, type, item, and evolution-chain resources (BR-8 fair-use). Backs
   the on-demand detail tools. _(DS-4.)_
4. **Ingest/build pipeline** — one-time + refreshable job that crawls PokeAPI
   (politely, cached) to build indexes 1–3.
5. **`compute_stat` / `estimate_damage`** deterministic formula tools (D5).
6. **Frontend renderer** for the structured answer (sprite cards, type badges,
   candidate table, citation list, inference/fallback callouts). _(See
   `ux-design.md`, `integration.md`.)_

If any of these slip, the affected capability degrades: no index → no
superlatives/global filters; no learnset index → no version-accurate move
filtering; no calc tools → fall back to model arithmetic (lower reliability).

## Sensitive Data

None. No PII, no auth, no accounts (single-user personal tool). PokeAPI is a
public, unauthenticated, read-only source. The only guardrails needed are
fair-use throttling toward PokeAPI and input-length limits — both in
orchestration, not the prompt (see `integration.md`).

## Next Step

After this design is approved, run **`solution-architect`** to design the
surrounding system, treating this `agent-design/` folder as a fixed constraint.
Architect scope: stack/runtime (web server + frontend), the **cache/index ingest
pipeline** (Dependency 4 — the largest build item), file structure, and build
phases. Architect must **not** redesign the agent's tools, prompts, or output
schema. After architect, run `dev-team`; it will use the `claude-api` skill for
SDK-level specifics (caching config, tool-loop, streaming).
