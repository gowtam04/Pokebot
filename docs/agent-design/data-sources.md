# Data Sources

The agent reads from four sources. PokeAPI is the single upstream source of
truth (hard constraint); the local index and cache are **derived** from it. All
PokeAPI access is mediated by the cache layer to respect fair-use (BR-8).

> ⚠️ DS-2, DS-3, DS-4 and their build pipeline **do not exist yet** — they are
> the architect's primary build item. See `overview.md` Dependencies.

---

## DS-1 — PokeAPI (upstream)

- **Purpose:** Source of all Pokémon data — species, forms, moves, abilities,
  types, evolution chains, items. The only external data source (out-of-scope to
  use any other; no wiki scraping).
- **Retrieval pattern:** **Never hit directly by the agent at answer time.**
  Accessed by (a) the offline ingest pipeline to build DS-2/DS-3, and (b) the
  reference cache (DS-4) on first access to a resource. The agent's tools read
  DS-2/DS-3/DS-4, not PokeAPI live.
- **Freshness:** PokeAPI itself lags the latest game patches/DLC; acceptable for
  this tool. Indexes rebuilt on a manual/scheduled cadence (e.g. on deploy or
  weekly), not per-request.
- **Size:** ~1300 Pokémon forms, ~900 moves, ~300 abilities, 18 types, ~2000
  items, ~550 evolution chains. Whole corpus is small enough to cache locally in
  full.
- **Access control / PII:** None. Public, unauthenticated, read-only.
- **Auth/credentials:** None (no API key). Identify with a descriptive
  User-Agent; honor rate/fair-use.
- **Failure behavior:** If PokeAPI is unreachable **during ingest**, reuse the
  last good index. If unreachable **during a live reference-cache miss**, the
  affected tool returns a structured `{ error: "upstream_unavailable" }`; the
  agent degrades gracefully and tells the user it couldn't reach PokeAPI for that
  detail rather than failing silently (NFR reliability).

---

## DS-2 — Local Pokédex Index (derived)

- **Purpose:** Fast, queryable table of every **Gen-9-legal Pokémon form**.
  Powers `query_pokedex` (filters, thresholds, superlatives) and `get_pokemon`.
- **Schema (per row):**
  `id`, `species_name`, `form_name`, `display_name`, `national_dex_number`,
  `types[]` (1–2, ordered), `abilities` (`slot1`, `slot2?`, `hidden?`),
  `base_stats` (`hp`, `attack`, `defense`, `special_attack`,
  `special_defense`, `speed`), `base_stat_total`, `sprite_url`,
  `artwork_url`, `generation` (e.g. `gen-9`), `is_gen9_native` (bool),
  `source_generation` (set when `is_gen9_native=false`, per BR-1).
- **Retrieval pattern:** **Tool-fetch against the local index.** In-memory or
  embedded DB; no network at query time.
- **Freshness:** Rebuilt with the ingest pipeline; effectively static between
  rebuilds.
- **Size:** ~1300 rows; a few MB. Fits in memory.
- **Access control:** None.
- **Failure behavior:** If the index is missing/corrupt, filter/superlative
  capabilities are unavailable — hard dependency. `query_pokedex` returns
  `{ error: "index_unavailable" }`; agent informs the user.

### Forms handling (D8)

Each battle-relevant form is its own row (e.g. Tauros Paldean Combat/Blaze/Aqua,
Ogerpon masks, Palafin Zero/Hero, Ursaluna Bloodmoon, Rotom forms). The
`display_name` disambiguates. The ingest pipeline maps PokeAPI `pokemon` (form)
resources to rows, grouped by `pokemon-species`. Purely cosmetic forms with
identical battle data may be collapsed to the base row (pipeline rule), but any
difference in type/stats/abilities means a distinct row.

---

## DS-3 — Local Gen-9 Learnset Index (derived)

- **Purpose:** Version-accurate "can this Pokémon learn this move in Gen 9?"
  membership (BR-2). Powers multi-move **intersection** (BR-7) and single-move
  "what can learn X" (AC-1.2), via `query_pokedex(moves=[...])` and `get_move`.
- **Schema:** A `(pokemon_id, move_id)` membership set for the **`scarlet-violet`
  version group** (and any other Gen-9 version groups, e.g. DLC), with a method
  hint (`level-up` / `machine` / `tutor` / `egg`-excluded) where useful.
- **Build rule (D6):** For each Gen-9 Pokémon row in DS-2, read PokeAPI
  `/pokemon/{id}` `moves[].version_group_details[]`, filter to Gen-9 version
  group(s), and emit `(pokemon, move)` pairs. **Egg moves are excluded** (egg
  moves/breeding are out of scope).
- **Retrieval pattern:** Tool-fetch against the local index; set operations
  (intersection) done in code, not by the model.
- **Freshness:** With the ingest pipeline.
- **Size:** Tens of thousands of pairs; a few MB.
- **Failure behavior:** If unavailable, version-accurate move filtering degrades.
  Tools return `{ error: "index_unavailable" }`; agent informs the user and, if
  it must, may fall back to a move's cross-gen `learned_by_pokemon` **with an
  explicit caveat that the result isn't Gen-9-filtered**.

---

## DS-4 — Local PokeAPI Reference Cache (derived, lazy)

- **Purpose:** Detail records the agent reads for reasoning: move details
  (priority, power, accuracy, PP, damage class, target, effect text), ability
  effect text, type damage relations, evolution chains, item effects + wild
  held-item data. Backs `get_move`, `get_ability`, `get_type_matchups`,
  `get_evolution_chain`, `get_item`.
- **Retrieval pattern:** **Tool-fetch with read-through cache.** On a cache miss,
  the cache layer fetches the PokeAPI resource once, stores it, and serves it;
  subsequent reads are local (BR-8). May be fully warmed by the ingest pipeline.
- **Freshness:** Cache TTL is long (data is slow-moving); invalidated on index
  rebuild. 24h+ TTL is fine.
- **Size:** Full reference corpus is small (low tens of MB).
- **Access control:** None.
- **Failure behavior:** Miss + PokeAPI down → `{ error: "upstream_unavailable" }`
  to the tool; agent degrades gracefully for that detail.

### Type chart note (BR-5)

`get_type_matchups` uses the **latest-generation** type relationships
(`/type/{name}` `damage_relations`, or `past_damage_relations` only if a
historical query is explicitly requested). Critical correctness cases (e.g.
Flying is **immune** to Ground — 0×, not merely resisted) come straight from
this data and must be represented as immunities, not weaknesses.

---

## DS-5 — In-Session Conversation History

- **Purpose:** Multi-turn refinement and follow-ups (US-10): the current
  candidate set, the Pokémon/topic under discussion.
- **Retrieval pattern:** **Pre-supplied in the model context** each turn by
  orchestration (the running message list). The agent doesn't fetch it.
- **Freshness:** Live within the session.
- **Size:** Bounded by session length; trim oldest turns if it approaches the
  context budget.
- **Access control / persistence:** In-session only (D9); discarded on
  reload/close. No storage, no PII.
- **Failure behavior:** N/A — if history is empty (first turn), the agent treats
  the message as a fresh question.
