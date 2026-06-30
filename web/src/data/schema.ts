/**
 * Drizzle ORM table definitions for Oak's Postgres store.
 *
 * The five Pokédex-index tables (design.md § Data Model) each carry a `format`
 * discriminator ("scarlet-violet" | "champions") so one physical schema holds
 * both the standard Gen-9 index and the Champions index; repos filter by the
 * active format (derived from the turn's mode). See src/data/formats.ts.
 *
 *   pokemon          — DS-2 Pokédex index, one row per (format, battle form)
 *   learnset         — DS-3 learnset index, PK (pokemon_id, move_slug, format)
 *   reference_cache  — DS-4 reference detail (move/ability/type/evo/item), PK
 *                      (format, resource_key); pre-built per format at ingest
 *   searchable_names — backs resolve_entity (T1, BR-9), PK (format, kind, slug)
 *   ingest_meta      — pipeline bookkeeping, one row PER FORMAT
 *
 * Three further tables back the email-OTP auth layer
 * (docs/features/account-creation, § Data Model). Auth is GLOBAL, so unlike the
 * index tables these are NOT format-scoped (no `format` column):
 *
 *   account          — one row per registered user; UNIQUE normalized email
 *   auth_session     — one row per active device session; UNIQUE token_hash
 *   otp_code         — at most one active code per email (upsert by email PK)
 *
 * Postgres type notes (vs. the old SQLite schema):
 *   - `integer` is int4 — fine for dex numbers, stats, counts, and the 0/1
 *     `is_gen9_native` flag.
 *   - `fetched_at` / `last_success_at` hold epoch MILLISECONDS (~1.75e12) which
 *     overflow int4, so they are `bigint` with `mode: "number"` (safe < 2^53).
 *   - `payload` stays TEXT (a JSON string written/read with JSON.stringify/parse).
 *
 * Import only from here — never duplicate column defs elsewhere.
 */

import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// pokemon — DS-2 Pokédex index (one row per (format, battle-relevant form), D8)
// ---------------------------------------------------------------------------
export const pokemon = pgTable(
  "pokemon",
  {
    /** Data scope: "scarlet-violet" | "champions". Part of the composite PK. */
    format: text("format").notNull(),
    /** PokeAPI-style pokemon slug, e.g. "tauros-paldea-aqua". */
    id: text("id").notNull(),
    /** e.g. "tauros" */
    species_name: text("species_name").notNull(),
    /** e.g. "paldea-aqua"; null for the base form. */
    form_name: text("form_name"),
    /** Disambiguating human label, e.g. "Tauros (Paldean Aqua)". */
    display_name: text("display_name").notNull(),
    national_dex_number: integer("national_dex_number").notNull(),
    /** One of the 18 canonical type slugs. */
    type1: text("type1").notNull(),
    /** Null for mono-type Pokémon. */
    type2: text("type2"),
    ability_slot1: text("ability_slot1").notNull(),
    ability_slot2: text("ability_slot2"),
    ability_hidden: text("ability_hidden"),
    stat_hp: integer("stat_hp").notNull(),
    stat_attack: integer("stat_attack").notNull(),
    stat_defense: integer("stat_defense").notNull(),
    stat_special_attack: integer("stat_special_attack").notNull(),
    stat_special_defense: integer("stat_special_defense").notNull(),
    stat_speed: integer("stat_speed").notNull(),
    /** Precomputed sum of all six base stats (for BST sort/threshold queries). */
    base_stat_total: integer("base_stat_total").notNull(),
    sprite_url: text("sprite_url").notNull(),
    artwork_url: text("artwork_url").notNull(),
    /** e.g. "gen-9" (standard) / "champions". */
    generation: text("generation").notNull(),
    /**
     * 1 if native to this format's game, 0 if included as an earlier-gen
     * fallback (BR-1). In Champions every indexed row is legal ⇒ always 1.
     */
    is_gen9_native: integer("is_gen9_native").notNull(),
    /** Set when is_gen9_native = 0 (BR-1), e.g. "gen-8"; null otherwise. */
    source_generation: text("source_generation"),
  },
  (t) => [
    // Same national-dex slug exists in both formats → format is part of the PK.
    primaryKey({ columns: [t.format, t.id] }),
    // national dex sort / lookup
    index("pokemon_national_dex_number_idx").on(t.national_dex_number),
    // type filters (US-2)
    index("pokemon_type1_idx").on(t.type1),
    index("pokemon_type2_idx").on(t.type2),
    // individual stat threshold / superlative queries (AC-3.x)
    index("pokemon_stat_hp_idx").on(t.stat_hp),
    index("pokemon_stat_attack_idx").on(t.stat_attack),
    index("pokemon_stat_defense_idx").on(t.stat_defense),
    index("pokemon_stat_special_attack_idx").on(t.stat_special_attack),
    index("pokemon_stat_special_defense_idx").on(t.stat_special_defense),
    index("pokemon_stat_speed_idx").on(t.stat_speed),
    index("pokemon_base_stat_total_idx").on(t.base_stat_total),
  ],
);

