/**
 * Agent runtime — `runOak` (design.md § Agent runtime; agent-design
 * integration.md § Invocation Signature). Phase 5.
 *
 * Drives one provider-NEUTRAL tool-loop turn. The transport (which model/SDK
 * answers, the request shape, the streaming vocabulary, the message shaping)
 * lives behind an {@link LLMProvider} — `ctx.model` selects Claude (default),
 * OpenAI GPT-5.5, or xAI Grok 4.3 via the provider factory. The loop itself is
 * model-agnostic:
 *   1. Build the provider-tuned system prompt for `(provider, mode)` via
 *      `buildSystemSegments`, and the provider-owned opaque transcript (prior
 *      in-session `history` then the current `message`). The provider-neutral
 *      tool defs are built once at module load.
 *   2. Loop ≤ 10 iterations. The provider opens a streaming turn; the loop reads
 *      NORMALIZED stream events, feeding the submit_answer arg-JSON into the
 *      AnswerMarkdownExtractor for token-by-token deltas. (Claude uses adaptive
 *      thinking + tool_choice "auto" — the Sonnet-4.6 forced-tool_choice-400
 *      gotcha; submit_answer is driven by the prompt + this max-iteration guard,
 *      never forced. OpenAI/xAI map effort to reasoning_effort.)
 *   3. Echo the assistant content back opaquely, dispatch every tool call, and
 *      hand the provider-shaped tool results back in the next message(s).
 *   4. On `submit_answer`, validate the payload against the OakAnswer Zod
 *      schema. Valid → return it. Invalid → return the validation error and
 *      request a re-emit (≤ 2). After the budget is exhausted — or the iteration
 *      cap, or a turn with no tool call — synthesize an `insufficient_data`
 *      OakAnswer.
 *   5. Emit `onProgress` once per tool call, and assemble + log the per-turn
 *      pino trace (integration.md § Observability Hooks).
 *
 * Never throws for in-domain failures (unresolved entity / clarification /
 * PokeAPI down / loop-max / invalid-after-retry surface as a OakAnswer with
 * the right `status`). Transport/API faults from the provider stream propagate to
 * the route as exceptions (sse-types.ts: those become an `error` event).
 */

import { dispatch, tools } from "@/agent/tools";
import { buildSystemSegments } from "@/agent/prompts";
import { MAX_TOKENS } from "@/agent/providers/constants";
import {
  AnthropicProvider,
  type AnthropicClientLike,
  type MessageStreamLike,
} from "@/agent/providers/anthropic-provider";
import { providerFor } from "@/agent/providers/factory";
import type {
  LLMProvider,
  NormalizedUsage,
  ProviderToolDef,
  ToolResult,
} from "@/agent/providers/types";
import {
  oakAnswerSchema,
  type OakAnswer,
  type PokemonProfile,
} from "@/agent/schemas";
import { enrichAnswer } from "@/agent/enrich-answer";
import type {
  AgentContext,
  ChatMessage,
  OnAnswerDelta,
  OnAnswerStart,
  OnProgress,
  RunOak,
} from "@/agent/types";
import { logTurn, type ToolTraceEntry, type TurnTrace } from "@/server/logger";

// Re-exported for back-compat (was previously declared here). The value lives in
// the provider constants module so adapters can read it without an import cycle;
// the Anthropic client-seam types moved to the provider but stay re-exported here
// because the eval harness + tests inject a scripted client through this module.
export { MAX_TOKENS };
export type { AnthropicClientLike, MessageStreamLike };

// ---------------------------------------------------------------------------
// Loop constants (integration.md § Guardrails — enforced by the loop, not the
// prompt).
// ---------------------------------------------------------------------------

/** Hard cap on model turns per user message (integration.md / D-loop). */
export const MAX_ITERATIONS = 10;

/** Re-emit budget when a `submit_answer` payload fails schema validation. */
export const MAX_SUBMIT_RETRIES = 2;

