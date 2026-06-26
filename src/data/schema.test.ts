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
  ingest_meta,
  learnset,
  reference_cache,
  searchable_names,
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
  it("creates all 5 tables", async () => {
    const tables = await tableNames(db);
    expect(tables).toEqual(
      expect.arrayContaining([
        "ingest_meta",
        "learnset",
        "pokemon",
        "reference_cache",
        "searchable_names",
      ]),
    );
    // Exactly 5 user tables (no extras).
    expect(tables).toHaveLength(5);
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

  it("pokemon table has the correct 23 columns (incl. format)", async () => {
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
        "generation",
        "is_gen9_native",
        "source_generation",
      ]),
    );
    expect(cols).toHaveLength(23);
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
