/**
 * Model registry — the single source of truth for the LLMs the app can run on
 * (Grok 4.3 / Claude / GPT-5.5).
 *
 * There is no per-turn picker: the ACTIVE_MODEL secret (validated against this
 * registry in `src/env.ts`) decides which model answers. The registry still
 * exists so the active key maps to a provider + wiring and never gets hardcoded
 * twice.
 *
 * CLIENT-SAFE by design: this module holds ONLY pure constants/mappings and has
 * NO `server-only`, SDK, or `@/env` imports — modeled on `src/data/formats.ts`.
 * That lets `src/env.ts`, the prompts layer, and the runtime import the SAME
 * list. The concrete per-provider wiring (API model id, reasoning effort, SDK
 * client, API key) deliberately lives in the SERVER-ONLY provider factory
 * (`src/agent/providers/factory.ts`), keyed off {@link ModelOption.provider}, so
 * this file stays free of secrets and SDKs and safe to bundle for the client.
 */

/** The kind of upstream API a model speaks (selects the provider adapter). */
export type ProviderKind = "anthropic" | "openai" | "xai";

/**
 * A model the app can run on. The `key` is the stable token set via the
 * ACTIVE_MODEL secret, validated server-side, and used to select the provider —
 * never a human-facing string beyond {@link label}.
 */
export type ModelKey = "claude" | "gpt-5.5" | "grok-4.3";

export interface ModelOption {
  key: ModelKey;
  /** Human-facing name (used in logs / provider-error messages). */
  label: string;
  provider: ProviderKind;
}

/**
 * Every model the app can run on, in stable order. Grok 4.3 is first (the
 * primary/default). Adding a model is a one-line change here + a factory entry.
 */
export const MODELS: readonly ModelOption[] = [
  { key: "grok-4.3", label: "xAI Grok 4.3", provider: "xai" },
  { key: "claude", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { key: "gpt-5.5", label: "OpenAI GPT-5.5", provider: "openai" },
] as const;

/**
 * The default model — used when ACTIVE_MODEL is unset and as every validation
 * fallback. Grok 4.3 is the primary model the app is designed around; its native
 * provider is the first-class path (Claude/GPT remain fully supported, selected
 * via ACTIVE_MODEL). Because XAI_API_KEY is required at boot, the default is
 * always configured, so falling back to it is always safe.
 */
export const DEFAULT_MODEL_KEY: ModelKey = "grok-4.3";

/** Type guard for a known model key (validates the ACTIVE_MODEL secret). */
export function isModelKey(value: unknown): value is ModelKey {
  return (
    typeof value === "string" &&
    (MODELS as readonly ModelOption[]).some((m) => m.key === value)
  );
}

/** The display label for a model key (falls back to the key itself). */
export function modelLabel(key: ModelKey): string {
  return MODELS.find((m) => m.key === key)?.label ?? key;
}
