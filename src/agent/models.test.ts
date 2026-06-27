/**
 * Tests for the client-safe model registry + the server-side factory:
 * key validation, fallback-to-default resolution, per-provider wiring, and
 * validate-on-use (an unconfigured provider key throws / reads unconfigured).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_KEY,
  isModelKey,
  MODELS,
  modelLabel,
} from "@/agent/models";
import {
  isModelConfigured,
  providerFor,
  ProviderNotConfiguredError,
  resolveModel,
} from "@/agent/providers/factory";

describe("model registry", () => {
  it("exposes the three models in order with stable keys", () => {
    expect(MODELS.map((m) => m.key)).toEqual(["claude", "gpt-5.5", "grok-4.3"]);
    expect(DEFAULT_MODEL_KEY).toBe("claude");
  });

  it("isModelKey only accepts known keys", () => {
    expect(isModelKey("claude")).toBe(true);
    expect(isModelKey("gpt-5.5")).toBe(true);
    expect(isModelKey("grok-4.3")).toBe(true);
    expect(isModelKey("gpt-4")).toBe(false);
    expect(isModelKey(undefined)).toBe(false);
    expect(isModelKey(123)).toBe(false);
  });

  it("modelLabel returns the display label", () => {
    expect(modelLabel("claude")).toBe("Claude");
    expect(modelLabel("gpt-5.5")).toBe("OpenAI GPT-5.5");
    expect(modelLabel("grok-4.3")).toBe("xAI Grok 4.3");
  });
});

describe("resolveModel", () => {
  it("maps each key to its provider + api model id", () => {
    expect(resolveModel("claude")).toMatchObject({
      key: "claude",
      provider: "anthropic",
      apiModelId: "claude-sonnet-4-6",
    });
    expect(resolveModel("gpt-5.5")).toMatchObject({
      key: "gpt-5.5",
      provider: "openai",
      apiModelId: "gpt-5.5",
      effort: "medium",
    });
    expect(resolveModel("grok-4.3")).toMatchObject({
      key: "grok-4.3",
      provider: "xai",
      apiModelId: "grok-4.3",
      effort: "high",
    });
  });

  it("falls back to the default for unknown/missing keys", () => {
    expect(resolveModel("nonsense").key).toBe("claude");
    expect(resolveModel(undefined).key).toBe("claude");
    expect(resolveModel(null).key).toBe("claude");
  });
});

describe("providerFor / isModelConfigured (validate-on-use)", () => {
  it("always builds the Anthropic provider (key required at boot)", () => {
    expect(isModelConfigured("claude")).toBe(true);
    const provider = providerFor("claude");
    expect(provider.kind).toBe("anthropic");
    expect(provider.apiModelId).toBe("claude-sonnet-4-6");
  });

  it("providerFor agrees with isModelConfigured for alternate providers", () => {
    // Robust regardless of whether OPENAI_API_KEY/XAI_API_KEY happen to be set in
    // the environment: when unconfigured, providerFor throws the typed error;
    // when configured, it builds the OpenAI-compatible provider for that kind.
    for (const key of ["gpt-5.5", "grok-4.3"] as const) {
      if (isModelConfigured(key)) {
        const provider = providerFor(key);
        expect(["openai", "xai"]).toContain(provider.kind);
        expect(provider.apiModelId).toBe(key);
      } else {
        expect(() => providerFor(key)).toThrow(ProviderNotConfiguredError);
      }
    }
  });
});
