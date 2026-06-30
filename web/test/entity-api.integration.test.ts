/**
 * Integration tests for `GET /api/entity` (B-4 Phase 3). Drives the real route
 * handler against a real migrated + seeded Postgres schema (Testcontainers).
 *
 * Asserts: `ok` for each kind (resolution by display name AND slug), `not_found`
 * for an unresolvable query, `unavailable` when the requested format's index is
 * unbuilt (which also shows the `format` param switching the data scope), and a
 * 4xx for each malformed param. resolveEntity reads the `@/data/db` singleton, so
 * the fixture is installed via `installAsSingleton` before the first call.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "./support/pg";
import { seedEntityRefs } from "./fixtures/entity-refs";

import {
  entityArtifactResponseSchema,
  type EntityArtifactResponse,
} from "@/lib/entity-artifact";

// Route deps (@/data/db etc.) load dynamically at call time, so a static import
// here does NOT touch @/data/db before installAsSingleton runs.
import { GET } from "@/app/api/entity/route";

let fix: PgFixture;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools", after: seedEntityRefs });
  await installAsSingleton(fix);
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function call(params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return GET(new Request(`http://localhost/api/entity?${qs}`));
}

async function envelope(res: Response): Promise<EntityArtifactResponse> {
  expect(res.status).toBe(200);
  const body = await res.json();
  // Every 200 body must satisfy the shared contract.
  return entityArtifactResponseSchema.parse(body);
}

describe("GET /api/entity — ok per kind", () => {
  it("resolves a Pokémon by display name and returns a full profile", async () => {
    const env = await envelope(
      await call({ kind: "pokemon", q: "Garchomp", format: "scarlet-violet" }),
    );
    if (env.status !== "ok" || env.kind !== "pokemon") {
      throw new Error("expected ok pokemon");
    }
    expect(env.resolved.slug).toBe("garchomp");
    expect(env.data.movepool.length).toBeGreaterThan(0);
    expect(env.data.matchups.immune_to).toContain("electric");
  });

  it("returns a move profile", async () => {
    const env = await envelope(
      await call({ kind: "move", q: "earthquake", format: "scarlet-violet" }),
    );
    if (env.status !== "ok" || env.kind !== "move") {
      throw new Error("expected ok move");
    }
    expect(env.data.type).toBe("ground");
  });

  it("returns an ability profile with its learned_by roster", async () => {
    const env = await envelope(
      await call({ kind: "ability", q: "rough-skin", format: "scarlet-violet" }),
    );
    if (env.status !== "ok" || env.kind !== "ability") {
      throw new Error("expected ok ability");
    }
    expect(env.data.learned_by.map((h) => h.slug)).toContain("garchomp");
  });

  it("returns an item profile", async () => {
    const env = await envelope(
      await call({ kind: "item", q: "leftovers", format: "scarlet-violet" }),
    );
    expect(env.status).toBe("ok");
    expect(env.kind).toBe("item");
  });

  it("returns a type profile", async () => {
    const env = await envelope(
      await call({ kind: "type", q: "ground", format: "scarlet-violet" }),
    );
    if (env.status !== "ok" || env.kind !== "type") {
      throw new Error("expected ok type");
    }
    expect(env.data.offensive?.no_effect_against).toContain("flying");
  });
});

describe("GET /api/entity — miss + unavailable", () => {
  it("returns not_found for an unresolvable query", async () => {
    const env = await envelope(
      await call({
        kind: "pokemon",
        q: "zzznotapokemon",
        format: "scarlet-violet",
      }),
    );
    expect(env).toMatchObject({ status: "not_found", kind: "pokemon" });
  });

  it("returns unavailable when the requested format's index is unbuilt", async () => {
    // The "tools" seed builds only scarlet-violet — champions has no index.
    const env = await envelope(
      await call({ kind: "pokemon", q: "garchomp", format: "champions" }),
    );
    expect(env).toEqual({
      status: "unavailable",
      kind: "pokemon",
      format: "champions",
    });
  });
});

describe("GET /api/entity — malformed params → 4xx", () => {
  it("rejects an unknown kind", async () => {
    const res = await call({
      kind: "berry",
      q: "leftovers",
      format: "scarlet-violet",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing query", async () => {
    const res = await call({ kind: "pokemon", q: "", format: "scarlet-violet" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid format", async () => {
    const res = await call({ kind: "pokemon", q: "garchomp", format: "gen1" });
    expect(res.status).toBe(400);
  });
});
