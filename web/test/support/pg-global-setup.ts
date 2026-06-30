/**
 * Vitest globalSetup for the NODE project — starts one Postgres container for the
 * whole run and publishes its connection URI to the workers.
 *
 * Runs once in the Vitest main process (before any worker spawns). The only
 * reliable channel from here to the worker processes is `provide`/`inject`, so
 * we publish the base URI as `PG_CONN_URI`; test/support/pg.ts reads it via
 * `inject` and carves a private schema per fixture.
 *
 * Requires a reachable Docker daemon during `npm test` (Testcontainers). The
 * jsdom project has NO globalSetup, so component tests still run without Docker.
 */

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

// Vitest's globalSetup context exposes `provide`; type it inline (the named
// GlobalSetupContext isn't re-exported in this Vitest version). `PG_CONN_URI` is
// augmented onto ProvidedContext in test/support/pg.ts.
type SetupContext = { provide: (key: "PG_CONN_URI", value: string) => void };

export async function setup({ provide }: SetupContext): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("oak_test")
    .withUsername("oak")
    .withPassword("oak")
    // Headroom for the many small per-file pools running concurrently.
    .withCommand(["postgres", "-c", "max_connections=200"])
    .start();

  provide("PG_CONN_URI", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
