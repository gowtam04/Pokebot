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
      "postgres://pokebot:pokebot@localhost:5432/pokebot",
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
});
