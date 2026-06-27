/**
 * Provider factory — the SERVER-ONLY half of the model registry.
 *
 * Maps a client-safe {@link ModelKey} to its concrete wiring (API model id,
 * reasoning effort) and constructs the matching {@link LLMProvider}. This is
 * where secrets + SDKs live, deliberately separate from the client-safe
 * `@/agent/models` registry so the model list can be bundled for the browser
 * without dragging in `@/env` or the provider SDKs.
 *
 * Keys are VALIDATED ON USE: selecting a provider whose API key is absent throws
 * a typed {@link ProviderNotConfiguredError} (NOT at module load), which the
 * route turns into a clean `model_unavailable` 503 before opening the stream.
 */

import { env } from "@/env";
import {
  DEFAULT_MODEL_KEY,
  isModelKey,
  MODELS,
  type ModelKey,
  type ProviderKind,
} from "@/agent/models";
import { AnthropicProvider } from "@/agent/providers/anthropic-provider";
import { OpenAICompatibleProvider } from "@/agent/providers/openai-compatible-provider";
import type { LLMProvider, ReasoningEffort } from "@/agent/providers/types";

/** A model key resolved to its concrete, server-side request wiring. */
export interface ResolvedModel {
  key: ModelKey;
  provider: ProviderKind;
  apiModelId: string;
  /** Reasoning effort for OpenAI/xAI (Anthropic ignores it). */
  effort?: ReasoningEffort;
}

/**
 * Per-key server wiring. `apiModelId`/`effort` only — provider kind comes from
 * the client-safe {@link MODELS} registry (single source). Defaults per provider
 * docs: GPT-5.5 → medium, Grok 4.3 → high (its max).
 */
const MODEL_CONFIG: Record<
  ModelKey,
  { apiModelId: () => string; effort?: ReasoningEffort }
> = {
  claude: { apiModelId: () => env.ANTHROPIC_MODEL },
  "gpt-5.5": { apiModelId: () => "gpt-5.5", effort: "medium" },
  "grok-4.3": { apiModelId: () => "grok-4.3", effort: "high" },
};

/** Resolve a (possibly missing/unknown) key to its wiring; defaults to Claude. */
export function resolveModel(key: string | undefined | null): ResolvedModel {
  const resolvedKey: ModelKey = isModelKey(key) ? key : DEFAULT_MODEL_KEY;
  const option = MODELS.find((m) => m.key === resolvedKey)!;
  const config = MODEL_CONFIG[resolvedKey];
  return {
    key: resolvedKey,
    provider: option.provider,
    apiModelId: config.apiModelId(),
    effort: config.effort,
  };
}

/** Thrown when the selected model's provider API key is not configured. */
export class ProviderNotConfiguredError extends Error {
  constructor(public readonly provider: ProviderKind) {
    super(`Model provider "${provider}" is not configured on this server.`);
    this.name = "ProviderNotConfiguredError";
  }
}

/** The API key for a non-Anthropic provider, or undefined when unconfigured. */
function keyFor(provider: ProviderKind): string | undefined {
  if (provider === "openai") return env.OPENAI_API_KEY;
  if (provider === "xai") return env.XAI_API_KEY;
  return env.ANTHROPIC_API_KEY;
}

/**
 * Is the selected model's provider configured (its API key present)? Used by the
 * route to fail fast with a clean 503 before opening the SSE stream. Anthropic is
 * always configured (its key is required at boot).
 */
export function isModelConfigured(key: string | undefined | null): boolean {
  const { provider } = resolveModel(key);
  return Boolean(keyFor(provider));
}

/** Construct the configured provider for a model key (validate-on-use). */
export function providerFor(key: string | undefined | null): LLMProvider {
  const model = resolveModel(key);

  if (model.provider === "anthropic") {
    return new AnthropicProvider({ apiModelId: model.apiModelId });
  }

  const apiKey = keyFor(model.provider);
  if (!apiKey) throw new ProviderNotConfiguredError(model.provider);

  return new OpenAICompatibleProvider({
    kind: model.provider,
    apiModelId: model.apiModelId,
    apiKey,
    baseURL: model.provider === "xai" ? env.XAI_BASE_URL : env.OPENAI_BASE_URL,
    effort: model.effort,
  });
}
