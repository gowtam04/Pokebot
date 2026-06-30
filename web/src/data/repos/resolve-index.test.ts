/**
 * Focused unit tests for src/data/repos/resolve-index.ts — the fuzzy
 * `resolve_entity` matcher (T1, BR-9). These exercise the ranking logic in
 * isolation, with NO real SQLite:
 *
 *   - `import "server-only"` is neutralised (it throws under the vitest node
 *     env), and `@/data/db` is mocked so importing the repo never opens the
 *     real connection. The pure `createResolveIndex(rows)` path needs neither.
 *
 * The end-to-end resolve_entity behaviour through the tool dispatch (G3) is
 * additionally covered by the independent oracle (test/tools-pokedex.oracle.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mocked db: node-postgres query builders are awaitable, so
// `await db.select({...}).from(table).where(...)` resolves to the current rows;
// we count reads so the memoization test can assert loadRows ran exactly once.
// `vi.hoisted` lets the (hoisted) vi.mock factory close over shared state.
const dbState = vi.hoisted(() => ({
  rows: [] as { kind: string; slug: string; display_name: string }[],
  allCalls: 0,
}));
vi.mock("@/data/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // loadRows: .from(searchable_names).where(...) — awaited directly.
        where: () => {
          dbState.allCalls += 1;
          return Promise.resolve(dbState.rows);
        },
      }),
    }),
  },
}));

import {
  createResolveIndex,
  resolveEntity,
  resetResolveIndex,
  type SearchableName,
} from "./resolve-index";

// ---------------------------------------------------------------------------
// Seed names (a slice of the real searchable_names contents)
// ---------------------------------------------------------------------------
const NAMES: SearchableName[] = [
  { kind: "pokemon", slug: "garchomp", display_name: "Garchomp" },
  { kind: "pokemon", slug: "farigiraf", display_name: "Farigiraf" },
  { kind: "pokemon", slug: "ninetales", display_name: "Ninetales" },
  {
    kind: "pokemon",
    slug: "tauros-paldea-aqua",
    display_name: "Tauros (Paldean Aqua)",
  },
  { kind: "move", slug: "will-o-wisp", display_name: "Will-O-Wisp" },
  { kind: "move", slug: "trick-room", display_name: "Trick Room" },
  { kind: "move", slug: "flamethrower", display_name: "Flamethrower" },
  { kind: "ability", slug: "flash-fire", display_name: "Flash Fire" },
  { kind: "ability", slug: "armor-tail", display_name: "Armor Tail" },
  { kind: "type", slug: "fire", display_name: "Fire" },
  { kind: "type", slug: "dragon", display_name: "Dragon" },
  { kind: "item", slug: "leftovers", display_name: "Leftovers" },
];

describe("createResolveIndex().resolve", () => {
  const index = createResolveIndex(NAMES);

  it("resolves a misspelled move to the right slug as the top match (G3)", () => {
    const { matches } = index.resolve("Will-o-Whisp", "any", 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].slug).toBe("will-o-wisp");
    expect(matches[0].kind).toBe("move");
    expect(matches[0].display_name).toBe("Will-O-Wisp");
  });

  it("resolves a misspelled Pokémon name ('Farigiraff' -> farigiraf)", () => {
    const { matches } = index.resolve("Farigiraff", "any", 5);
    expect(matches[0].slug).toBe("farigiraf");
  });

  it("resolves a misspelled multi-word move ('Trik Room' -> trick-room)", () => {
    const { matches } = index.resolve("Trik Room", "move", 5);
    expect(matches[0].slug).toBe("trick-room");
  });

  it("scores an exact match very high (HIGHER = better, in [0,1])", () => {
    const { matches } = index.resolve("Garchomp", "pokemon", 5);
    expect(matches[0].slug).toBe("garchomp");
    expect(matches[0].score).toBeGreaterThan(0.9);
    expect(matches[0].score).toBeLessThanOrEqual(1);
  });

  it("returns matches ranked best-first (non-increasing score)", () => {
    const { matches } = index.resolve("fla", "any", 10);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].score).toBeLessThanOrEqual(matches[i - 1].score);
    }
  });

  it("restricts results to the requested kind", () => {
    const { matches } = index.resolve("fire", "type", 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.kind === "type")).toBe(true);
    expect(matches.some((m) => m.slug === "fire")).toBe(true);
    // The 'flash-fire' ability must NOT leak into a type-only search.
    expect(matches.some((m) => m.kind === "ability")).toBe(false);
  });

  it("returns empty matches when nothing is close (no fatal failure, T1)", () => {
    expect(index.resolve("zzzqwxv-nonsense", "any", 5).matches).toEqual([]);
  });

  it("returns empty matches for a blank query", () => {
    expect(index.resolve("   ", "any", 5).matches).toEqual([]);
    expect(index.resolve("", "any", 5).matches).toEqual([]);
  });

  it("honours the limit", () => {
    const { matches } = index.resolve("a", "any", 2);
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it("returns empty matches when the index is empty (empty names table)", () => {
    expect(createResolveIndex([]).resolve("garchomp", "any", 5).matches).toEqual(
      [],
    );
  });
});

describe("resolveEntity (singleton, lazy-loaded from searchable_names)", () => {
  beforeEach(() => {
    resetResolveIndex();
    dbState.rows = [];
    dbState.allCalls = 0;
  });

  it("loads rows from the db on first call and resolves", async () => {
    dbState.rows = [...NAMES];
    const { matches } = await resolveEntity("Will-o-Whisp", "any", 5);
    expect(matches[0].slug).toBe("will-o-wisp");
    expect(dbState.allCalls).toBe(1);
  });

  it("defaults kind='any' and limit=5", async () => {
    dbState.rows = [...NAMES];
    const { matches } = await resolveEntity("Garchomp");
    expect(matches.length).toBeLessThanOrEqual(5);
    expect(matches[0].slug).toBe("garchomp");
  });

  it("memoizes the index (does not re-read after the first build)", async () => {
    dbState.rows = [...NAMES];
    await resolveEntity("Garchomp"); // builds + caches the index
    dbState.rows = []; // a NEW empty source (index already cached)
    const { matches } = await resolveEntity("Garchomp"); // served from cache
    expect(matches[0].slug).toBe("garchomp");
    expect(dbState.allCalls).toBe(1); // loadRows ran exactly once
  });

  it("rebuilds from the current table after resetResolveIndex()", async () => {
    dbState.rows = [...NAMES];
    await resolveEntity("Garchomp");
    dbState.rows = [];
    resetResolveIndex();
    expect((await resolveEntity("Garchomp")).matches).toEqual([]);
    expect(dbState.allCalls).toBe(2); // reloaded after reset
  });
});
