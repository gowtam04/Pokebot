/**
 * src/data/migrate.ts — `npm run db:migrate`.
 *
 * Applies the committed Drizzle migrations (drizzle/) to the Postgres database
 * named by DATABASE_URL. Idempotent: drizzle tracks applied hashes in
 * `__drizzle_migrations`, so re-running is a no-op.
 *
 * Connection ownership: this runs under `tsx` as its OWN process and does NOT
 * import the `@/data/db` singleton (that module is `server-only` and unusable
 * outside the Next server). It opens its own `pg.Pool`, exactly like the ingest
 * CLI, so the same migrations can be applied from CI / a deploy step / a fresh
 * docker volume before the app or ingest run.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { env } from "@/env";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const MIGRATIONS_DIR = path.resolve(PROJECT_ROOT, "drizzle");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    // eslint-disable-next-line no-console
    console.log(`[db:migrate] migrations applied (${MIGRATIONS_DIR}).`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // eslint-disable-next-line no-console
  console.error("[db:migrate] failed:", detail);
  process.exit(1);
});
