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
import { GrokProvider } from "@/agent/providers/grok-provider";
import { OpenAICompatibleProvider } from "@/agent/providers/openai-compatible-provider";
import type { LLMProvider, ReasoningEffort } from "@/agent/providers/types";

/** A model key resolved to its concrete, server-side request wiring. */
export interface ResolvedModel {
  key: ModelKey;
  provider: ProviderKind;
  apiModelId: string;
  /** Reasoning effort for OpenAI/xAI (Anthropic ignores it). */
  effort?: ReasoningEffort;
  /** Sampling temperature for OpenAI/xAI (Anthropic ignores it). */
  temperature?: number;
  /** Output-token budget for OpenAI/xAI (defaults to MAX_TOKENS). */
  maxOutputTokens?: number;
  /** Allow parallel tool calls for OpenAI/xAI (defaults to true). */
  parallelToolCalls?: boolean;
}

/**
 * Per-key server wiring. `apiModelId`/`effort` only — provider kind comes from
 * the client-safe {@link MODELS} registry (single source). Defaults per provider
 * docs: GPT-5.5 → medium, Grok 4.3 → high (its max).
 */
const MODEL_CONFIG: Record<
  ModelKey,
  {
    apiModelId: () => string;
    effort?: ReasoningEffort;
    temperature?: number;
    maxOutputTokens?: number;
    parallelToolCalls?: boolean;
  }
> = {
  claude: { apiModelId: () => env.ANTHROPIC_MODEL },
  // OpenAI-compatible reasoning models: pin a LOW temperature (Grok 4.3 defaults
  // to 0.7 — too random for battle-math/eval stability), RAISE the output budget
  // (reasoning + a full candidate list can exceed the 16k default and truncate
  // submit_answer into invalid JSON), and DISABLE parallel tool calls so
  // submit_answer can't be returned in the same batch as a data tool.
  "gpt-5.5": {
    apiModelId: () => "gpt-5.5",
    effort: "medium",
    temperature: 0.2,
    maxOutputTokens: 32000,
    parallelToolCalls: false,
  },
  "grok-4.3": {
    apiModelId: () => "grok-4.3",
    effort: "high",
    temperature: 0.2,
    maxOutputTokens: 32000,
    parallelToolCalls: false,
  },
};

/** Resolve a (possibly missing/unknown) key to its wiring; defaults to Grok. */
export function resolveModel(key: string | undefined | null): ResolvedModel {
  const resolvedKey: ModelKey = isModelKey(key) ? key : DEFAULT_MODEL_KEY;
  const option = MODELS.find((m) => m.key === resolvedKey)!;
  const config = MODEL_CONFIG[resolvedKey];
  return {
    key: resolvedKey,
    provider: option.provider,
    apiModelId: config.apiModelId(),
    effort: config.effort,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    parallelToolCalls: config.parallelToolCalls,
  };
}

/**
 * The operator-selected active model (from the `ACTIVE_MODEL` secret). There is
 * no per-turn picker — this is the single source for `ctx.model`. Passes through
 * the safe resolver so an unexpected value still falls back to the default.
 */
export function activeModelKey(): ModelKey {
  return resolveModel(env.ACTIVE_MODEL).key;
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
 * route to fail fast with a clean 503 before opening the SSE stream. xAI (the
 * primary provider) is required at boot, so the default model is always
 * configured; Anthropic/OpenAI are validate-on-use.
 */
export function isModelConfigured(key: string | undefined | null): boolean {
  const { provider } = resolveModel(key);
  return Boolean(keyFor(provider));
}

/** Construct the configured provider for a model key (validate-on-use). */
export function providerFor(key: string | undefined | null): LLMProvider {
  const model = resolveModel(key);

  // Validate-on-use for EVERY provider (Anthropic's key is now optional, so it can
  // be absent just like OpenAI/xAI) — throw a typed model_unavailable instead of
  // constructing a provider with no key.
  const apiKey = keyFor(model.provider);
  if (!apiKey) throw new ProviderNotConfiguredError(model.provider);

  if (model.provider === "anthropic") {
    return new AnthropicProvider({ apiModelId: model.apiModelId });
  }

  if (model.provider === "xai") {
    return new GrokProvider({
      apiModelId: model.apiModelId,
      apiKey,
      baseURL: env.XAI_BASE_URL,
      effort: model.effort,
      temperature: model.temperature,
      maxOutputTokens: model.maxOutputTokens,
      parallelToolCalls: model.parallelToolCalls,
    });
  }

  // openai (GPT-5.5) keeps the Chat Completions shim.
  return new OpenAICompatibleProvider({
    kind: model.provider,
    apiModelId: model.apiModelId,
    apiKey,
    baseURL: env.OPENAI_BASE_URL,
    effort: model.effort,
    temperature: model.temperature,
    maxOutputTokens: model.maxOutputTokens,
    parallelToolCalls: model.parallelToolCalls,
  });
}
