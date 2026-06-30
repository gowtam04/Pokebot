import { defineConfig } from "drizzle-kit";

// Loaded by the drizzle-kit CLI via its own TS loader, so it must NOT import
// src/env.ts (that would require ANTHROPIC_API_KEY just to generate a
// migration). Read DATABASE_URL directly with a sane local default that matches
// the docker-compose `db` service.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/data/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://oak:oak@localhost:5432/oak",
  },
});
