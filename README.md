# Pokebot

A personal, single-user web chat agent that answers natural-language questions
about Pokémon — moves, abilities, types, stats, evolutions, items, and
game-mechanic interactions. The defining trait is that it **reasons on top of
data**: [PokeAPI](https://pokeapi.co/) supplies the raw building blocks (move
priority values, ability effect text, type charts, base stats), and the agent
deduces how those pieces interact.

> Example: *"does Fake Out work on Farigiraf?"* → "Fake Out is a +3 priority
> move; Armor Tail negates priority moves; if Farigiraf has Armor Tail, Fake Out
> fails." Every answer carries its reasoning, the cited PokeAPI data, an explicit
> inference/uncertainty flag, and the generation it's based on (Gen 9 baseline
> with flagged fallback).

It serves two blended use cases: **competitive team-building** (filter queries,
mechanics reasoning, battle math) and **general Pokédex curiosity** (lookups,
evolutions, matchups, items, trivia).

## Status

📐 **Design phase.** No application code yet — this repo currently holds the
requirements, the agent design, and the technical architecture. Implementation
has not started.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`docs/requirements/requirements.md`](docs/requirements/requirements.md) | Business requirements — user stories, acceptance criteria, business rules. |
| [`docs/agent-design/`](docs/agent-design/) | The agent's internals (fixed): topology, the 11 tools, data sources, prompts, output schema, eval spec. |
| [`docs/architecture/design.md`](docs/architecture/design.md) | Technical design — stack, data store, ingest pipeline, file structure, interfaces, build phases. |

## Planned stack

TypeScript / Next.js monolith · SQLite + Drizzle ORM · Server-Sent Events ·
Zod · Anthropic SDK (Claude Sonnet 4.6) · Vitest. All Pokémon data is derived
from PokeAPI into a local index + cache. See the architecture doc for details.

## Next steps

1. Run the `frontend-design` skill to define the visual language (type-color
   palette, sprite cards, layout).
2. Implement per the phased build plan in `docs/architecture/design.md`
   (scaffold → store/schema → ingest → tools → agent runtime → web API →
   frontend → eval).
