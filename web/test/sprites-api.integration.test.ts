/**
 * Integration tests for `GET /api/sprites` (detailed team view). Drives the real
 * route handler against a real migrated + seeded Postgres schema (Testcontainers).
 *
 * Asserts: a batch resolves by slug AND display name (returning sprite_url, dex,
 * types, and base_stats), unknown names are simply absent, an empty `names` param
 * yields an empty map, and an invalid `format` is a 4xx. spriteRefsByNames reads
 * the `@/data/db` singleton, so the fixture is installed via `installAsSingleton`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";

// Route deps (@/data/db etc.) load dynamically at call time, so a static import
// here does NOT touch @/data/db before installAsSingleton runs.
import { GET } from "@/app/api/sprites/route";
import type { SpriteRef } from "@/data/repos/pokedex-repo";

let fix: PgFixture;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function call(params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return GET(new Request(`http://localhost/api/sprites?${qs}`));
}

async function refs(res: Response): Promise<Record<string, SpriteRef>> {
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.refs as Record<string, SpriteRef>;
}

describe("GET /api/sprites", () => {
  it("resolves a batch by slug and display name with types + base stats", async () => {
    const map = await refs(
      await call({ format: "scarlet-violet", names: "garchomp,Garchomp" }),
    );
    const g = map.garchomp ?? map.Garchomp;
    expect(g).toBeTruthy();
    expect(g.display_name).toBe("Garchomp");
    expect(g.dex_number).toBe(445);
    expect(g.types).toEqual(expect.arrayContaining(["dragon", "ground"]));
    expect(typeof g.sprite_url).toBe("string");
    // Base stats come through for the client-side stat readout.
    expect(g.base_stats.attack).toBe(130);
    expect(g.base_stats.speed).toBe(102);
  });

  it("omits unknown names from the map", async () => {
    const map = await refs(
      await call({ format: "scarlet-violet", names: "garchomp,zzznotamon" }),
    );
    expect(map.garchomp).toBeTruthy();
    expect(map.zzznotamon).toBeUndefined();
  });

  it("returns an empty map for an empty names param", async () => {
    const map = await refs(await call({ format: "scarlet-violet", names: "" }));
    expect(map).toEqual({});
  });

  it("rejects an invalid format with a 4xx", async () => {
    const res = await call({ format: "gen1", names: "garchomp" });
    expect(res.status).toBe(400);
  });
});
