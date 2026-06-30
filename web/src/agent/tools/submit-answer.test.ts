/**
 * Focused unit tests for submit_answer (T11) — not covered by the oracle suite.
 *
 * Asserts the validation contract: a schema-valid OakAnswer echoes back; an
 * invalid payload resolves to { error: "invalid_input", detail } (so the runtime
 * can request a re-emit) and NEVER throws.
 */

import { describe, expect, it } from "vitest";

import { submitAnswerTool } from "./submit-answer";
import type { OakAnswer } from "@/agent/schemas";

const valid: OakAnswer = {
  status: "answered",
  answer_markdown: "Garchomp is Dragon/Ground.",
  reasoning_markdown: "Looked up the profile.",
  citations: [{ source: "Pokédex index", detail: "Garchomp #445" }],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

describe("submit_answer (T11)", () => {
  it("has the canonical name and a generated object input schema", () => {
    expect(submitAnswerTool.name).toBe("submit_answer");
    expect(submitAnswerTool.inputSchema).toMatchObject({ type: "object" });
  });

  it("echoes a valid OakAnswer back unchanged", async () => {
    const out = await submitAnswerTool.run(valid, {} as never);
    expect(out).toEqual(valid);
  });

  it("returns invalid_input (never throws) on a bad payload", async () => {
    let out: unknown;
    await expect(
      (async () => {
        out = await submitAnswerTool.run(
          { status: "answered" }, // missing required fields
          {} as never,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(out).toMatchObject({ error: "invalid_input" });
    expect((out as { detail: string }).detail).toEqual(expect.any(String));
  });

  it("rejects an unknown status enum value", async () => {
    const out = await submitAnswerTool.run(
      { ...valid, status: "totally_made_up" },
      {} as never,
    );
    expect(out).toMatchObject({ error: "invalid_input" });
  });
});
