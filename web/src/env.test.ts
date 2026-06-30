import { describe, expect, it } from "vitest";
import { env, parseEnv } from "@/env";

describe("env", () => {
  it("rejects a missing XAI_API_KEY", () => {
    expect(() => parseEnv({})).toThrowError(/XAI_API_KEY/);
  });

  it("rejects an empty XAI_API_KEY", () => {
    expect(() => parseEnv({ XAI_API_KEY: "" })).toThrowError(/XAI_API_KEY/);
  });

  it("applies defaults when only the key is supplied", () => {
    const parsed = parseEnv({ XAI_API_KEY: "xai-test" });
    expect(parsed.XAI_API_KEY).toBe("xai-test");
    expect(parsed.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(parsed.ACTIVE_MODEL).toBe("grok-4.3");
    expect(parsed.DATABASE_URL).toBe(
      "postgres://oak:oak@localhost:5432/oak",
    );
    expect(parsed.POKEAPI_BASE_URL).toBe("https://pokeapi.co/api/v2");
    expect(parsed.LOG_LEVEL).toBe("info");
  });

  it("defaults ACTIVE_MODEL to grok-4.3 when empty (compose env_file safety)", () => {
    expect(parseEnv({ XAI_API_KEY: "xai-test", ACTIVE_MODEL: "" }).ACTIVE_MODEL)
      .toBe("grok-4.3");
    expect(
      parseEnv({ XAI_API_KEY: "xai-test", ACTIVE_MODEL: "   " }).ACTIVE_MODEL,
    ).toBe("grok-4.3");
  });

  it("accepts a registry ACTIVE_MODEL and rejects an unknown one", () => {
    expect(
      parseEnv({ XAI_API_KEY: "xai-test", ACTIVE_MODEL: "claude" }).ACTIVE_MODEL,
    ).toBe("claude");
    expect(
      parseEnv({ XAI_API_KEY: "xai-test", ACTIVE_MODEL: "gpt-5.5" }).ACTIVE_MODEL,
    ).toBe("gpt-5.5");
    expect(() =>
      parseEnv({ XAI_API_KEY: "xai-test", ACTIVE_MODEL: "gpt-9000" }),
    ).toThrowError(/ACTIVE_MODEL/);
  });

  it("rejects an invalid LOG_LEVEL", () => {
    expect(() =>
      parseEnv({ XAI_API_KEY: "xai-test", LOG_LEVEL: "loud" }),
    ).toThrowError(/LOG_LEVEL/);
  });

  it("rejects a non-URL POKEAPI_BASE_URL", () => {
    expect(() =>
      parseEnv({ XAI_API_KEY: "xai-test", POKEAPI_BASE_URL: "not-a-url" }),
    ).toThrowError(/POKEAPI_BASE_URL/);
  });

  it("exposes an eagerly-parsed env (dummy key injected by the test runner)", () => {
    expect(env.XAI_API_KEY.length).toBeGreaterThan(0);
  });

  it("treats ANTHROPIC/OPENAI keys as optional and defaults the xAI base URL", () => {
    // Boots with ONLY the xAI key — the alternate providers (Claude/OpenAI) are
    // opt-in (validate-on-use).
    const parsed = parseEnv({ XAI_API_KEY: "xai-test" });
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
    expect(parsed.OPENAI_BASE_URL).toBeUndefined();
    expect(parsed.XAI_BASE_URL).toBe("https://api.x.ai/v1");
  });

  it("treats an empty provider key as absent (compose env_file safety)", () => {
    const parsed = parseEnv({
      XAI_API_KEY: "xai-test",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "   ",
    });
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("accepts supplied provider keys and base URLs", () => {
    const parsed = parseEnv({
      XAI_API_KEY: "xai-key",
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "sk-openai",
      XAI_BASE_URL: "https://example.test/v1",
    });
    expect(parsed.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(parsed.OPENAI_API_KEY).toBe("sk-openai");
    expect(parsed.XAI_API_KEY).toBe("xai-key");
    expect(parsed.XAI_BASE_URL).toBe("https://example.test/v1");
  });
});
