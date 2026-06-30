/**
 * Tests for src/data/schema.ts — Phase 2 schema / migration unit tests (Postgres).
 *
 * Success criteria (design.md Phase 2, adapted to Postgres):
 *   1. The migration creates all 5 tables + all expected indexes + the composite
 *      primary keys on a fresh schema (introspected via the Postgres catalogs).
 *   2. EXPLAIN confirms stat/type/move-slug queries CAN use their indexes — with
 *      enable_seqscan off (so the planner doesn't seq-scan the tiny fixture),
 *      each query plan names its index rather than a Seq Scan.
 *   3. Composite-PK constraints are enforced (duplicate keys rejected; the same
 *      key across two formats allowed) and ingest_meta upserts cleanly.
 *
 * Runs against a fresh, migrated Postgres schema (Testcontainers). The committed
 * drizzle/ migration is applied by createPgSchema, so the test exercises the
 * exact deployed schema.
 */

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  account,
  auth_session,
  ingest_meta,
  learnset,
  otp_code,
  reference_cache,
  searchable_names,
  team,
} from "@/data/schema";

import { createPgSchema, type PgFixture, type PgDb } from "../../test/support/pg";

// ---------------------------------------------------------------------------
// Catalog-introspection helpers (scoped to the fixture's current_schema())
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

async function rows(db: PgDb, query: string): Promise<Row[]> {
  const res = (await db.execute(sql.raw(query))) as unknown as { rows: Row[] };
  return res.rows;
}

