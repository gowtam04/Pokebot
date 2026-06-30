/**
 * Unit tests for T15 `get_usage_stats` — the tool wrapper contract, with the
 * championsbattledata.com client mocked (these are pure; no network).
 *
 * Asserts:
 *   - champions happy path maps the client result into the output shape, caps
 *     each category to the top 8, and stamps source_url + attribution,
 *   - format defaults to "doubles" and "singles" passes through,
 *   - standard mode short-circuits to not_available_in_standard (no client call),
 *   - a name miss and a thrown transport fault map to the documented shapes,
 *   - invalid input degrades to { found:false, suggestions:[] } (no throw).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentContext } from "@/agent/types";

const getUsage = vi.fn();

vi.mock("@/server/champions-usage/usage-client", () => ({
  getUsage: (...args: unknown[]) => getUsage(...args),
  USAGE_ATTRIBUTION: "ATTR",
}));

import { getUsageStatsTool } from "./get-usage-stats.tool";

const champCtx = {
  db: {},
  logger: console,
  requestId: "test",
  mode: "champions",
} as unknown as AgentContext;

const stdCtx = { ...champCtx, mode: "standard" } as unknown as AgentContext;

function usageData(over: Record<string, unknown> = {}) {
  const moves = Array.from({ length: 12 }, (_, i) => ({
    name: `move-${i}`,
    pct: 50 - i,
    rank: i + 1,
  }));
  return {
    saved_name: "Garchomp",
    format: "doubles",
    season: "Season M-3",
    fetched_at: 1000,
    moves,
    items: [{ name: "Life Orb", pct: 41.5, rank: 1 }],
    abilities: [{ name: "Rough Skin", pct: 100, rank: 1 }],
    natures: [{ name: "Jolly", pct: 73.4, rank: 1 }],
    spreads: [{ name: "0/252/0/0/4/252", pct: 31, rank: 1 }],
    teammates: [{ name: "Rillaboom", pct: 28.6, rank: 1 }],
    source_url: "https://championsbattledata.com/api/battle/Doubles/Garchomp",
    ...over,
  };
}

beforeEach(() => {
  getUsage.mockReset();
});

describe("get_usage_stats (T15)", () => {
  it("maps a champions hit into the output, caps top 8, stamps attribution", async () => {
    getUsage.mockResolvedValue({ found: true, data: usageData() });

    const out = (await getUsageStatsTool.run({ name: "garchomp" }, champCtx)) as Record<
      string,
      unknown
    >;

    expect(getUsage).toHaveBeenCalledWith("garchomp", "doubles", {
      signal: undefined,
    });
    expect(out).toMatchObject({
      found: true,
      name: "garchomp",
      saved_name: "Garchomp",
      format: "doubles",
      season: "Season M-3",
      fetched_at: 1000,
      source_url: "https://championsbattledata.com/api/battle/Doubles/Garchomp",
      attribution: "ATTR",
    });
    // Top-8 cap per category.
    expect((out.moves as unknown[]).length).toBe(8);
    expect((out.moves as { name: string }[])[0].name).toBe("move-0");
    expect((out.abilities as unknown[]).length).toBe(1);
  });

  it("passes format 'singles' through", async () => {
    getUsage.mockResolvedValue({
      found: true,
      data: usageData({ format: "singles" }),
    });
    await getUsageStatsTool.run({ name: "garchomp", format: "singles" }, champCtx);
    expect(getUsage).toHaveBeenCalledWith("garchomp", "singles", {
      signal: undefined,
    });
  });

  it("short-circuits to not_available_in_standard outside champions mode", async () => {
    const out = await getUsageStatsTool.run({ name: "garchomp" }, stdCtx);
    expect(out).toEqual({ error: "not_available_in_standard" });
    expect(getUsage).not.toHaveBeenCalled();
  });

  it("passes a name miss straight through", async () => {
    getUsage.mockResolvedValue({ found: false, suggestions: ["Garchomp"] });
    const out = await getUsageStatsTool.run({ name: "garchom" }, champCtx);
    expect(out).toEqual({ found: false, suggestions: ["Garchomp"] });
  });

  it("maps a transport fault to upstream_unavailable (never throws)", async () => {
    getUsage.mockRejectedValue(new Error("network down"));
    const out = await getUsageStatsTool.run({ name: "garchomp" }, champCtx);
    expect(out).toEqual({ error: "upstream_unavailable" });
  });

  it("degrades invalid input to an empty miss", async () => {
    const out = await getUsageStatsTool.run({}, champCtx);
    expect(out).toEqual({ found: false, suggestions: [] });
    expect(getUsage).not.toHaveBeenCalled();
  });
});
