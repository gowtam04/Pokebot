/**
 * Cross-phase agent contract types (design.md § Interface Definitions).
 *
 * These are the structural seams the runtime, tool layer, context factory, and
 * web route all share. Concrete implementations live elsewhere:
 *  - `AgentContext` is assembled in src/agent/context.ts (Phase 4),
 *  - `ToolDef[]` / `dispatch` are built in src/agent/tools/index.ts (Phase 4),
 *  - `runPokebot` is implemented in src/agent/runtime.ts (Phase 5).
 *
 * Schemas + the `PokebotAnswer` type are owned by src/agent/schemas.ts — import
 * from there, never redefine.
 */

import type { Logger } from "pino";
import type { JsonSchema, PokebotAnswer } from "@/agent/schemas";

/**
 * Query scope for a turn. Server-controlled (derived from the request body's
 * `champions_mode`), bound onto {@link AgentContext}, and read by repos/tools and
 * the runtime — NEVER an LLM-visible tool input. This guarantees that when the
 * Champions toggle is on, every query in the turn is Champions-scoped (the model
 * has no parameter to widen the scope).
 *
 *   "standard"  → Gen 9 / Scarlet-Violet (today's behavior).
 *   "champions" → Pokémon Champions (current regulation), via the @pkmn mod.
 */
export type AgentMode = "standard" | "champions";

/**
 * Bound data-access repositories for one request (assembled in
 * src/agent/context.ts). Kept structural at the contract layer so the schema /
 * type surface does not depend on the concrete repo wiring (Phase 4).
 */
export type DbCtx = {
  [repo: string]: unknown;
};

/**
 * Per-request agent context. Built in src/agent/context.ts; threaded into every
 * tool `run` call and into `runPokebot`.
 */
export interface AgentContext {
  /** Bound repos (the sole SQLite readers). */
  db: DbCtx;
  /** pino logger (carries request/session correlation fields). */
  logger: Logger;
  /** Correlation id for this request's turn trace. */
  requestId: string;
  /**
   * Query scope for this turn (server-controlled; defaults to "standard").
   * Repos/tools map it to a data `Format` via `formatForMode` and the runtime
   * selects the matching system-prompt variant. Never set by the model.
   */
  mode: AgentMode;
  /**
   * Per-request abort handle (the inbound request's `signal`). When the client
   * disconnects (e.g. the user presses Stop), the runtime forwards this to the
   * Anthropic SDK so generation halts immediately and checks it between loop
   * iterations. Undefined for callers/tests that don't supply one.
   */
  signal?: AbortSignal;
  /**
   * The turn's active team (TEAM-AD-1), resolved + authorized by the route and
   * bound here — the exact analogue of {@link mode}: server-controlled, NEVER an
   * LLM-visible tool input. Read only by the `get_active_team` tool; `undefined`
   * means no team is bound (guest, no selection, or a format mismatch), which
   * surfaces to the model as `{ active: false }`. Imported type-only so the
   * agent layer still never sees `account_id`.
   */
  activeTeam?: import("@/server/teams/active-team").ActiveTeam;
}

/**
 * A single tool exposed to the model. `name` and the output shape match
 * tools.md exactly — the model depends on them.
 */
export interface ToolDef {
  /** Matches a tools.md T1..T11 name exactly. */
  name: string;
  /** The "Description (for the model)" from tools.md. */
  description: string;
  /** Generated from the tool's Zod input schema (schemas.ts `toJsonSchema`). */
  inputSchema: JsonSchema;
  /** Executes the tool; returns the tools.md output shape (never throws in-domain). */
  run(args: unknown, ctx: AgentContext): Promise<unknown>;
}

/** Dispatch a tool call by name (src/agent/tools/index.ts). */
export type ToolDispatch = (
  name: string,
  args: unknown,
  ctx: AgentContext,
) => Promise<unknown>;

/** In-session chat history turn (DS-5; design.md runtime signature). */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Progress callback fired once per tool call as the loop runs. */
export type OnProgress = (event: { tool: string; label: string }) => void;

/**
 * Fired when a new submit_answer block begins streaming — the client clears its
 * in-flight answer buffer (so a re-emitted answer after a validation failure
 * replaces the prior attempt rather than appending to it).
 */
export type OnAnswerStart = () => void;

/**
 * Fired with each newly-decoded fragment of `answer_markdown` as the model
 * streams the submit_answer payload. The client appends each fragment.
 */
export type OnAnswerDelta = (text: string) => void;

/**
 * The agent entry point (src/agent/runtime.ts).
 *
 * Always resolves to a schema-valid `PokebotAnswer` for in-domain conditions
 * (never throws for unresolved entities / clarification / PokeAPI-down / loop-max
 * / invalid-after-retry — those surface as a `PokebotAnswer` with the right
 * `status`). Transport/API faults propagate as exceptions to the route.
 */
export type RunPokebot = (
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: OnProgress,
  onAnswerStart?: OnAnswerStart,
  onAnswerDelta?: OnAnswerDelta,
) => Promise<PokebotAnswer>;
