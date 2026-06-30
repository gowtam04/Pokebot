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
  activeModelKey,
  isModelConfigured,
  providerFor,
  ProviderNotConfiguredError,
  resolveModel,
} from "@/agent/providers/factory";
import { GrokProvider } from "@/agent/providers/grok-provider";

describe("model registry", () => {
  it("exposes the three models in order with stable keys (Grok primary)", () => {
    expect(MODELS.map((m) => m.key)).toEqual(["grok-4.3", "claude", "gpt-5.5"]);
    expect(DEFAULT_MODEL_KEY).toBe("grok-4.3");
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
    expect(modelLabel("claude")).toBe("Claude Sonnet 4.6");
    expect(modelLabel("gpt-5.5")).toBe("OpenAI GPT-5.5");
    expect(modelLabel("grok-4.3")).toBe("xAI Grok 4.3");
  });
});

describe("activeModelKey", () => {
  it("returns the default (Grok) when ACTIVE_MODEL is unset", () => {
    // The test runner injects no ACTIVE_MODEL, so env defaults it to grok-4.3;
    // activeModelKey passes through the safe resolver.
    expect(activeModelKey()).toBe("grok-4.3");
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

  it("falls back to the default (Grok) for unknown/missing keys", () => {
    expect(resolveModel("nonsense").key).toBe("grok-4.3");
    expect(resolveModel(undefined).key).toBe("grok-4.3");
    expect(resolveModel(null).key).toBe("grok-4.3");
  });
});

describe("providerFor / isModelConfigured (validate-on-use)", () => {
  it("builds the native Grok provider for grok-4.3 (XAI_API_KEY required at boot)", () => {
    expect(isModelConfigured("grok-4.3")).toBe(true);
    const provider = providerFor("grok-4.3");
    expect(provider.kind).toBe("xai");
    expect(provider.apiModelId).toBe("grok-4.3");
    // The primary path is the dedicated native adapter, not the OpenAI shim.
    expect(provider).toBeInstanceOf(GrokProvider);
  });

  it("builds the Anthropic provider when its (now-optional) key is configured", () => {
    // ANTHROPIC_API_KEY is no longer required at boot, but the test runner injects
    // a dummy so Claude stays selectable — validate-on-use, like every provider.
    expect(isModelConfigured("claude")).toBe(true);
    const provider = providerFor("claude");
    expect(provider.kind).toBe("anthropic");
    expect(provider.apiModelId).toBe("claude-sonnet-4-6");
  });

  it("providerFor agrees with isModelConfigured for every provider", () => {
    // Robust regardless of whether the alternate provider keys happen to be set in
    // the environment: when unconfigured, providerFor throws the typed error;
    // when configured, it builds the provider for that kind.
    for (const key of ["claude", "gpt-5.5", "grok-4.3"] as const) {
      if (isModelConfigured(key)) {
        const provider = providerFor(key);
        expect(["anthropic", "openai", "xai"]).toContain(provider.kind);
        expect(provider.apiModelId).toBe(
          key === "claude" ? "claude-sonnet-4-6" : key,
        );
      } else {
        expect(() => providerFor(key)).toThrow(ProviderNotConfiguredError);
      }
    }
  });
});
