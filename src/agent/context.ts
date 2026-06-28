/**
 * AgentContext factory (Phase 4 assembly seam; design.md § File Structure:
 * src/agent/context.ts).
 *
 * Builds the per-request `AgentContext` that the runtime threads into every tool
 * `run(args, ctx)` call: the bound SQLite handle (`db`), a correlation-tagged
 * pino logger, and the request id. Nothing here calls PokeAPI or the model — it
 * only wires already-built singletons (or test/eval overrides) together.
 *
 * ── The `db` binding (why it is self-referential) ──────────────────────────
 * The Phase-4 repos diverged on how they take the Drizzle handle:
 *   - pokedex-repo (`queryPokedex`, `getPokemon`) and learnset-repo
 *     (`gen9LearnerCount`, `pokemonLearningAll`) take the RAW `OakDb` and use
 *     it directly (`db.select()...`).
 *   - reference-cache (`getReference`) takes a `ReferenceCacheCtx` whose `.db`
 *     property is the `OakDb` (`resolveDb(ctx)` reads `ctx.db`).
 * Every tool forwards the SAME value — `ctx.db` — to its repo. To satisfy both
 * contracts with one value we bind `ctx.db` to the handle itself AND give it a
 * non-enumerable `db` property pointing back at the handle. Then:
 *   - `queryPokedex(filters, ctx.db)`  → `ctx.db` IS the handle (works), and
 *   - `getReference(kind, slug, ctx.db)` → `resolveDb` reads `ctx.db.db`, the
 *     same handle (works — and honours a fixture handle, never silently falling
 *     back to the process singleton).
 * Drizzle itself never reads a `.db` property (it uses dialect/session/query/
 * $client), so the self-reference is inert. The mutation is idempotent.
 *
 * Lazy `@/data/db` import: keeping the singleton import lazy means merely
 * importing this module does not pull in `server-only` or open the on-disk DB —
 * the eval harness and unit tests can inject a fixture handle without tripping
 * the server-only boundary or running migrations against the real file.
 */

import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { DEFAULT_MODEL_KEY, type ModelKey } from "@/agent/models";
import type { AgentContext, AgentMode, DbCtx } from "@/agent/types";
import type { OakDb } from "@/data/db";
import type { ActiveTeam } from "@/server/teams/active-team";
import { logger as defaultLogger } from "@/server/logger";

/** Overrides for {@link createAgentContext}; every field defaults sensibly. */
export interface CreateAgentContextOptions {
  /** Drizzle handle to bind. Defaults to the `@/data/db` process singleton. */
  db?: OakDb;
  /** Base pino logger. Defaults to the shared `@/server/logger` instance. */
  logger?: Logger;
  /** Correlation id for the turn trace. Defaults to a fresh UUID. */
  requestId?: string;
  /** Optional session id, bound onto the child logger for correlation. */
  sessionId?: string;
  /**
   * Query scope for the turn (server-controlled). Defaults to "standard" so
   * every existing caller/test keeps today's Gen 9 behavior unchanged.
   */
  mode?: AgentMode;
  /**
   * Which LLM answers the turn (server-controlled). Defaults to the Claude key
   * so every existing caller/test keeps today's behavior unchanged.
   */
  model?: ModelKey;
  /**
   * Inbound request abort signal, threaded onto the context so the runtime can
   * abort the provider stream and bail between loop iterations when the client
   * disconnects (user pressed Stop). Optional — defaults to undefined.
   */
  signal?: AbortSignal;
  /**
   * The turn's active team (already resolved + authorized by the route via
   * `resolveActiveTeam`). Bound straight onto `AgentContext.activeTeam`;
   * `undefined` (the default) means no team is bound. Server-controlled like
   * `mode` — never set by the model.
   */
  activeTeam?: ActiveTeam;
  /** Signed-in account id (server-controlled). Used only by `save_team` (T13). */
  accountId?: string;
  /**
   * The most recent team the agent proposed earlier in this conversation (raw
   * members), bound straight onto `AgentContext.proposedTeam`. Server-controlled
   * like `activeTeam`; `undefined` (default) means none pending.
   */
  proposedTeam?: import("@/agent/schemas").ProposedTeam;
}

/**
 * Bind a `OakDb` so it satisfies BOTH repo handle contracts (see file
 * header). Adds a non-enumerable, idempotent self-reference and returns it typed
 * as the contract-level `DbCtx`.
 */
function bindDbCtx(handle: OakDb): DbCtx {
  const withSelf = handle as OakDb & { db?: OakDb };
  if (withSelf.db !== handle) {
    Object.defineProperty(withSelf, "db", {
      value: handle,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return withSelf as unknown as DbCtx;
}

/**
 * Assemble a per-request {@link AgentContext}.
 *
 * Async because the default `db` is imported lazily (so importing this module is
 * side-effect free). Pass `{ db }` to bind a fixture/eval handle synchronously
 * in spirit; pass `{ requestId }` to correlate with an inbound request.
 */
export async function createAgentContext(
  options: CreateAgentContextOptions = {},
): Promise<AgentContext> {
  // Defensive: the test oracle probes this factory with positional args
  // (e.g. a bare string); treat anything non-object as "use all defaults".
  const opts: CreateAgentContextOptions =
    typeof options === "object" && options !== null ? options : {};

  const handle: OakDb = opts.db ?? (await import("@/data/db")).db;
  const requestId = opts.requestId ?? randomUUID();
  const mode: AgentMode = opts.mode ?? "standard";
  const model: ModelKey = opts.model ?? DEFAULT_MODEL_KEY;

  const baseLogger = opts.logger ?? defaultLogger;
  const logger = baseLogger.child({
    request_id: requestId,
    mode,
    model,
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  });

  return {
    db: bindDbCtx(handle),
    logger,
    requestId,
    mode,
    model,
    signal: opts.signal,
    activeTeam: opts.activeTeam,
    accountId: opts.accountId,
    sessionId: opts.sessionId,
    proposedTeam: opts.proposedTeam,
  };
}

export default createAgentContext;
