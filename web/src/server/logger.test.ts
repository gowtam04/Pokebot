import pino from "pino";
import { describe, expect, it } from "vitest";
import { logTurn, type TurnTrace } from "@/server/logger";

function makeTrace(): TurnTrace {
  return {
    request_id: "req_123",
    session_id: "sess_abc",
    model: "claude-sonnet-4-6",
    input_tokens: 1200,
    output_tokens: 340,
    thinking_tokens: 80,
    tool_trace: [
      {
        tool: "query_pokedex",
        args: { types: ["ground"] },
        latency_ms: 12,
        cache_hit: false,
        error: null,
      },
    ],
    turn_latency_ms: 2100,
    status: "answered",
    citation_count: 3,
  };
}

describe("logTurn", () => {
  it("emits one structured JSON line carrying every required field", () => {
    const lines: string[] = [];
    const captureLogger = pino(
      { level: "info" },
      { write: (chunk: string) => lines.push(chunk) },
    );

    const trace = makeTrace();
    logTurn(trace, captureLogger);

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);

    // integration.md / design.md A7 required field set.
    expect(record.event).toBe("turn");
    expect(record.request_id).toBe("req_123");
    expect(record.session_id).toBe("sess_abc");
    expect(record.model).toBe("claude-sonnet-4-6");
    expect(record.input_tokens).toBe(1200);
    expect(record.output_tokens).toBe(340);
    expect(record.thinking_tokens).toBe(80);
    expect(record.turn_latency_ms).toBe(2100);
    expect(record.status).toBe("answered");
    expect(record.citation_count).toBe(3);
    expect(Array.isArray(record.tool_trace)).toBe(true);
    expect(record.tool_trace[0]).toMatchObject({
      tool: "query_pokedex",
      latency_ms: 12,
      cache_hit: false,
      error: null,
    });
  });
});
