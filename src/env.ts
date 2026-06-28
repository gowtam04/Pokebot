import { z } from "zod";

/**
 * Zod-validated process.env (design.md § File Structure: src/env.ts).
 *
 * The schema REJECTS a missing/empty ANTHROPIC_API_KEY — a single source of
 * truth for required configuration. Everything else has a sensible default so
 * the app and the ingest/eval scripts run with only the API key supplied.
 */

/**
 * Insecure placeholder for AUTH_SECRET used in local dev / test only. It is
 * REJECTED in production by the cross-field refinement below — production must
 * supply a strong, explicit secret (account-creation design.md § Secrets, AD-4).
 */
const DEV_AUTH_SECRET = "dev-insecure-auth-secret-change-me";

/** Treat an empty/whitespace-only env var as "unset" (→ undefined). */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const EnvSchema = z
  .object({
    ANTHROPIC_API_KEY: z
      .string({ required_error: "ANTHROPIC_API_KEY is required" })
      .min(1, "ANTHROPIC_API_KEY must not be empty"),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-6"),

    // --- Optional alternate model providers (model switcher) ---------------
    // OpenAI (GPT-5.5) and xAI (Grok 4.3) are OPTIONAL: Claude remains the
    // default and the only required key. A provider's key is validated ON USE
    // (the provider factory throws a typed model_unavailable, surfaced by the
    // route as a clean 503) — NOT at module load — so the app still boots with
    // only ANTHROPIC_API_KEY. An empty value (`OPENAI_API_KEY=` in a compose
    // env_file) is treated as absent, like RESEND_API_KEY below.
    OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    XAI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    // Base URLs. xAI is OpenAI-SDK-compatible; its API lives behind a different
    // host, so it has a sensible default. OpenAI uses the SDK default when unset.
    OPENAI_BASE_URL: z.preprocess(
      emptyToUndefined,
      z.string().url().optional(),
    ),
    XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
    DATABASE_URL: z
      .string()
      .url()
      .default("postgres://oak:oak@localhost:5432/oak"),
    POKEAPI_BASE_URL: z.string().url().default("https://pokeapi.co/api/v2"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // --- Account creation (email + OTP auth) — design.md § Secrets ---------
    // Server secret for HMAC-hashing OTP codes (AD-4) and any other auth
    // signing. A dev default keeps local/test runs zero-config; production is
    // required to override it (enforced by the refinement below).
    AUTH_SECRET: z.string().min(1).default(DEV_AUTH_SECRET),
    // Resend API key. Absent ⇒ the console transport is used (no real mail).
    // An empty value is treated as absent so `RESEND_API_KEY=` in a compose
    // env_file does not crash the app.
    RESEND_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(1).optional(),
    ),
    // From-address for transactional OTP email. The default delivers only to
    // the Resend account owner; a verified domain is needed for real sends.
    EMAIL_FROM: z.string().min(1).default("Oak <onboarding@resend.dev>"),
  })
  .superRefine((value, ctx) => {
    // AUTH_SECRET must be an explicit, non-default secret in production.
    if (
      value.NODE_ENV === "production" &&
      value.AUTH_SECRET === DEV_AUTH_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SECRET"],
        message:
          "AUTH_SECRET must be set to a strong, explicit secret in production",
      });
    }
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