// ---------------------------------------------------------------------------
// learnset — DS-3 learnset index (D6, BR-2)
// ---------------------------------------------------------------------------
export const learnset = pgTable(
  "learnset",
  {
    /** FK → pokemon.id (within the same format). */
    pokemon_id: text("pokemon_id").notNull(),
    /** Canonical move slug, e.g. "will-o-wisp". */
    move_slug: text("move_slug").notNull(),
    /** Data scope: "scarlet-violet" | "champions". Part of the composite PK. */
    format: text("format").notNull(),
    /** "level-up" | "machine" | "tutor". Egg moves excluded (out of scope). */
    method: text("method"),
  },
  (t) => [
    // Composite PK — (pokemon_id, move_slug, format)
    primaryKey({ columns: [t.pokemon_id, t.move_slug, t.format] }),
    // "what Pokémon learn move X?" — move_slug not the leftmost PK prefix
    index("learnset_move_slug_idx").on(t.move_slug),
    // lookup all moves for a given pokemon — redundant with PK prefix but
    // provides an explicit fast path and makes intent clear
    index("learnset_pokemon_id_idx").on(t.pokemon_id),
  ],
);

// ---------------------------------------------------------------------------
// reference_cache — DS-4 reference detail (pre-built per format at ingest)
// ---------------------------------------------------------------------------
export const reference_cache = pgTable(
  "reference_cache",
  {
    /** Data scope: "scarlet-violet" | "champions". Part of the composite PK. */
    format: text("format").notNull(),
    /** e.g. "move/fake-out", "ability/armor-tail", "type/ground". */
    resource_key: text("resource_key").notNull(),
    /** "move" | "ability" | "type" | "evolution" | "item". */
    resource_kind: text("resource_kind").notNull(),
    /** Normalized detail shape the tool returns (JSON string, not raw source). */
    payload: text("payload").notNull(),
    /** Source label for citations (e.g. "@pkmn/dex (Pokémon Showdown)"). */
    endpoint_url: text("endpoint_url").notNull(),
    /** Epoch milliseconds the row was built (informational; no TTL anymore). */
    fetched_at: bigint("fetched_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.format, t.resource_key] })],
);

// ---------------------------------------------------------------------------
// searchable_names — backs resolve_entity (T1, BR-9)
// ---------------------------------------------------------------------------
export const searchable_names = pgTable(
  "searchable_names",
  {
    /** Data scope: "scarlet-violet" | "champions". Part of the composite PK. */
    format: text("format").notNull(),
    /** "pokemon" | "move" | "ability" | "type" | "item". */
    kind: text("kind").notNull(),
    /** Canonical slug. */
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
  },
  (t) => [
    // Composite PK — (format, kind, slug)
    primaryKey({ columns: [t.format, t.kind, t.slug] }),
  ],
);

// ---------------------------------------------------------------------------
// ingest_meta — pipeline bookkeeping (one row per format)
// ---------------------------------------------------------------------------
export const ingest_meta = pgTable("ingest_meta", {
  /** Data scope this row describes ("scarlet-violet" | "champions"). PK. */
  format: text("format").primaryKey(),
  /** Epoch ms of the last successful ingest run for this format. */
  last_success_at: bigint("last_success_at", { mode: "number" }).notNull(),
  /** Number of rows in the pokemon table for this format after ingest. */
  pokemon_count: integer("pokemon_count").notNull(),
  /** Number of rows in the learnset table for this format after ingest. */
  learnset_count: integer("learnset_count").notNull(),
  /** Number of rows in searchable_names for this format after ingest. */
  names_count: integer("names_count").notNull(),
  /**
   * Bumped when the physical schema changes; the app checks this at startup
   * to detect a stale/empty index and return index_unavailable gracefully.
   */
  schema_version: text("schema_version").notNull(),
});

// ===========================================================================
// Auth layer (docs/features/account-creation § Data Model)
//
// GLOBAL, NOT format-scoped — auth identity is orthogonal to the Pokédex index,
// so these three tables carry no `format` column. Epoch-ms timestamps are
// `bigint` with mode "number" (int4 overflows ~1.75e12), matching the
// fetched_at / last_success_at convention above.
// ===========================================================================

// ---------------------------------------------------------------------------
// account — one row per registered user (BR-A1: exactly one account per email)
// ---------------------------------------------------------------------------
export const account = pgTable(
  "account",
  {
    /** UUID (crypto.randomUUID()). */
    id: text("id").primaryKey(),
    /** Normalized (trim + lowercase) email — the account identity. UNIQUE. */
    email: text("email").notNull(),
    /** Epoch milliseconds the account was created. */
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // Unique normalized email enforces BR-A1 ("exactly one account per email")
    // and powers the login/find-or-create lookup (BR-A2). PII: email is the
    // only identity field stored.
    uniqueIndex("account_email_idx").on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// auth_session — one row per active device session (BR-A7, AC-4.3)
// ---------------------------------------------------------------------------
export const auth_session = pgTable(
  "auth_session",
  {
    /** UUID. */
    id: text("id").primaryKey(),
    /**
     * SHA-256 hex of the opaque cookie token. The raw token is NEVER stored
     * (BR-A2 / security) — only its hash, which is what resolve-on-request
     * looks up. UNIQUE.
     */
    token_hash: text("token_hash").notNull(),
    /**
     * Logical FK → account.id (a session always belongs to a real account,
     * BR-A9). Modeled as a plain indexed column — NOT a physical FK constraint —
     * matching this schema's existing convention (cf. learnset.pokemon_id →
     * pokemon.id, also a logical-only FK). Referential integrity is enforced in
     * the auth repo/service layer; the index below backs revoke/enumerate.
     */
    account_id: text("account_id").notNull(),
    /** Epoch ms the session was issued. */
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    /** Epoch ms (created_at + 30 days, BR-A7); a row past this reads as absent. */
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // Resolve-on-request: every authenticated call looks up by token_hash.
    uniqueIndex("auth_session_token_hash_idx").on(t.token_hash),
    // Enumerate / revoke a single account's sessions (future multi-device work).
    index("auth_session_account_id_idx").on(t.account_id),
    // Lazy expired-session cleanup sweep (deleteExpiredSessions).
    index("auth_session_expires_at_idx").on(t.expires_at),
  ],
);

// ---------------------------------------------------------------------------
// otp_code — at most one active code per email; `email` PK ⇒ issuing a new code
// is an upsert that supersedes the prior row (BR-A5: only the latest code valid)
// ---------------------------------------------------------------------------
export const otp_code = pgTable("otp_code", {
  /**
   * Normalized email. PK (not an FK — a code can exist before its account does,
   * on first signup). Upsert-by-email overwrites the prior row, so only the most
   * recent code is ever valid (BR-A5).
   */
  email: text("email").primaryKey(),
  /**
   * HMAC-SHA256(AUTH_SECRET, `${email}:${code}`) hex. The 6-digit plaintext is
   * never stored/logged; the HMAC secret defeats precomputation of the 10⁶
   * possible codes from a DB leak.
   */
  code_hash: text("code_hash").notNull(),
  /** Epoch ms the code was issued; drives the resend cooldown (BR-A5). */
  created_at: bigint("created_at", { mode: "number" }).notNull(),
  /** Epoch ms (created_at + ~10 min, BR-A3); an expired code cannot authenticate. */
  expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  /** Wrong-attempt counter; the code locks out at 5 (BR-A4). */
  attempts: integer("attempts").notNull(),
  /** Epoch ms of successful verify → single-use (BR-A3). Null until consumed. */
  consumed_at: bigint("consumed_at", { mode: "number" }),
});

// ===========================================================================
// Chat history (docs/features/chat-history § Data Model)
//
// Durable, account-scoped conversations for signed-in users (B-3). Like the
// auth tables these are GLOBAL (no `format` column) — `format` is a property of
// each conversation, not a partition of the store (BR-H6). Epoch-ms timestamps
// are `bigint` mode "number"; `pinned` is the 0/1 `integer` convention; FKs are
// logical indexed columns, NOT physical constraints (cf. auth_session.account_id),
// so deletes are explicit in the repo (no ON DELETE CASCADE).
// ===========================================================================

// ---------------------------------------------------------------------------
// conversation — one row per saved conversation (HIST-AD-1: id = client session_id)
// ---------------------------------------------------------------------------
export const conversation = pgTable(
  "conversation",
  {
    /**
     * The client `session_id` for this conversation (HIST-AD-1) — a
     * client-generated UUID. NEVER trusted alone for isolation; every query
     * also filters by account_id (BR-H1).
     */
    id: text("id").primaryKey(),
    /**
     * Logical FK → account.id; every read/write filters by it (BR-H1 / BR-A9).
     * Plain indexed column, not a physical FK (schema convention).
     */
    account_id: text("account_id").notNull(),
    /** Derived from the first user message; renamable (BR-H7). */
    title: text("title").notNull(),
    /** "scarlet-violet" | "champions"; fixed for the conversation's life (BR-H6). */
    format: text("format").notNull(),
    /** 0/1; pinned conversations group above the rest (HIST-US-9). */
    pinned: integer("pinned").notNull().default(0),
    /** Epoch ms the conversation was created. */
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    /** Epoch ms of last activity — drives most-recently-active list ordering. */
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // Per-account list query: ORDER BY pinned DESC, updated_at DESC, scoped to
    // account_id. account_id leads so the filter uses the index prefix.
    index("conversation_account_updated_idx").on(t.account_id, t.updated_at),
  ],
);

// ---------------------------------------------------------------------------
// conversation_message — one row per turn (HIST-AD-2)
// ---------------------------------------------------------------------------
export const conversation_message = pgTable(
  "conversation_message",
  {
    /**
     * UUID. For the guest→sign-in import path this is the client `ChatTurn.id`
     * so the import is idempotent (ON CONFLICT (id) DO NOTHING); for the
     * server-authoritative append path the route mints a fresh UUID.
     */
    id: text("id").primaryKey(),
    /** Logical FK → conversation.id. */
    conversation_id: text("conversation_id").notNull(),
    /** Denormalized account.id for isolation-safe queries + delete (BR-H1). */
    account_id: text("account_id").notNull(),
    /** Monotonic order within the conversation (0,1,2,…). */
    seq: integer("seq").notNull(),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    /**
     * Human-visible text: the user message, or the assistant `answer_markdown`.
     * Powers ILIKE search (BR-H11) and the model re-feed (BR-H5) without parsing
     * answer_json. Intentionally denormalized out of answer_json.
     */
    text_content: text("text_content").notNull(),
    /**
     * Full `OakAnswer` JSON (assistant rows only; NULL for user rows) —
     * powers exact re-render (BR-H3). TEXT JSON, like reference_cache.payload.
     */
    answer_json: text("answer_json"),
    /** Epoch ms the turn was stored. */
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // Ordered load AND the seq-uniqueness backstop: a UNIQUE (conversation_id,
    // seq) turns a concurrent-append race into a clean conflict instead of a
    // silently duplicated seq. appendTurnPair serializes on the conversation row.
    uniqueIndex("message_conversation_seq_idx").on(
      t.conversation_id,
      t.seq,
    ),
    // Isolation / cleanup queries by owning account.
    index("message_account_idx").on(t.account_id),
  ],
);

// ===========================================================================
// Team builder (docs/features/team-builder § Data Model)
//
// Durable, account-scoped competitive teams for signed-in users (B-2). Like the
// auth/chat-history tables this is GLOBAL (no `format` column) — a team's
// `format` is a per-row property fixed for its life (BR-T3), not a partition of
// the store. Epoch-ms timestamps are `bigint` mode "number"; the `members`
// array is stored whole as JSON TEXT (the reference_cache.payload /
// conversation_message.answer_json convention) since teams are always read and
// written as a unit. FKs are logical indexed columns, NOT physical constraints
// (cf. conversation.account_id), so deletes are explicit in the repo. Saved
// teams are referenced by name in chat (resolved live via list_teams/get_team),
// so no other table stores a team id to clear on delete.
// ===========================================================================

// ---------------------------------------------------------------------------
// team — one row per saved team (TEAM-AD-1: members stored as a JSON column)
// ---------------------------------------------------------------------------
export const team = pgTable(
  "team",
  {
    /** UUID (crypto.randomUUID()). */
    id: text("id").primaryKey(),
    /**
     * Logical FK → account.id; every read/write filters by it (BR-T2 / BR-A9).
     * Plain indexed column, not a physical FK (schema convention). A team owned
     * by another account is indistinguishable from missing (404, never 403).
     */
    account_id: text("account_id").notNull(),
    /** "scarlet-violet" | "champions"; fixed for the team's life (BR-T3). */
    format: text("format").notNull(),
    /** User-facing name; non-empty (defaults to "Untitled team", BR-T1/AC-1.2). */
    name: text("name").notNull(),
    /**
     * JSON: TeamMember[] (0–6), validated by `teamMembersSchema`
     * (src/data/teams/team-schema.ts). Stored whole — no cross-member SQL.
     */
    members: text("members").notNull(),
    /** Epoch ms the team was created. */
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    /** Epoch ms of last edit — drives list ordering (ORDER BY updated_at DESC). */
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // Per-account list query: ORDER BY updated_at DESC scoped to account_id.
    // account_id leads so the filter uses the index prefix; format is filtered
    // in the query (tiny N per account).
    index("team_account_updated_idx").on(t.account_id, t.updated_at),
  ],
);
