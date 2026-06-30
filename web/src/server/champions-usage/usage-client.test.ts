/**
 * Unit tests for the championsbattledata.com client — `fetch` is stubbed, so
 * these are pure (no network). They pin the wire contract Oak depends on:
 *   - URL construction (capitalized format path + season query) and row
 *     normalization ("90.3%" -> 90.3, rank-sorted),
 *   - name -> saved_name resolution via the index, with a /api/metadata fallback,
 *   - a miss returns suggestions; a battle 404 is a miss with no retry,
 *   - a transient network error retries once then succeeds,
 *   - per-Pokémon usage is cached (a repeat call refetches nothing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUsage, __resetUsageCachesForTests } from "./usage-client";

const BASE = "https://championsbattledata.com";

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function notFound(): Response {
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}

const INDEX = {
  defaultSeason: "Season M-3",
  seasons: ["Season M-3"],
  pokemon: ["Garchomp", "Rillaboom", "Incineroar"],
};

const GARCHOMP_BATTLE = {
  pokemon: "Garchomp",
  format: "Doubles",
  season: "Season M-3",
  rows: [
    { position: 2, category: "move", rank: 2, name: "Protect", percentage: "84.1%" },
    { position: 1, category: "move", rank: 1, name: "Earthquake", percentage: "90.3%" },
    { position: 1, category: "item", rank: 1, name: "Life Orb", percentage: "41.5%" },
    { position: 1, category: "ability", rank: 1, name: "Rough Skin", percentage: "100%" },
    { position: 1, category: "nature", rank: 1, name: "Jolly", percentage: "73.4%" },
    { position: 1, category: "spread", rank: 1, name: "0/252/0/0/4/252", percentage: "31.0%" },
    { position: 1, category: "teammate", rank: 1, name: "Rillaboom", percentage: "28.6%" },
  ],
};

const OGERPON_META = {
  pokemon: "Ogerpon",
  rows: [
    { base_name: "Ogerpon", saved_name: "Ogerpon", form: "" },
    { base_name: "Ogerpon", saved_name: "Ogerpon Wellspring", form: "Wellspring" },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string) => Response | Promise<Response>) {
  fetchMock = vi.fn((url: unknown) => Promise.resolve(handler(String(url))));
  vi.stubGlobal("fetch", fetchMock);
}

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  __resetUsageCachesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getUsage — happy path", () => {
  beforeEach(() => {
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      if (url.startsWith(`${BASE}/api/battle/Doubles/Garchomp`)) return ok(GARCHOMP_BATTLE);
      return notFound();
    });
  });

  it("fetches the index + battle and normalizes the rows", async () => {
    const res = await getUsage("garchomp", "doubles", { now: 1000 });
    expect(res.found).toBe(true);
    if (!res.found) return;

    expect(res.data.saved_name).toBe("Garchomp");
    expect(res.data.season).toBe("Season M-3");
    expect(res.data.fetched_at).toBe(1000);
    // Parsed "90.3%" -> 90.3 and sorted by rank (Earthquake #1 before Protect #2).
    expect(res.data.moves[0]).toEqual({ name: "Earthquake", pct: 90.3, rank: 1 });
    expect(res.data.moves[1]).toEqual({ name: "Protect", pct: 84.1, rank: 2 });
    expect(res.data.abilities[0]).toEqual({ name: "Rough Skin", pct: 100, rank: 1 });
    expect(res.data.teammates[0].name).toBe("Rillaboom");
    // Capitalized format path + season query in the cited URL.
    expect(res.data.source_url).toBe(
      `${BASE}/api/battle/Doubles/Garchomp?season=Season%20M-3`,
    );
    // index + battle, no metadata call needed (direct index hit).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uppercases the format in the path for singles", async () => {
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      if (url.startsWith(`${BASE}/api/battle/Singles/Garchomp`))
        return ok({ ...GARCHOMP_BATTLE, format: "Singles" });
      return notFound();
    });
    const res = await getUsage("garchomp", "singles", { now: 1 });
    expect(res.found).toBe(true);
    expect(calledUrls().some((u) => u.includes("/api/battle/Singles/Garchomp"))).toBe(
      true,
    );
  });

  it("caches per-Pokémon usage — a repeat call refetches nothing", async () => {
    await getUsage("garchomp", "doubles", { now: 1000 });
    await getUsage("garchomp", "doubles", { now: 2000 });
    // Still just the first call's index + battle.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getUsage — resolution + misses", () => {
  it("falls back to /api/metadata when the name isn't in the index", async () => {
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      if (url.startsWith(`${BASE}/api/metadata/ogerpon`)) return ok(OGERPON_META);
      if (url.startsWith(`${BASE}/api/battle/Doubles/Ogerpon`))
        return ok({ rows: [{ category: "move", rank: 1, name: "Ivy Cudgel", percentage: "99%" }] });
      return notFound();
    });
    const res = await getUsage("ogerpon", "doubles", { now: 1 });
    expect(res.found).toBe(true);
    if (!res.found) return;
    // Picked the base-form saved_name from metadata.
    expect(res.data.saved_name).toBe("Ogerpon");
    expect(calledUrls().some((u) => u.includes("/api/metadata/ogerpon"))).toBe(true);
  });

  it("returns a miss with token-ranked suggestions for an unrecognized name", async () => {
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      return notFound(); // no metadata, no battle
    });
    const res = await getUsage("Mega Garchomp", "doubles", { now: 1 });
    expect(res.found).toBe(false);
    if (res.found) return;
    expect(res.suggestions).toContain("Garchomp");
  });

  it("treats a battle 404 as a miss and does not retry it", async () => {
    let battleCalls = 0;
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      if (url.startsWith(`${BASE}/api/battle/Doubles/Garchomp`)) {
        battleCalls += 1;
        return notFound();
      }
      return notFound();
    });
    const res = await getUsage("garchomp", "doubles", { now: 1 });
    expect(res.found).toBe(false);
    expect(battleCalls).toBe(1); // 404 is not retried
  });
});

describe("getUsage — network resilience", () => {
  it("retries once on a transient network error then succeeds", async () => {
    let battleCalls = 0;
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      if (url.startsWith(`${BASE}/api/battle/Doubles/Garchomp`)) {
        battleCalls += 1;
        if (battleCalls === 1) throw new TypeError("network down");
        return ok(GARCHOMP_BATTLE);
      }
      return notFound();
    });
    const res = await getUsage("garchomp", "doubles", { now: 1 });
    expect(res.found).toBe(true);
    expect(battleCalls).toBe(2); // failed once, retried once
  });

  it("propagates a persistent network fault after the retry", async () => {
    installFetch((url) => {
      if (url === `${BASE}/api`) return ok(INDEX);
      throw new TypeError("network down");
    });
    await expect(getUsage("garchomp", "doubles", { now: 1 })).rejects.toThrow();
  });
});
