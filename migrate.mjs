// migrate.mjs — apply committed Drizzle migrations against DATABASE_URL.
//
// Plain ESM: no TypeScript, no `@/` alias, no src/env.ts (so no ANTHROPIC_API_KEY
// / AUTH_SECRET needed). drizzle-orm + pg are already present in the standalone
// node_modules (traced via src/data/db.ts). This runs inside the tool-less runtime
// image as the Fly `release_command` (see fly.toml [deploy]); a non-zero exit
// aborts the deploy. Idempotent — drizzle tracks applied hashes in
// `__drizzle_migrations`.
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "drizzle",
);

const pool = new pg.Pool({ connectionString });
try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log(`[migrate] migrations applied from ${migrationsFolder}`);
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
