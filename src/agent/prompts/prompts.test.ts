import { describe, expect, it } from "vitest";

import {
  FEW_SHOT_EXAMPLES,
  FEW_SHOT_PROMPT,
  renderFewShot,
} from "@/agent/prompts/few-shot";
import { SYSTEM_PROMPT } from "@/agent/prompts/system";

describe("system prompt (transcribed verbatim from prompts.md)", () => {
  it("opens with the Oak identity line and closes with the answer-style rule", () => {
    expect(SYSTEM_PROMPT.startsWith("You are Oak, a knowledgeable")).toBe(
      true,
    );
    expect(
      SYSTEM_PROMPT.endsWith(
        "through submit_answer with citations, inferences, and generation_basis filled in.",
      ),
    ).toBe(true);
  });

  it("has no leading/trailing whitespace that would break the cache prefix", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.trim());
  });

  it("contains every section heading verbatim", () => {
    for (const heading of [
      "# Your goal",
      "# Data and generation rules",
      "# How to use your tools",
      "# Reasoning and transparency (non-negotiable)",
      "# Type effectiveness",
      "# Conversation",
      "# Scope — politely decline these (they are out of scope)",
      "# Answer style",
    ]) {
      expect(SYSTEM_PROMPT).toContain(heading);
    }
  });

  it("preserves the backticked field names from the doc", () => {
    expect(SYSTEM_PROMPT).toContain("pass them all in `moves`");
    expect(SYSTEM_PROMPT).toContain(
      "Put deductions in the\n  `inferences` field",
    );
    expect(SYSTEM_PROMPT).toContain("you relied on in `citations`");
  });

  it("preserves special characters (accent, em dash, multiplication sign)", () => {
    expect(SYSTEM_PROMPT).toContain("Pokémon");
    expect(SYSTEM_PROMPT).toContain("— most importantly —");
    expect(SYSTEM_PROMPT).toContain("Treat 0× as an IMMUNITY");
  });

  it("is byte-stable (same reference, deterministic)", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(2000);
  });
});

describe("few-shot examples (transcribed verbatim from prompts.md)", () => {
  it("has exactly the five examples A–E in order", () => {
    expect(FEW_SHOT_EXAMPLES.map((e) => e.id)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("carries each example's verbatim title and user message", () => {
    const byId = Object.fromEntries(FEW_SHOT_EXAMPLES.map((e) => [e.id, e]));
    expect(byId.A.title).toBe(
      "Example A — Mechanics interaction with a conditional (US-7, BR-3)",
    );
    expect(byId.A.user).toBe("does Fake Out work on Farigiraf?");
    expect(byId.B.user).toBe(
      "find me a Pokémon that can learn both Trick Room and Will-O-Wisp",
    );
    expect(byId.C.user).toBe("what can learn Will-o-Whisp");
    expect(byId.D.user).toBe(
      "what's Garchomp's Speed at level 50 with max Speed EVs and a Jolly nature",
    );
    expect(byId.E.user).toBe("what egg moves does Dratini get?");
  });

  it("ends every transcript in a submit_answer call", () => {
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(ex.transcript).toContain("→ submit_answer({");
      expect(ex.transcript.trimEnd().endsWith("})")).toBe(true);
    }
  });

  it("keeps JSON-escaped sequences as literal characters (not interpreted)", () => {
    // Example A: the answer_markdown contains literal backslash-n, not newlines.
    const a = FEW_SHOT_EXAMPLES.find((e) => e.id === "A")!;
    expect(a.transcript).toContain("Farigiraf's ability.\\n\\n- **If it has");
    // Example C: the embedded quotes stay backslash-escaped.
    const c = FEW_SHOT_EXAMPLES.find((e) => e.id === "C")!;
    expect(c.transcript).toContain('called \\"Will-o-Whisp\\" — did you mean');
  });

  it("preserves the abbreviated tool-call notation arrows", () => {
    const a = FEW_SHOT_EXAMPLES.find((e) => e.id === "A")!;
    expect(a.transcript).toContain('→ get_move({ name: "fake-out" })');
    expect(a.transcript).toContain('← { found: true, display_name: "Fake Out"');
  });

  it("renders a deterministic, byte-stable block matching FEW_SHOT_PROMPT", () => {
    expect(renderFewShot()).toBe(renderFewShot());
    expect(FEW_SHOT_PROMPT).toBe(renderFewShot());
    expect(FEW_SHOT_PROMPT).toContain(
      "### Example A — Mechanics interaction with a conditional (US-7, BR-3)",
    );
    expect(FEW_SHOT_PROMPT).toContain(
      "**User:** does Fake Out work on Farigiraf?",
    );
    // Each example fenced and present in order.
    const headingOrder = [
      "Example A",
      "Example B",
      "Example C",
      "Example D",
      "Example E",
    ].map((h) => FEW_SHOT_PROMPT.indexOf(h));
    expect(headingOrder).toEqual([...headingOrder].sort((x, y) => x - y));
    expect(headingOrder.every((i) => i >= 0)).toBe(true);
  });
});
