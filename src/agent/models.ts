/**
 * Model registry — the single source of truth for which LLMs the model switcher
 * exposes (Claude / GPT-5.5 / Grok 4.3).
 *
 * CLIENT-SAFE by design: this module holds ONLY pure constants/mappings and has
 * NO `server-only`, SDK, or `@/env` imports — modeled on `src/data/formats.ts`.
 * That lets the frontend (`page.tsx` / `ModelSelector`), the API route's body
 * validation, the prompts layer, and the runtime all import the SAME list so a
 * model key never gets hardcoded twice and never drifts between the dropdown and
 * the server whitelist.
 *
 * The concrete per-provider wiring (API model id, reasoning effort, SDK client,
 * API key) deliberately lives in the SERVER-ONLY provider factory
 * (`src/agent/providers/factory.ts`), keyed off {@link ModelOption.provider}, so
 * this file stays free of secrets and SDKs and safe to bundle for the client.
 */

/** The kind of upstream API a model speaks (selects the provider adapter). */
export type ProviderKind = "anthropic" | "openai" | "xai";

/**
 * A model the user can choose. The `key` is the stable token stored in
 * localStorage, sent in the chat request body, validated server-side, and used
 * to select the provider — never a human-facing string beyond {@link label}.
 */
export type ModelKey = "claude" | "gpt-5.5" | "grok-4.3";

export interface ModelOption {
  key: ModelKey;
  /** Human-facing name shown in the switcher. */
  label: string;
  provider: ProviderKind;
}

/**
 * Every selectable model, in stable display order. Claude is first (the
 * default). Adding a model is a one-line change here + a factory entry.
 */
export const MODELS: readonly ModelOption[] = [
  { key: "claude", label: "Claude", provider: "anthropic" },
  { key: "gpt-5.5", label: "OpenAI GPT-5.5", provider: "openai" },
  { key: "grok-4.3", label: "xAI Grok 4.3", provider: "xai" },
] as const;

/**
 * The default model — used for old clients that omit `model`, an unknown/invalid
 * key, and every validation fallback. Claude stays the default: it is the path
 * the system prompt + few-shot are tuned for (zero-regression baseline).
 */
export const DEFAULT_MODEL_KEY: ModelKey = "claude";

/** Type guard for a known model key (the route's request-body whitelist). */
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
