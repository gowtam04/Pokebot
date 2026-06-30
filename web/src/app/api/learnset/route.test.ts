/**
 * Integration tests for `GET /api/learnset` — the team-builder Move-picker feed.
 *
 * Exercises the real route handler against a real migrated + seeded Postgres
 * schema (Testcontainers) with the repo reads reaching the installed `@/data/db`
 * singleton. Mirrors search/route.test.ts: install the fixture as the singleton
 * BEFORE the first dynamic import of the handler and neutralise `server-only`.
 *
 * Focus: param validation (missing pokemon / bad format → 400), a known species
 * returns ONLY its learnset (slug + display name, sorted), an unknown species
 * yields an empty list, and it never throws (in-domain results always 200).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../../test/support/pg";

type LearnsetRoute = typeof import("./route");

let fix: PgFixture;
let route: LearnsetRoute;

const SV = "scarlet-violet";

function req(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://test.local/api/learnset?${qs}`);
}

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);
  route = await import("./route");
});

afterAll(async () => {
  await fix?.cleanup?.();
});

describe("GET /api/learnset", () => {
  it("400s when the pokemon param is missing", async () => {
    const res = await route.GET(req({ format: SV }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_pokemon" });
  });

  it("400s on an unknown format", async () => {
    const res = await route.GET(req({ pokemon: "garchomp", format: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_format" });
  });

  it("returns only the species' learnset, with display names, sorted", async () => {
    const res = await route.GET(req({ pokemon: "garchomp", format: SV }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      moves: { slug: string; display_name: string }[];
    };
    const slugs = body.moves.map((m) => m.slug);
    // Garchomp's fixture learnset (and nothing it can't learn).
    expect(slugs).toEqual(
      expect.arrayContaining(["earthquake", "dragon-claw", "fire-fang"]),
    );
    expect(slugs).not.toContain("flamethrower");
    // Every entry carries a non-empty display name.
    expect(body.moves.every((m) => m.display_name.length > 0)).toBe(true);
    // Sorted by display name.
    const names = body.moves.map((m) => m.display_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("returns an empty list for an unknown species (not an error)", async () => {
    const res = await route.GET(req({ pokemon: "not-a-mon", format: SV }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moves: [] });
  });
});
