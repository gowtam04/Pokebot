/**
 * INDEPENDENT ORACLE — query_pokedex must report a structured
 * { error: "index_unavailable" } (never throw, never fabricate) when the index
 * is empty / not yet ingested.
 *
 * Source of truth: tools.md T2 failure modes + design.md § Data Model
 * (ingest_meta "lets the app detect a missing/stale/empty index and return
 * index_unavailable gracefully"). evaluation.md G22 / integration.md map this to
 * an insufficient_data answer downstream.
 *
 * This file deliberately migrates its OWN fresh but EMPTY Postgres schema
 * (no rows, no ingest_meta) so the seeded-DB oracle and this one never share
 * data. The empty schema is installed as the @/data/db singleton for the whole
 * file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Neutralize `import "server-only"` (db.ts) under the vitest node environment.
vi.mock("server-only", () => ({}));

import { queryPokedexOutputSchema } from "@/agent/schemas";
import type { AgentContext } from "@/agent/types";

import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";
import { loadToolSurface } from "./fixtures/tools-fixture";

let dispatch: (
  name: string,
  args: unknown,
  ctx: AgentContext,
) => Promise<unknown>;
let ctx: AgentContext;
let loadError: unknown = null;
let fix: PgFixture;

beforeAll(async () => {
  try {
    // Migrated but empty: tables exist, but NO rows and NO ingest_meta.
    fix = await createPgSchema({ seed: "none" });
    await installAsSingleton(fix);

    const surface = await loadToolSurface();
    dispatch = surface.dispatch;
    ctx = surface.ctx;
  } catch (e) {
    loadError = e;
  }
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function ensureLoaded(): void {
  if (loadError) {
    throw new Error(
      `Tool layer not loadable yet (Phase 4 incomplete): ${String(loadError)}`,
    );
  }
}

describe("query_pokedex oracle — empty index (T2 failure mode)", () => {
  it('reports { error: "index_unavailable" } against an un-ingested DB, without throwing', async () => {
    ensureLoaded();
    let out: unknown;
    await expect(
      (async () => {
        out = await dispatch(
          "query_pokedex",
          { sort_by: "speed", order: "desc" },
          ctx,
        );
      })(),
    ).resolves.toBeUndefined();

    expect(queryPokedexOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toEqual({ error: "index_unavailable" });
  });
});
