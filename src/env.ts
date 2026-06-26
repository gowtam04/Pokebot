import { z } from "zod";

/**
 * Zod-validated process.env (design.md § File Structure: src/env.ts).
 *
 * The schema REJECTS a missing/empty ANTHROPIC_API_KEY — a single source of
 * truth for required configuration. Everything else has a sensible default so
 * the app and the ingest/eval scripts run with only the API key supplied.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z
    .string({ required_error: "ANTHROPIC_API_KEY is required" })
    .min(1, "ANTHROPIC_API_KEY must not be empty"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://pokebot:pokebot@localhost:5432/pokebot"),
  POKEAPI_BASE_URL: z.string().url().default("https://pokeapi.co/api/v2"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate an env source. Throws a descriptive Error listing every
 * invalid/missing variable. Exposed (separately from the eager `env`) so it can
 * be unit-tested without crashing the test process at import time.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * The validated environment, parsed once at module load. Importing this module
 * with a missing ANTHROPIC_API_KEY throws immediately (fail fast on boot).
 */
export const env: Env = parseEnv();