/** User table names in the fixture schema (excluding drizzle's bookkeeping). */
async function tableNames(db: PgDb): Promise<string[]> {
  const r = await rows(
    db,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return r
    .map((x) => x.table_name as string)
    .filter((n) => n !== "__drizzle_migrations");
}

async function columnNames(db: PgDb, table: string): Promise<string[]> {
  const r = await rows(
    db,
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = '${table}'
      ORDER BY ordinal_position`,
  );
  return r.map((x) => x.column_name as string);
}

/** Index names in the fixture schema (includes PK-backing indexes). */
async function indexNames(db: PgDb): Promise<string[]> {
  const r = await rows(
    db,
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  return r.map((x) => x.indexname as string);
}

/** Ordered primary-key column names for a table in the fixture schema. */
async function pkColumns(db: PgDb, table: string): Promise<string[]> {
  const r = await rows(
    db,
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a
         ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = (current_schema() || '.${table}')::regclass
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
  );
  return r.map((x) => x.name as string);
}

/**
 * EXPLAIN the query with sequential scans disabled (forcing the planner to use
 * an applicable index), returning the plan text. SET LOCAL + EXPLAIN run in one
 * transaction so they share a single pooled connection.
 */
async function explainNoSeqscan(db: PgDb, query: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
    const res = (await tx.execute(
      sql.raw(`EXPLAIN ${query}`),
    )) as unknown as { rows: Row[] };
    return res.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
  });
}

// ---------------------------------------------------------------------------
// Shared read-only fixture (schema introspection + EXPLAIN over a tiny seed)
// ---------------------------------------------------------------------------

let sharedFix: PgFixture;
let db: PgDb;

beforeAll(async () => {
  sharedFix = await createPgSchema({ seed: "none" });
  db = sharedFix.db;

  // Two rows: Garchomp (dual-type) and Tauros (mono-type, for the type2 test).
  await db.execute(
    sql.raw(`
      INSERT INTO pokemon
        (format, id, species_name, form_name, display_name, national_dex_number,
         type1, type2, ability_slot1, ability_slot2, ability_hidden,
         stat_hp, stat_attack, stat_defense,
         stat_special_attack, stat_special_defense, stat_speed,
         base_stat_total, sprite_url, artwork_url,
         generation, is_gen9_native, source_generation)
      VALUES
        ('scarlet-violet', 'garchomp', 'garchomp', NULL, 'Garchomp', 445,
         'dragon', 'ground', 'sand-veil', NULL, 'rough-skin',
         108, 130, 95, 80, 85, 102,
         600, 'https://sprites.example/445.png', 'https://art.example/445.png',
         'gen-9', 1, NULL),
        ('scarlet-violet', 'tauros', 'tauros', NULL, 'Tauros', 128,
         'normal', NULL, 'intimidate', 'anger-point', 'sheer-force',
         75, 100, 95, 40, 70, 110,
         490, 'https://sprites.example/128.png', 'https://art.example/128.png',
         'gen-9', 1, NULL)`),
  );
  await db.execute(
    sql.raw(`INSERT INTO learnset (pokemon_id, move_slug, format, method)
             VALUES ('garchomp', 'dragon-claw', 'scarlet-violet', 'machine')`),
  );
}, 60_000);

afterAll(async () => {
  await sharedFix?.cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Drizzle migration — table creation", () => {
  it("creates all 11 tables (5 Pokédex index + 3 auth + 2 chat-history + 1 team)", async () => {
    const tables = await tableNames(db);
    expect(tables).toEqual(
      expect.arrayContaining([
        // Pokédex index tables (format-scoped)
        "ingest_meta",
        "learnset",
        "pokemon",
        "reference_cache",
        "searchable_names",
        // Auth tables (account-creation, NOT format-scoped) — added by the
        // 0001 migration, applied to every fresh Testcontainers schema.
        "account",
        "auth_session",
        "otp_code",
        // Chat-history tables (account-scoped) — added by the 0002 migration.
        "conversation",
        "conversation_message",
        // Team builder (account-scoped) — added by the 0003 migration.
        "team",
      ]),
    );
    // Exactly 11 user tables (5 index + 3 auth + 2 chat-history + 1 team).
    expect(tables).toHaveLength(11);
  });

  it("migration creates the 2 chat-history tables with the correct columns, PKs, and indexes", async () => {
    expect(await columnNames(db, "conversation")).toEqual(
      expect.arrayContaining([
        "id",
        "account_id",
        "title",
        "format",
        "pinned",
        "created_at",
        "updated_at",
      ]),
    );
    // The 0003 team-builder `active_team_id` column was dropped in 0004 (saved
    // teams are now referenced by name in chat, not bound to a conversation).
    expect(await columnNames(db, "conversation")).not.toContain("active_team_id");
    expect(await columnNames(db, "conversation")).toHaveLength(7);
    expect(await pkColumns(db, "conversation")).toEqual(["id"]);

    expect(await columnNames(db, "conversation_message")).toEqual(
      expect.arrayContaining([
        "id",
        "conversation_id",
        "account_id",
        "seq",
        "role",
        "text_content",
        "answer_json",
        "created_at",
      ]),
    );
    expect(await columnNames(db, "conversation_message")).toHaveLength(8);
    expect(await pkColumns(db, "conversation_message")).toEqual(["id"]);

    const indexes = await indexNames(db);
    expect(indexes).toContain("conversation_account_updated_idx");
    expect(indexes).toContain("message_conversation_seq_idx"); // UNIQUE (seq backstop)
    expect(indexes).toContain("message_account_idx");
  });

  it("migration creates the 3 auth tables with the correct columns + PKs", async () => {
    // migration_applies_auth_tables: account / auth_session / otp_code exist on
    // a fresh schema with the exact columns and primary keys from § Data Model.
    expect(await columnNames(db, "account")).toEqual(
      expect.arrayContaining(["id", "email", "created_at"]),
    );
    expect(await columnNames(db, "account")).toHaveLength(3);
    expect(await pkColumns(db, "account")).toEqual(["id"]);

    expect(await columnNames(db, "auth_session")).toEqual(
      expect.arrayContaining([
        "id",
        "token_hash",
        "account_id",
        "created_at",
        "expires_at",
      ]),
    );
    expect(await columnNames(db, "auth_session")).toHaveLength(5);
    expect(await pkColumns(db, "auth_session")).toEqual(["id"]);

    expect(await columnNames(db, "otp_code")).toEqual(
      expect.arrayContaining([
        "email",
        "code_hash",
        "created_at",
        "expires_at",
        "attempts",
        "consumed_at",
      ]),
    );
    expect(await columnNames(db, "otp_code")).toHaveLength(6);
    // BR-A5: email is the PK so a fresh code upserts/supersedes the prior row.
    expect(await pkColumns(db, "otp_code")).toEqual(["email"]);
  });

  it("creates the auth unique indexes (account.email, auth_session.token_hash)", async () => {
    const indexes = await indexNames(db);
    expect(indexes).toContain("account_email_idx");
    expect(indexes).toContain("auth_session_token_hash_idx");
    expect(indexes).toContain("auth_session_account_id_idx");
    expect(indexes).toContain("auth_session_expires_at_idx");
  });

  it("creates all expected indexes", async () => {
    const indexes = await indexNames(db);

    const statIndexes = [
      "pokemon_stat_hp_idx",
      "pokemon_stat_attack_idx",
      "pokemon_stat_defense_idx",
      "pokemon_stat_special_attack_idx",
      "pokemon_stat_special_defense_idx",
      "pokemon_stat_speed_idx",
      "pokemon_base_stat_total_idx",
    ];
    const otherPokemonIndexes = [
      "pokemon_national_dex_number_idx",
      "pokemon_type1_idx",
      "pokemon_type2_idx",
    ];
    const learnsetIndexes = ["learnset_move_slug_idx", "learnset_pokemon_id_idx"];

    for (const idx of [
      ...statIndexes,
      ...otherPokemonIndexes,
      ...learnsetIndexes,
    ]) {
      expect(indexes, `Expected index "${idx}" to be present`).toContain(idx);
    }
  });

  it("pokemon table has the correct 24 columns (incl. format)", async () => {
    const cols = await columnNames(db, "pokemon");
    expect(cols).toEqual(
      expect.arrayContaining([
        "format",
        "id",
        "species_name",
        "form_name",
        "display_name",
        "national_dex_number",
        "type1",
        "type2",
        "ability_slot1",
        "ability_slot2",
        "ability_hidden",
        "stat_hp",
        "stat_attack",
        "stat_defense",
        "stat_special_attack",
        "stat_special_defense",
        "stat_speed",
        "base_stat_total",
        "sprite_url",
        "artwork_url",
        "required_item",
        "generation",
        "is_gen9_native",
        "source_generation",
      ]),
    );
    expect(cols).toHaveLength(24);
  });

  it("pokemon table has composite PK on (format, id)", async () => {
    expect(await pkColumns(db, "pokemon")).toEqual(["format", "id"]);
  });

  it("learnset table has composite PK on (pokemon_id, move_slug, format)", async () => {
    expect(await pkColumns(db, "learnset")).toEqual([
      "pokemon_id",
      "move_slug",
      "format",
    ]);
  });

  it("searchable_names table has composite PK on (format, kind, slug)", async () => {
    expect(await pkColumns(db, "searchable_names")).toEqual([
      "format",
      "kind",
      "slug",
    ]);
  });

  it("reference_cache has 6 columns and PK (format, resource_key)", async () => {
    const cols = await columnNames(db, "reference_cache");
    expect(cols).toEqual(
      expect.arrayContaining([
        "format",
        "resource_key",
        "resource_kind",
        "payload",
        "endpoint_url",
        "fetched_at",
      ]),
    );
    expect(cols).toHaveLength(6);
    expect(await pkColumns(db, "reference_cache")).toEqual([
      "format",
      "resource_key",
    ]);
  });

  it("ingest_meta has 6 columns, keyed by format", async () => {
    const cols = await columnNames(db, "ingest_meta");
    expect(cols).toEqual(
      expect.arrayContaining([
        "format",
        "last_success_at",
        "pokemon_count",
        "learnset_count",
        "names_count",
        "schema_version",
      ]),
    );
    expect(cols).toHaveLength(6);
    expect(await pkColumns(db, "ingest_meta")).toEqual(["format"]);
  });

  it("migration creates the team table with the correct columns, PK, and index", async () => {
    expect(await columnNames(db, "team")).toEqual(
      expect.arrayContaining([
        "id",
        "account_id",
        "format",
        "name",
        "members",
        "created_at",
        "updated_at",
      ]),
    );
    expect(await columnNames(db, "team")).toHaveLength(7);
    expect(await pkColumns(db, "team")).toEqual(["id"]);

    const indexes = await indexNames(db);
    // Backs the per-account list (ORDER BY updated_at DESC, scoped by account_id).
    expect(indexes).toContain("team_account_updated_idx");
  });
});

// ---------------------------------------------------------------------------
// EXPLAIN — indexes are usable (with sequential scans disabled)
// ---------------------------------------------------------------------------

describe("EXPLAIN — indexes are used (enable_seqscan off)", () => {
  it("stat_attack > N uses pokemon_stat_attack_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE stat_attack > 100",
    );
    expect(plan).toContain("pokemon_stat_attack_idx");
  });

  it("stat_speed > N uses pokemon_stat_speed_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE stat_speed > 90",
    );
    expect(plan).toContain("pokemon_stat_speed_idx");
  });

  it("stat_hp <= N uses pokemon_stat_hp_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE stat_hp <= 100",
    );
    expect(plan).toContain("pokemon_stat_hp_idx");
  });

  it("base_stat_total >= N uses pokemon_base_stat_total_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE base_stat_total >= 600",
    );
    expect(plan).toContain("pokemon_base_stat_total_idx");
  });

  it("type1 = X uses pokemon_type1_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE type1 = 'dragon'",
    );
    expect(plan).toContain("pokemon_type1_idx");
  });

  it("type2 = X uses pokemon_type2_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE type2 = 'ground'",
    );
    expect(plan).toContain("pokemon_type2_idx");
  });

  it("learnset WHERE move_slug = X uses learnset_move_slug_idx", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT pokemon_id FROM learnset WHERE move_slug = 'dragon-claw'",
    );
    expect(plan).toContain("learnset_move_slug_idx");
  });

  it("learnset multi-move intersection (GROUP BY … HAVING) uses move_slug index", async () => {
    // Mirrors the BR-7 pattern in learnset-repo.ts.
    const plan = await explainNoSeqscan(
      db,
      `SELECT pokemon_id
         FROM learnset
        WHERE move_slug IN ('dragon-claw', 'earthquake')
          AND format IN ('scarlet-violet')
        GROUP BY pokemon_id
       HAVING COUNT(DISTINCT move_slug) = 2`,
    );
    expect(plan).toContain("learnset_move_slug_idx");
  });

  it("stat filter queries use an Index Scan, not a Seq Scan", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE stat_special_attack > 70",
    );
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toContain("Seq Scan");
  });

  it("type filter queries use an Index Scan, not a Seq Scan", async () => {
    const plan = await explainNoSeqscan(
      db,
      "SELECT id FROM pokemon WHERE type1 = 'fire'",
    );
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toContain("Seq Scan");
  });
});

// ---------------------------------------------------------------------------
// Constraints — composite PKs + upsert (fresh schema per test, they mutate)
// ---------------------------------------------------------------------------

describe("Schema constraints", () => {
  let cfix: PgFixture;
  let cdb: PgDb;

  beforeEach(async () => {
    cfix = await createPgSchema({ seed: "none" });
    cdb = cfix.db;
  }, 60_000);

  afterEach(async () => {
    await cfix?.cleanup();
  });

  it("learnset composite PK rejects duplicate (pokemon_id, move_slug, format)", async () => {
    await cdb
      .insert(learnset)
      .values({ pokemon_id: "bulbasaur", move_slug: "tackle", format: "scarlet-violet", method: "level-up" });

    await expect(
      cdb
        .insert(learnset)
        .values({ pokemon_id: "bulbasaur", move_slug: "tackle", format: "scarlet-violet", method: "machine" }),
    ).rejects.toThrow();
  });

  it("learnset allows the same (pokemon_id, move_slug) across two formats", async () => {
    await cdb
      .insert(learnset)
      .values({ pokemon_id: "bulbasaur", move_slug: "tackle", format: "scarlet-violet", method: "level-up" });
    await expect(
      cdb
        .insert(learnset)
        .values({ pokemon_id: "bulbasaur", move_slug: "tackle", format: "champions", method: "level-up" }),
    ).resolves.toBeDefined();
  });

  it("searchable_names composite PK rejects duplicate (format, kind, slug)", async () => {
    await cdb
      .insert(searchable_names)
      .values({ format: "scarlet-violet", kind: "pokemon", slug: "bulbasaur", display_name: "Bulbasaur" });

    await expect(
      cdb
        .insert(searchable_names)
        .values({ format: "scarlet-violet", kind: "pokemon", slug: "bulbasaur", display_name: "Bulbasaur Again" }),
    ).rejects.toThrow();
  });

  it("reference_cache (format, resource_key) PK rejects duplicate keys", async () => {
    await cdb.insert(reference_cache).values({
      format: "scarlet-violet",
      resource_key: "move/tackle",
      resource_kind: "move",
      payload: "{}",
      endpoint_url: "src",
      fetched_at: 1_700_000_000_000,
    });

    await expect(
      cdb.insert(reference_cache).values({
        format: "scarlet-violet",
        resource_key: "move/tackle",
        resource_kind: "move",
        payload: "{}",
        endpoint_url: "src",
        fetched_at: 1_700_000_000_001,
      }),
    ).rejects.toThrow();
  });

  it("account UNIQUE email rejects a duplicate normalized email (BR-A1)", async () => {
    // BR-A1: exactly one account per normalized email — the unique index on
    // account.email enforces it, so a second insert of the same email rejects.
    await cdb.insert(account).values({
      id: "acct-1",
      email: "ash@example.com",
      created_at: 1_700_000_000_000,
    });

    await expect(
      cdb.insert(account).values({
        id: "acct-2",
        email: "ash@example.com",
        created_at: 1_700_000_000_001,
      }),
    ).rejects.toThrow();
  });

  it("auth_session UNIQUE token_hash rejects a duplicate token hash", async () => {
    // resolve-on-request looks a session up by token_hash, so the column is
    // UNIQUE — two rows with the same hash are rejected.
    await cdb.insert(auth_session).values({
      id: "sess-1",
      token_hash: "deadbeef",
      account_id: "acct-1",
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_000_000 + 30 * 24 * 60 * 60_000,
    });

    await expect(
      cdb.insert(auth_session).values({
        id: "sess-2",
        token_hash: "deadbeef",
        account_id: "acct-2",
        created_at: 1_700_000_000_001,
        expires_at: 1_700_000_000_001 + 30 * 24 * 60 * 60_000,
      }),
    ).rejects.toThrow();
  });

  it("otp_code PK(email) rejects a duplicate insert; upsert supersedes (BR-A5)", async () => {
    // email is the PK: a raw second insert for the same email is rejected...
    await cdb.insert(otp_code).values({
      email: "ash@example.com",
      code_hash: "hash-one",
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_000_000 + 10 * 60_000,
      attempts: 3,
      consumed_at: null,
    });

    await expect(
      cdb.insert(otp_code).values({
        email: "ash@example.com",
        code_hash: "hash-two",
        created_at: 1_700_000_000_500,
        expires_at: 1_700_000_000_500 + 10 * 60_000,
        attempts: 0,
        consumed_at: null,
      }),
    ).rejects.toThrow();

    // ...but issuing a new code is an upsert-by-email that supersedes the prior
    // row (resets attempts/consumed_at), so only the latest code is ever valid.
    await cdb
      .insert(otp_code)
      .values({
        email: "ash@example.com",
        code_hash: "hash-two",
        created_at: 1_700_000_000_500,
        expires_at: 1_700_000_000_500 + 10 * 60_000,
        attempts: 0,
        consumed_at: null,
      })
      .onConflictDoUpdate({
        target: otp_code.email,
        set: {
          code_hash: "hash-two",
          created_at: 1_700_000_000_500,
          expires_at: 1_700_000_000_500 + 10 * 60_000,
          attempts: 0,
          consumed_at: null,
        },
      });

    const rows = await cdb.select().from(otp_code);
    expect(rows).toHaveLength(1);
    const row = rows.find((r) => r.email === "ash@example.com");
    expect(row).toBeDefined();
    expect(row!.code_hash).toBe("hash-two");
    expect(row!.attempts).toBe(0);
  });

  it("team row round-trips the JSON members column and orders by updated_at", async () => {
    const members = JSON.stringify([
      { species: "garchomp", moves: ["earthquake"], level: 50 },
    ]);
    await cdb.insert(team).values({
      id: "team-1",
      account_id: "acct-1",
      format: "scarlet-violet",
      name: "Untitled team",
      members,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    });

    const rows = await cdb.select().from(team);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.members).toBe(members);
    // bigint mode:"number" reads back as a JS number, not a string.
    expect(rows[0]!.updated_at).toBe(1_700_000_000_000);
    expect(JSON.parse(rows[0]!.members)).toEqual([
      { species: "garchomp", moves: ["earthquake"], level: 50 },
    ]);
  });

  it("team.account_id is a logical (not physical) FK — no constraint blocks an unknown account", async () => {
    // Matches the schema's logical-FK convention (isolation is enforced in the
    // repo, BR-T2). Inserting a team for an account row that does not exist must
    // NOT be rejected by a physical FK constraint.
    await expect(
      cdb.insert(team).values({
        id: "team-2",
        account_id: "ghost-account",
        format: "champions",
        name: "Ghost team",
        members: "[]",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      }),
    ).resolves.toBeDefined();
  });

  it("ingest_meta per-format row can be UPSERTED without error", async () => {
    const upsert = (lastSuccessAt: number, pokemonCount: number) =>
      cdb
        .insert(ingest_meta)
        .values({
          format: "scarlet-violet",
          last_success_at: lastSuccessAt,
          pokemon_count: pokemonCount,
          learnset_count: 50000,
          names_count: 3000,
          schema_version: "2",
        })
        .onConflictDoUpdate({
          target: ingest_meta.format,
          set: {
            last_success_at: lastSuccessAt,
            pokemon_count: pokemonCount,
            learnset_count: 50000,
            names_count: 3000,
            schema_version: "2",
          },
        });

    await upsert(1_700_000_000_000, 1300);
    await upsert(1_700_001_000_000, 1302);

    const row = (
      await cdb.select().from(ingest_meta)
    ).find((r) => r.format === "scarlet-violet");
    expect(row).toBeDefined();
    expect(row!.pokemon_count).toBe(1302);
    expect(row!.last_success_at).toBe(1_700_001_000_000);
  });
});
