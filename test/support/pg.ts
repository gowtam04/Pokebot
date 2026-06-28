/**
 * test/support/pg.ts — the shared Postgres test harness.
 *
 * Replaces the old in-memory / on-disk SQLite fixtures. Backed by ONE Postgres
 * container started once per run (test/support/pg-global-setup.ts) and shared by
 * every node-project test file. Isolation is by a unique Postgres SCHEMA per
 * fixture: cheap to create/drop and fully parallel-safe.
 *
 *   - `createPgSchema({ seed })` — make an isolated, migrated (optionally seeded)
 *     schema and return a Drizzle handle + a `DbBundle`-shaped value + cleanup.
 *   - `installAsSingleton(fix)` — install that bundle as the `@/data/db`
 *     singleton (`globalThis.__oakDb`) and reset the resolve-index cache, so
 *     `resolve_entity` (which reads the SINGLETON, not ctx.db) sees this schema.
 *
 * This module does NOT `import "server-only"`; tests that need the tool layer
 * still `vi.mock("server-only")` themselves.
 */

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import * as schema from "@/data/schema";

// The connection URI for the shared container is published by the globalSetup
// via Vitest's `provide`; declare its type for `inject`.
declare module "vitest" {
  interface ProvidedContext {
    PG_CONN_URI: string;
  }
}

/** A Drizzle handle typed over the full Oak schema (node-postgres). */
export type PgDb = NodePgDatabase<typeof schema>;

/** Matches the `DbBundle` shape that `@/data/db` memoizes on globalThis. */
export type PgBundle = { pool: Pool; db: PgDb };

export interface PgFixture {
  bundle: PgBundle;
  /** Convenience alias for `bundle.db`. */
  db: PgDb;
  schemaName: string;
  /** Drop the schema and close this fixture's pool. */
  cleanup: () => Promise<void>;
}

/** Which curated dataset to seed (see the two seed modules). */
export type SeedKind = "none" | "tools" | "eval";

export interface PgFixtureOptions {
  /** Dataset to seed after migrating. Default "none" (migrated but empty). */
  seed?: SeedKind;
  /** Extra rows to insert after seeding (e.g. G4 reference cache). */
  after?: (db: PgDb) => Promise<void>;
}

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

/**
 * The base connection URI for the shared container. Under Vitest it comes from
 * the globalSetup via `inject`; for the `tsx eval` CLI it comes from
 * DATABASE_URL (the dev docker-compose Postgres).
 */
async function resolveBaseUri(): Promise<string> {
  if (process.env.VITEST) {
    const { inject } = await import("vitest");
    return inject("PG_CONN_URI");
  }
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error(
      "createPgSchema: DATABASE_URL is required outside Vitest (point it at a running Postgres).",
    );
  }
  return uri;
}

/**
 * Create an isolated Postgres schema, migrate it, optionally seed it, and return
 * a Drizzle handle bound to it. The pool pins `search_path` to the new schema so
 * the migration's unqualified DDL and all reads/writes land there; the
 * `__drizzle_migrations` bookkeeping is isolated per schema too (no cross-file
 * race on a shared migrations table).
 */
export async function createPgSchema(
  opts: PgFixtureOptions = {},
): Promise<PgFixture> {
  const baseUri = await resolveBaseUri();
  const schemaName = `t_${randomUUID().replace(/-/g, "")}`;

  const pool = new Pool({
    connectionString: baseUri,
    options: `-c search_path=${schemaName},public`,
    max: 4,
  });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  const db = drizzle(pool, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsSchema: schemaName,
  });

  if (opts.seed === "tools") {
    const { seedToolsFixture } = await import("../fixtures/tools-fixture");
    await seedToolsFixture(db);
  } else if (opts.seed === "eval") {
    const { seedFixtureDb } = await import("../../eval/fixtures/seed-fixture-db");
    await seedFixtureDb(db);
  }
  if (opts.after) await opts.after(db);

  return {
    bundle: { pool, db },
    db,
    schemaName,
    cleanup: async () => {
      await pool
        .query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        .catch(() => {});
      await pool.end();
    },
  };
}

/**
 * Install a fixture as the `@/data/db` process singleton so that resolve-index
 * (which imports the singleton `db` directly, NOT ctx.db) and the DB-backed
 * tools all read this schema. MUST run BEFORE `@/data/db` / `@/agent/tools` /
 * `@/agent/runtime` are first imported in the test file (keep those imports
 * dynamic, inside `beforeAll`) so the captured `db` binding is this handle.
 */
export async function installAsSingleton(fix: PgFixture): Promise<void> {
  (globalThis as { __oakDb?: PgBundle }).__oakDb = fix.bundle;
  const { resetResolveIndex } = await import("@/data/repos/resolve-index");
  resetResolveIndex();
}
