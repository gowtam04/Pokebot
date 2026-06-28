import pino, { type Logger } from "pino";

/**
 * Structured pino logger → stdout (design.md decision A7).
 *
 * Reads LOG_LEVEL directly from process.env rather than importing src/env.ts:
 * the logger is also used by the ingest/eval tsx scripts, which must not be
 * forced to supply ANTHROPIC_API_KEY just to log. No secrets or PII are ever
 * logged (none exist in this single-user app).
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export type TurnStatus =
  | "answered"
  | "resolution_failed"
  | "clarification_needed"
  | "insufficient_data";

/** One entry in the per-turn tool-call trace. */
export interface ToolTraceEntry {
  tool: string;
  args: unknown;
  latency_ms: number;
  cache_hit: boolean;
  error: string | null;
}

/**
 * The full per-turn trace. Field set is fixed by agent-design/integration.md
 * § Observability Hooks and design.md § Code Conventions (Logging, A7):
 * request_id, session_id, model, input/output/thinking tokens, the full
 * tool-call trace, total turn latency, final status, and citation count.
 */
export interface TurnTrace {
  request_id: string;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  tool_trace: ToolTraceEntry[];
  turn_latency_ms: number;
  status: TurnStatus;
  citation_count: number;
}

/**
 * Emit a single structured JSON log line for one completed agent turn.
 * The `log` parameter is injectable so callers (and tests) can target a
 * specific destination; it defaults to the shared module logger.
 */
export function logTurn(trace: TurnTrace, log: Logger = logger): void {
  log.info({ event: "turn", ...trace }, "oak_turn");
}