/**
 * Re-prompt budget when the model ends a turn with no tool call at all (it wrote
 * prose instead of calling submit_answer). `tool_choice` is never forced (the
 * Sonnet-4.6 thinking + forced-tool_choice 400), so the model occasionally skips
 * the tool — especially on a terse follow-up after a clarification turn, where the
 * plain-text history makes the exchange look like an ordinary chat. We nudge it
 * back to submit_answer rather than discarding the answer.
 */
export const MAX_EMPTY_TURN_NUDGES = 2;

/** The corrective user turn appended after an empty (no-tool) model turn. */
const EMPTY_TURN_NUDGE =
  "You ended your turn without calling submit_answer. submit_answer is the " +
  "ONLY way to reply. Call submit_answer now with your complete answer (or a " +
  "clarification_needed payload if you genuinely still need to ask). Do not " +
  "reply with plain text.";

// ---------------------------------------------------------------------------
// Provider-neutral tool definitions (T1..T11 plus the inlined T12
// get_active_team). `name` / `parameters` come straight from the tool layer
// (schemas.ts is the single source); built once and never reordered between
// turns (reordering would invalidate the prompt cache). Each provider adapter
// maps these to its own tool shape (Anthropic input_schema / OpenAI function).
// ---------------------------------------------------------------------------

const PROVIDER_TOOL_DEFS: ProviderToolDef[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
}));

// ---------------------------------------------------------------------------
// Progress labels (integration.md § UI Consumer Contract — "stream tool-activity
// labels … so the UI shows motion").
// ---------------------------------------------------------------------------

const PROGRESS_LABELS: Record<string, string> = {
  resolve_entity: "🔍 Resolving name…",
  query_pokedex: "📊 Searching the Pokédex…",
  get_pokemon: "📇 Looking up Pokémon…",
  get_move: "⚔️ Looking up move…",
  get_ability: "✨ Looking up ability…",
  get_type_matchups: "🛡️ Checking type matchups…",
  get_evolution_chain: "🧬 Tracing evolution…",
  get_item: "🎒 Looking up item…",
  compute_stat: "🧮 Computing stat…",
  estimate_damage: "💥 Estimating damage…",
  submit_answer: "✍️ Composing the answer…",
  get_active_team: "📋 Reading your active team…",
};

/** The generic per-tool label, used as the fallback when args are unusable. */
function progressLabel(tool: string): string {
  return PROGRESS_LABELS[tool] ?? `Running ${tool}…`;
}

/**
 * Title-cases a slug/name for display in a progress label, preserving internal
 * separators: `"will-o-wisp"` → `"Will-O-Wisp"`, `"iron hands"` → `"Iron Hands"`,
 * `"garchomp"` → `"Garchomp"`. Returns "" for non-strings/empties so callers can
 * fall back to the generic label. Only the first letter after a word boundary is
 * uppercased (existing casing is left intact), and the result is length-capped so
 * a pathological input can't bloat the label.
 */
