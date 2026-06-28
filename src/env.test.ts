import { describe, expect, it } from "vitest";
import { env, parseEnv } from "@/env";

describe("env", () => {
  it("rejects a missing ANTHROPIC_API_KEY", () => {
    expect(() => parseEnv({})).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it("rejects an empty ANTHROPIC_API_KEY", () => {
    expect(() => parseEnv({ ANTHROPIC_API_KEY: "" })).toThrowError(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("applies defaults when only the key is supplied", () => {
    const parsed = parseEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(parsed.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(parsed.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(parsed.DATABASE_URL).toBe(
      "postgres://oak:oak@localhost:5432/oak",
    );
    expect(parsed.POKEAPI_BASE_URL).toBe("https://pokeapi.co/api/v2");
    expect(parsed.LOG_LEVEL).toBe("info");
  });

  it("rejects an invalid LOG_LEVEL", () => {
    expect(() =>
      parseEnv({ ANTHROPIC_API_KEY: "sk-test", LOG_LEVEL: "loud" }),
    ).toThrowError(/LOG_LEVEL/);
  });

  it("rejects a non-URL POKEAPI_BASE_URL", () => {
    expect(() =>
      parseEnv({ ANTHROPIC_API_KEY: "sk-test", POKEAPI_BASE_URL: "not-a-url" }),
    ).toThrowError(/POKEAPI_BASE_URL/);
  });

  it("exposes an eagerly-parsed env (dummy key injected by the test runner)", () => {
    expect(env.ANTHROPIC_API_KEY.length).toBeGreaterThan(0);
  });

  it("treats OPENAI/XAI keys as optional and defaults the xAI base URL", () => {
    // Boots with ONLY the Anthropic key — the alternate providers are opt-in.
    const parsed = parseEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
    expect(parsed.XAI_API_KEY).toBeUndefined();
    expect(parsed.OPENAI_BASE_URL).toBeUndefined();
    expect(parsed.XAI_BASE_URL).toBe("https://api.x.ai/v1");
  });

  it("treats an empty provider key as absent (compose env_file safety)", () => {
    const parsed = parseEnv({
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "",
      XAI_API_KEY: "   ",
    });
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
    expect(parsed.XAI_API_KEY).toBeUndefined();
  });

  it("accepts supplied provider keys and base URLs", () => {
    const parsed = parseEnv({
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "sk-openai",
      XAI_API_KEY: "xai-key",
      XAI_BASE_URL: "https://example.test/v1",
    });
    expect(parsed.OPENAI_API_KEY).toBe("sk-openai");
    expect(parsed.XAI_API_KEY).toBe("xai-key");
    expect(parsed.XAI_BASE_URL).toBe("https://example.test/v1");
  });
});
