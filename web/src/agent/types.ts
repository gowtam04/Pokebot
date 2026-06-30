/**
 * Cross-phase agent contract types (design.md § Interface Definitions).
 *
 * These are the structural seams the runtime, tool layer, context factory, and
 * web route all share. Concrete implementations live elsewhere:
 *  - `AgentContext` is assembled in src/agent/context.ts (Phase 4),
 *  - `ToolDef[]` / `dispatch` are built in src/agent/tools/index.ts (Phase 4),
 *  - `runOak` is implemented in src/agent/runtime.ts (Phase 5).
 *
 * Schemas + the `OakAnswer` type are owned by src/agent/schemas.ts — import
 * from there, never redefine.
 */

import type { Logger } from "pino";
import type { ModelKey } from "@/agent/models";
import type { JsonSchema, OakAnswer } from "@/agent/schemas";

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
 * One image attached to the current user message. The canonical in-process
 * shape: the provider adapters format it for their wire protocol (Anthropic uses
 * the raw base64 + `mimeType`; OpenAI/xAI build a `data:` URL from both).
 *
 * `mimeType` is restricted to the set every provider accepts and is the type the
 * SERVER sniffed from the bytes (not the client's declared type) — Anthropic
 * 400s if the declared media type disagrees with the actual bytes. `data` is RAW
 * base64 with no `data:` prefix.
 */
export interface ImageAttachment {
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

/**
 * Per-request agent context. Built in src/agent/context.ts; threaded into every
 * tool `run` call and into `runOak`.
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
   * Which LLM answers this turn (server-controlled; defaults to the primary model, Grok).
   * Derived from the validated request body, bound here, and read by the runtime
   * to select the provider — exactly like {@link mode}, NEVER an LLM-visible tool
   * input. Cross-turn history is plain text, so switching models per turn is
   * correctness-safe.
   */
  model: ModelKey;
  /**
   * Per-request abort handle (the inbound request's `signal`). When the client
   * disconnects (e.g. the user presses Stop), the runtime forwards this to the
   * provider SDK so generation halts immediately and checks it between loop
   * iterations. Undefined for callers/tests that don't supply one.
   */
  signal?: AbortSignal;
  /**
   * The signed-in account id for the turn, or `undefined` for a guest. Bound by
   * the route (server-controlled, never an LLM input). Used by the team tools
   * (`list_teams`/`get_team`/`save_team`) to read/write account-scoped teams; the
   * rest of the agent layer never sees it.
   */
  accountId?: string;
  /**
   * The conversation id for the turn (same value passed to the logger). Bound by
   * the route, used for correlation.
   */
  sessionId?: string;
  /**
   * The most recent team the agent proposed earlier in THIS conversation
   * (extracted from stored `answer_json.proposed_team` by the route). Server-
   * bound like {@link activeTeam}; lets `save_team` persist the EXACT set the
   * user saw on approval, with no model re-typing. `undefined` ⇒ none pending.
   */
  proposedTeam?: import("@/agent/schemas").ProposedTeam;
  /**
   * MUTABLE result slot: `save_team` sets this to the team it persisted. The
   * route reads it after the loop to stamp `answer.saved_team` authoritatively.
   * `undefined` ⇒ nothing saved.
   */
  savedTeam?: import("@/agent/schemas").SavedTeam;
  /**
   * Images attached to THIS turn's user message (validated + sniffed by the
   * route). Server-bound and handed straight to the model in the current user
   * message — never routed through any content-specific preprocessing; the model
   * decides what the image is. Consume-on-turn: images are NOT stored in history,
   * so this only ever carries the current turn's attachments. `undefined`/empty ⇒
   * a text-only turn (the providers then keep `content` a plain string).
   */
  images?: ImageAttachment[];
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
 * Always resolves to a schema-valid `OakAnswer` for in-domain conditions
 * (never throws for unresolved entities / clarification / PokeAPI-down / loop-max
 * / invalid-after-retry — those surface as a `OakAnswer` with the right
 * `status`). Transport/API faults propagate as exceptions to the route.
 */
export type RunOak = (
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: OnProgress,
  onAnswerStart?: OnAnswerStart,
  onAnswerDelta?: OnAnswerDelta,
) => Promise<OakAnswer>;