export function titleizeSlug(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim().replace(/_/g, " ").slice(0, 48);
  if (!cleaned) return "";
  return cleaned.replace(/(^|[\s-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
}

const STAT_FILTER_LABELS: Record<string, string> = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  special_attack: "Sp. Atk",
  special_defense: "Sp. Def",
  speed: "Speed",
  base_stat_total: "BST",
};

const STAT_OP_LABELS: Record<string, string> = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  "==": "=",
};

/** Pulls the string members out of a value that may or may not be an array. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Joins the present query_pokedex filters into a readable "Fire · Speed > 100 · learns Will-O-Wisp" clause. */
function describePokedexFilters(obj: Record<string, unknown>): string {
  const parts: string[] = [];

  const types = asStringList(obj.types).map(titleizeSlug).filter(Boolean);
  if (types.length) parts.push(types.join("/"));

  const abilities = asStringList(obj.abilities).map(titleizeSlug).filter(Boolean);
  if (abilities.length) parts.push(abilities.join(", "));

  const moves = asStringList(obj.moves).map(titleizeSlug).filter(Boolean);
  if (moves.length) parts.push(`learns ${moves.join(", ")}`);

  if (Array.isArray(obj.stat_filters)) {
    for (const f of obj.stat_filters) {
      if (!f || typeof f !== "object") continue;
      const sf = f as Record<string, unknown>;
      const stat = typeof sf.stat === "string" ? STAT_FILTER_LABELS[sf.stat] ?? sf.stat : null;
      const op = typeof sf.op === "string" ? STAT_OP_LABELS[sf.op] ?? sf.op : null;
      const val = typeof sf.value === "number" ? sf.value : null;
      if (stat && op && val !== null) parts.push(`${stat} ${op} ${val}`);
    }
  }

  return parts.join(" · ");
}

/**
 * Builds a human-readable, context-rich progress label for one tool call by
 * enriching the generic per-tool verb with the concrete subject from the model's
 * `input`. Input is model-supplied and untrusted, so every field read is guarded
 * and any missing/malformed field falls back to the generic `progressLabel`.
 */
export function describeToolCall(tool: string, input: unknown): string {
  const base = progressLabel(tool);
  const obj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  switch (tool) {
    case "resolve_entity": {
      const q = typeof obj.query === "string" ? obj.query.trim() : "";
      return q ? `🔍 Resolving “${q.slice(0, 48)}”…` : base;
    }
    case "query_pokedex": {
      const filters = describePokedexFilters(obj);
      return filters ? `📊 Searching the Pokédex: ${filters}…` : base;
    }
    case "get_pokemon": {
      const name = titleizeSlug(obj.name);
      return name ? `📇 Looking up ${name}…` : base;
    }
    case "get_move": {
      const name = titleizeSlug(obj.name);
      return name ? `⚔️ Looking up the move ${name}…` : base;
    }
    case "get_ability": {
      const name = titleizeSlug(obj.name);
      return name ? `✨ Reading the ${name} ability…` : base;
    }
    case "get_type_matchups": {
      const types = asStringList(obj.types).map(titleizeSlug).filter(Boolean);
      return types.length ? `🛡️ Checking ${types.join("/")} matchups…` : base;
    }
    case "get_evolution_chain": {
      const name = titleizeSlug(obj.species);
      return name ? `🧬 Tracing ${name}’s evolution…` : base;
    }
    case "get_item": {
      const name = titleizeSlug(obj.name);
      return name ? `🎒 Looking up ${name}…` : base;
    }
    case "compute_stat": {
      const lvl = typeof obj.level === "number" ? obj.level : null;
      return lvl ? `🧮 Computing a stat at Lv ${lvl}…` : "🧮 Computing a stat…";
    }
    case "estimate_damage":
      return "💥 Running the damage calc…";
    case "submit_answer":
      return "✍️ Composing the answer…";
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Incremental answer_markdown extractor (token-by-token streaming)
// ---------------------------------------------------------------------------

/**
 * Pulls the growing, decoded value of the top-level `answer_markdown` string out
 * of the accumulating `partial_json` fragments of a streaming submit_answer tool
 * input. Only a `submit_answer` input has an `answer_markdown` field, so feeding
 * this just the submit_answer block's deltas is sufficient.
 *
 * `push(fragment)` returns ONLY the newly-decoded characters (or "") so the
 * caller can forward them as an `answer_delta`. Concatenating every return value
 * reproduces the decoded `answer_markdown` prefix seen so far — and, once the
 * value's closing quote arrives, equals the final `answer.answer_markdown`.
 *
 * SDK-version-independent: it consumes only raw JSON text and decodes JSON string
 * escapes itself (\n \t \r \b \f \/ \\ \" and \uXXXX incl. surrogate pairs),
 * never emitting a partial escape and never splitting an escaped surrogate pair
 * across two chunks. Keys may appear in any order; non-target values (objects,
 * arrays, strings, primitives) are fully skipped, so a `reasoning_markdown` value
 * that contains the literal substring `"answer_markdown"` cannot misfire.
 */
export class AnswerMarkdownExtractor {
  private state:
    | "before_object"
    | "at_root"
    | "key_string"
    | "after_key"
    | "before_value"
    | "target_value"
    | "skip_value"
    | "done" = "before_object";

  private keyBuf = "";
  private targetKey = false;

  // Shared JSON-string decode state (key_string + target_value).
  private escape = false;
  private uHex: string | null = null; // collecting \uXXXX digits when non-null
  private pendingHigh: number | null = null; // buffered escaped high surrogate

  // skip_value state.
  private skipDepth = 0;
  private skipInString = false;
  private skipEscape = false;
  private skipStarted = false;

  /** Feed one `partial_json` fragment; returns newly-decoded answer_markdown. */
  push(fragment: string): string {
    let out = "";
    for (let i = 0; i < fragment.length; i++) {
      if (this.state === "done") break;
      out += this.feed(fragment[i]!);
    }
    return out;
  }

  private resetStringState(): void {
    this.escape = false;
    this.uHex = null;
    this.pendingHigh = null;
  }

  private flushPendingHigh(): string {
    if (this.pendingHigh !== null) {
      const s = String.fromCharCode(this.pendingHigh);
      this.pendingHigh = null;
      return s;
    }
    return "";
  }

  private feed(ch: string): string {
    switch (this.state) {
      case "before_object":
        if (ch === "{") this.state = "at_root";
        return "";
      case "at_root":
        if (ch === '"') {
          this.keyBuf = "";
          this.resetStringState();
          this.state = "key_string";
        } else if (ch === "}") {
          this.state = "done";
        }
        return "";
      case "key_string": {
        const r = this.decodeStringChar(ch);
        if (r.closed) {
          this.targetKey = this.keyBuf === "answer_markdown";
          this.state = "after_key";
        } else {
          this.keyBuf += r.char;
        }
        return "";
      }
      case "after_key":
        if (ch === ":") this.state = "before_value";
        return "";
      case "before_value":
        if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") return "";
        if (this.targetKey && ch === '"') {
          this.resetStringState();
          this.state = "target_value";
          return "";
        }
        // Non-target key, or a target value that isn't a string — skip it whole.
        this.startSkip();
        return this.feedSkip(ch);
      case "target_value": {
        const r = this.decodeStringChar(ch);
        if (r.closed) {
          this.state = "done";
          return r.char;
        }
        return r.char;
      }
      case "skip_value":
        return this.feedSkip(ch);
      case "done":
        return "";
    }
  }

  /** Decode one char of a JSON string. `closed` marks the unescaped end quote. */
  private decodeStringChar(ch: string): { char: string; closed: boolean } {
    if (this.uHex !== null) {
      this.uHex += ch;
      if (this.uHex.length < 4) return { char: "", closed: false };
      const code = parseInt(this.uHex, 16);
      this.uHex = null;
      if (Number.isNaN(code)) return { char: "", closed: false };
      if (code >= 0xd800 && code <= 0xdbff) {
        const flushed = this.flushPendingHigh();
        this.pendingHigh = code;
        return { char: flushed, closed: false };
      }
      if (code >= 0xdc00 && code <= 0xdfff && this.pendingHigh !== null) {
        const s = String.fromCharCode(this.pendingHigh, code);
        this.pendingHigh = null;
        return { char: s, closed: false };
      }
      return {
        char: this.flushPendingHigh() + String.fromCharCode(code),
        closed: false,
      };
    }

    if (this.escape) {
      this.escape = false;
      const lead = this.flushPendingHigh();
      switch (ch) {
        case "n":
          return { char: lead + "\n", closed: false };
        case "t":
          return { char: lead + "\t", closed: false };
        case "r":
          return { char: lead + "\r", closed: false };
        case "b":
          return { char: lead + "\b", closed: false };
        case "f":
          return { char: lead + "\f", closed: false };
        case "/":
          return { char: lead + "/", closed: false };
        case "\\":
          return { char: lead + "\\", closed: false };
        case '"':
          return { char: lead + '"', closed: false };
        case "u":
          // A high surrogate buffered before this \u must wait for the result.
          if (lead) this.pendingHighReinstate(lead);
          this.uHex = "";
          return { char: "", closed: false };
        default:
          return { char: lead + ch, closed: false };
      }
    }

    if (ch === "\\") {
      this.escape = true;
      return { char: "", closed: false };
    }
    if (ch === '"') {
      return { char: this.flushPendingHigh(), closed: true };
    }
    return { char: this.flushPendingHigh() + ch, closed: false };
  }

  // The `\u` escape branch flushes pendingHigh into `lead`, but a high surrogate
  // immediately followed by `\u` is the start of a surrogate PAIR — re-buffer it
  // so the low surrogate can combine. (Only reachable for back-to-back \u.)
  private pendingHighReinstate(lead: string): void {
    if (lead.length === 1) this.pendingHigh = lead.charCodeAt(0);
  }

  private startSkip(): void {
    this.state = "skip_value";
    this.skipDepth = 0;
    this.skipInString = false;
    this.skipEscape = false;
    this.skipStarted = false;
  }

  private feedSkip(ch: string): string {
    if (this.skipInString) {
      if (this.skipEscape) {
        this.skipEscape = false;
      } else if (ch === "\\") {
        this.skipEscape = true;
      } else if (ch === '"') {
        this.skipInString = false;
        if (this.skipDepth === 0) this.state = "at_root";
      }
      return "";
    }

    if (!this.skipStarted) {
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") return "";
      this.skipStarted = true;
      if (ch === '"') {
        this.skipInString = true;
        return "";
      }
      if (ch === "{" || ch === "[") {
        this.skipDepth = 1;
        return "";
      }
      // Primitive (number / true / false / null) — fall through.
    }

    if (ch === '"') {
      this.skipInString = true;
      return "";
    }
    if (ch === "{" || ch === "[") {
      this.skipDepth++;
      return "";
    }
    if (ch === "}" || ch === "]") {
      if (this.skipDepth > 0) {
        this.skipDepth--;
        if (this.skipDepth === 0) this.state = "at_root";
        return "";
      }
      // A primitive ended on the parent's closing brace — re-dispatch it.
      this.state = "at_root";
      return this.feed(ch);
    }
    if (this.skipDepth === 0) {
      if (ch === ",") {
        this.state = "at_root";
        return this.feed(ch);
      }
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
        this.state = "at_root";
      }
      // else: still mid-primitive token (digits, letters) — keep consuming.
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact a Zod issue list into a single human/model-readable string. */
function formatZodIssues(error: import("zod").ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Build a schema-valid `insufficient_data` answer for the orchestration-level
 * fallbacks (loop-max, invalid-after-retries, no-submit). Never user-blaming;
 * states plainly that the turn couldn't be completed (integration.md).
 */
function synthesizeInsufficientData(reason: string): OakAnswer {
  return {
    status: "insufficient_data",
    answer_markdown:
      "I wasn't able to put together a reliable answer for that this time. " +
      "Could you rephrase or narrow the question, and I'll try again?",
    reasoning_markdown:
      "The agent could not complete this turn through its normal tool loop, " +
      "so it is reporting insufficient data rather than guessing.",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
    uncertainty_flags: [reason],
  };
}

/**
 * Last-resort recovery when the model keeps ending its turn with prose and never
 * calls submit_answer (nudge budget exhausted). Rather than discard the prose and
 * show the generic apology, wrap it in a schema-valid `answered` payload — flagged
 * so the trace records that it bypassed the structured tool path. No citations or
 * inferences are available (the model never supplied them).
 */
function synthesizeFromProse(prose: string): OakAnswer {
  return {
    status: "answered",
    answer_markdown: prose,
    reasoning_markdown:
      "The model produced this answer as plain text without calling " +
      "submit_answer, so it carries no structured citations or inferences.",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
    uncertainty_flags: ["recovered_prose_no_submit_answer"],
  };
}

/** Read the session id off the (correlation-tagged) child logger, if present. */
function sessionIdOf(ctx: AgentContext): string {
  const logger = ctx.logger as { bindings?: () => Record<string, unknown> };
  if (typeof logger.bindings === "function") {
    const bound = logger.bindings();
    if (typeof bound.session_id === "string") {
      return bound.session_id;
    }
  }
  return "";
}

/** Mutable accumulator for the per-turn trace, finalized in {@link finalize}. */
interface TraceState {
  startedAt: number;
  /** The concrete API model id answering this turn (provider.apiModelId). */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTrace: ToolTraceEntry[];
}

/** Fold one turn's normalized usage into the running trace totals. */
function accumulateUsage(state: TraceState, usage: NormalizedUsage): void {
  state.inputTokens += usage.inputTokens;
  state.outputTokens += usage.outputTokens;
  state.thinkingTokens += usage.thinkingTokens;
}

/**
 * Assemble + emit the per-turn pino trace (integration.md § Observability
 * Hooks) and return the answer. `cache_hit` is recorded as `false` for every
 * entry: the read-through cache hit/miss lives inside the data layer and is not
 * observable from the runtime seam.
 */
function finalize(
  answer: OakAnswer,
  state: TraceState,
  ctx: AgentContext,
): OakAnswer {
  const trace: TurnTrace = {
    request_id: ctx.requestId,
    session_id: sessionIdOf(ctx),
    model: state.modelId,
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    thinking_tokens: state.thinkingTokens,
    tool_trace: state.toolTrace,
    turn_latency_ms: Date.now() - state.startedAt,
    status: answer.status,
    citation_count: answer.citations.length,
  };
  logTurn(trace, ctx.logger);
  return answer;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Run the tool-loop against an explicit {@link LLMProvider}. The loop is fully
 * provider-NEUTRAL: it owns the opaque transcript, schema validation, the
 * re-emit budget, insufficient_data synthesis, the trace, and the
 * AnswerMarkdownExtractor; the provider owns only the transport (request shape,
 * normalized stream events, message shaping). Exposed for tests (a fake provider
 * / the OpenAI provider) and used by both entry points below.
 */
export async function runWithProvider(
  provider: LLMProvider,
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: OnProgress,
  onAnswerStart?: OnAnswerStart,
  onAnswerDelta?: OnAnswerDelta,
): Promise<OakAnswer> {
  const state: TraceState = {
    startedAt: Date.now(),
    modelId: provider.apiModelId,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    toolTrace: [],
  };

  // The opaque, provider-owned transcript: prior in-session turns + the current
  // message (with any attached images, consume-on-turn from ctx.images). The loop
  // only ever PUSHES provider-produced values into it.
  const transcript = provider.createTranscript(history, message, ctx.images);

  // Server-controlled scope + provider together select the tuned system prompt
  // (loop-invariant). Built once per turn; the same byte-identical segments are
  // sent every iteration, preserving each provider's prompt cache.
  const systemSegments = buildSystemSegments({
    provider: provider.kind,
    mode: ctx.mode,
  });

  let submitRetries = 0;
  let emptyTurnNudges = 0;

  // get_pokemon profiles fetched this turn — used by answer enrichment to
  // synthesize subjects[] when the model omits it on a single-entity answer.
  const lookedUpProfiles: PokemonProfile[] = [];

  // Emit the "reasoning…" progress tick at most once per turn (UX for models like
  // Grok that stream a long reasoning phase before the answer arrives at once).
  let reasoningNudged = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Bail if the client disconnected (user pressed Stop) during the prior tool
    // dispatch — covers the gap between the provider-level aborts. Thrown as an
    // AbortError so it propagates to the route like any transport fault (where it
    // is recognized via req.signal.aborted and not surfaced as an error event).
    if (ctx.signal?.aborted) {
      throw new DOMException("Aborted by client", "AbortError");
    }

    // Transport/API faults here propagate to the route (NOT caught). The signal
    // is forwarded so an in-flight stream is torn down immediately on Stop.
    const stream = provider.streamTurn({
      system: systemSegments,
      tools: PROVIDER_TOOL_DEFS,
      transcript,
      signal: ctx.signal,
    });

    // Stream answer_markdown out of the submit_answer tool args as they arrive.
    // Keyed on the tool-call index so parallel tool calls stay isolated; a
    // re-emitted submit_answer (after a validation failure) starts a fresh call
    // → fresh onAnswerStart → the client resets its buffer.
    let submitIndex: number | null = null;
    let extractor: AnswerMarkdownExtractor | null = null;
    // Captured for the prose fallback if this turn ends with no tool call.
    let assistantText = "";
    for await (const event of stream) {
      if (event.type === "tool_call_start") {
        if (event.name === "submit_answer") {
          submitIndex = event.index;
          extractor = new AnswerMarkdownExtractor();
          onAnswerStart?.();
        }
      } else if (
        event.type === "tool_call_args_delta" &&
        event.index === submitIndex &&
        extractor !== null
      ) {
        const chunk = extractor.push(event.argChunk);
        if (chunk) onAnswerDelta?.(chunk);
      } else if (
        event.type === "tool_call_stop" &&
        event.index === submitIndex
      ) {
        submitIndex = null;
        extractor = null;
      } else if (event.type === "text_delta") {
        assistantText += event.text;
      } else if (event.type === "thinking_delta" && !reasoningNudged) {
        // Surface a single "reasoning…" tick so a long pre-answer reasoning phase
        // (e.g. Grok at reasoning_effort:high) reads as progress, not a stall.
        reasoningNudged = true;
        onProgress?.({ tool: "reasoning", label: "🤔 Reasoning…" });
      }
    }

    // Drain the stream into a normalized final turn.
    const final = await stream.final();

    accumulateUsage(state, final.usage);

    // Echo the assistant content back opaquely (the provider preserves whatever
    // its API needs for multi-turn continuity: thinking + tool_use blocks for
    // Anthropic, the assistant message + tool_calls for OpenAI).
    transcript.push(final.assistantContentToEcho);

    const toolCalls = final.toolCalls;

    // Model ended its turn without calling any tool — it never submitted an
    // answer. Nudge it back to submit_answer (the assistant turn was already
    // echoed above, so appending a user message keeps the transcript valid).
    // Only after the nudge budget is spent do we give up: surface the prose the
    // model wrote if we have any, else the generic insufficient_data apology.
    if (toolCalls.length === 0) {
      if (emptyTurnNudges < MAX_EMPTY_TURN_NUDGES) {
        emptyTurnNudges += 1;
        transcript.push(provider.buildUserMessage(EMPTY_TURN_NUDGE));
        continue;
      }
      const prose = assistantText.trim();
      return finalize(
        prose.length > 0
          ? synthesizeFromProse(prose)
          : synthesizeInsufficientData("model_ended_turn_without_submit_answer"),
        state,
        ctx,
      );
    }

    // One ToolResult per tool call. Built provider-neutral, then handed to the
    // provider to shape into the next transcript message(s) (Anthropic: one user
    // message of tool_result blocks; OpenAI: one {role:"tool"} message each).
    const toolResults: ToolResult[] = [];
    let validAnswer: OakAnswer | null = null;
    let submitFailed = false;

    for (const call of toolCalls) {
      onProgress?.({
        tool: call.name,
        label: describeToolCall(call.name, call.input),
      });

      if (call.name === "submit_answer") {
        const started = Date.now();
        const parsed = oakAnswerSchema.safeParse(call.input);
        if (parsed.success) {
          validAnswer = parsed.data;
          state.toolTrace.push({
            tool: call.name,
            args: call.input,
            latency_ms: Date.now() - started,
            cache_hit: false,
            error: null,
          });
          toolResults.push({
            toolCallId: call.id,
            content: "Answer accepted.",
            isError: false,
          });
        } else {
          submitFailed = true;
          const detail = formatZodIssues(parsed.error);
          state.toolTrace.push({
            tool: call.name,
            args: call.input,
            latency_ms: Date.now() - started,
            cache_hit: false,
            error: detail,
          });
          toolResults.push({
            toolCallId: call.id,
            isError: true,
            content:
              `Your submit_answer payload failed validation: ${detail}. ` +
              "Call submit_answer again with a corrected payload that matches " +
              "the required schema.",
          });
        }
        continue;
      }

      // A regular read/compute tool. The tool layer returns structured shapes
      // and never throws in-domain; a genuine throw (e.g. a DB fault) is caught
      // here so one bad tool can't kill the turn — it is fed back so the model
      // can recover or report insufficient_data.
      const started = Date.now();
      let result: unknown;
      let errorMessage: string | null = null;
      try {
        result = await dispatch(call.name, call.input, ctx);
        // Stash successful single-Pokémon profiles for subjects[] enrichment.
        if (
          call.name === "get_pokemon" &&
          result &&
          typeof result === "object" &&
          (result as { found?: unknown }).found === true
        ) {
          lookedUpProfiles.push(result as PokemonProfile);
        }
      } catch (caught) {
        errorMessage =
          caught instanceof Error ? caught.message : String(caught);
        result = { error: "tool_error", detail: errorMessage };
      }
      state.toolTrace.push({
        tool: call.name,
        args: call.input,
        latency_ms: Date.now() - started,
        cache_hit: false,
        error: errorMessage,
      });
      toolResults.push({
        toolCallId: call.id,
        content: JSON.stringify(result),
        isError: Boolean(errorMessage),
      });
    }

    // A valid answer terminates the turn immediately (no further API call, so
    // the unused tool_results are harmless). Enrich it first — backfill
    // sprite_url/dex_number/types (and derive subjects[] when absent) so sprites
    // are model-independent. Enrichment never throws and never weakens the answer.
    if (validAnswer) {
      const enriched = await enrichAnswer(validAnswer, ctx, lookedUpProfiles);
      return finalize(enriched, state, ctx);
    }

    // submit_answer was emitted but invalid: re-emit up to the budget, then
    // synthesize insufficient_data.
    if (submitFailed) {
      submitRetries += 1;
      if (submitRetries > MAX_SUBMIT_RETRIES) {
        return finalize(
          synthesizeInsufficientData("submit_answer_invalid_after_retries"),
          state,
          ctx,
        );
      }
    }

    // Hand the tool results back (provider-shaped) and loop.
    for (const m of provider.buildToolResultMessages(toolResults)) {
      transcript.push(m);
    }
  }

  // Iteration cap reached without a valid submit_answer.
  return finalize(
    synthesizeInsufficientData("max_iterations_reached"),
    state,
    ctx,
  );
}

/**
 * Run the tool-loop against a raw Anthropic client. Retained as the existing
 * test seam (recorded-transcript injection wraps a fake client in the Anthropic
 * provider); production goes through {@link runOak}.
 */
export async function runOakWith(
  client: AnthropicClientLike,
  message: string,
  history: ChatMessage[],
  ctx: AgentContext,
  onProgress?: OnProgress,
  onAnswerStart?: OnAnswerStart,
  onAnswerDelta?: OnAnswerDelta,
): Promise<OakAnswer> {
  const provider = new AnthropicProvider({}, client);
  return runWithProvider(
    provider,
    message,
    history,
    ctx,
    onProgress,
    onAnswerStart,
    onAnswerDelta,
  );
}

/**
 * The agent entry point. Selects the provider for `ctx.model` (default Grok),
 * runs the tool-loop, and returns a schema-valid OakAnswer. See the module
 * header for the full contract.
 */
export const runOak: RunOak = (
  message,
  history,
  ctx,
  onProgress,
  onAnswerStart,
  onAnswerDelta,
) =>
  runWithProvider(
    providerFor(ctx.model),
    message,
    history,
    ctx,
    onProgress,
    onAnswerStart,
    onAnswerDelta,
  );

export default runOak;
