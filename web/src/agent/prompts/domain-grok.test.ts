/**
 * Tests for the Grok-NATIVE domain body (`./domain-grok`) — the default model's
 * prompt. Pins the XML-section structure, byte-stability (cache-prefix safety),
 * and the Champions-specific content, parallel to what `style.test.ts` does for
 * the assembled segments. The shared Markdown body is guarded by `prompts.test.ts`
 * (its orphan mirror) + `style.test.ts`; this file guards the forked Grok body so
 * a parity slip between the two prompts is caught.
 */

import { describe, expect, it } from "vitest";

import {
  GROK_CHAMPIONS_FEW_SHOT,
  GROK_CHAMPIONS_SYSTEM_PROMPT,
  GROK_STANDARD_FEW_SHOT,
  GROK_STANDARD_SYSTEM_PROMPT,
  grokDomainForMode,
} from "@/agent/prompts/domain-grok";
import { CHAMPIONS_REGULATION } from "@/data/formats";

const STANDARD_SECTIONS = [
  "role",
  "task",
  "constraints",
  "data_rules",
  "tools",
  "tool_routing",
  "reasoning",
  "type_effectiveness",
  "doubles",
  "conversation",
  "teams",
  "image_input",
  "clarify",
  "scope",
  "output_contract",
  "output_format",
  "stop_condition",
];

function noEdgeWhitespace(s: string): void {
  expect(s).toBe(s.trim());
}

describe("Grok standard system prompt — XML-sectioned native body", () => {
  it("opens on <role> with the Oak identity and is whitespace-clean + sizable", () => {
    expect(GROK_STANDARD_SYSTEM_PROMPT.startsWith("<role>")).toBe(true);
    expect(GROK_STANDARD_SYSTEM_PROMPT).toContain("You are Oak");
    noEdgeWhitespace(GROK_STANDARD_SYSTEM_PROMPT);
    expect(GROK_STANDARD_SYSTEM_PROMPT.length).toBeGreaterThan(2000);
  });

  it("carries every section as a balanced <tag>…</tag> pair", () => {
    for (const tag of STANDARD_SECTIONS) {
      expect(GROK_STANDARD_SYSTEM_PROMPT).toContain(`<${tag}>`);
      expect(GROK_STANDARD_SYSTEM_PROMPT).toContain(`</${tag}>`);
    }
  });

  it("front-loads the brittle structured-output rules", () => {
    expect(GROK_STANDARD_SYSTEM_PROMPT).toContain("truncated:false");
    expect(GROK_STANDARD_SYSTEM_PROMPT).toContain("national_dex_number");
    expect(GROK_STANDARD_SYSTEM_PROMPT).toContain("subjects[]");
  });

  it("does not carry the old wrapper-era tags", () => {
    expect(GROK_STANDARD_SYSTEM_PROMPT).not.toContain("<playbook>");
    expect(GROK_STANDARD_SYSTEM_PROMPT).not.toContain("<grok_directives>");
  });
});

describe("Grok standard few-shot — <examples> block", () => {
  it("is one <examples> block and is whitespace-clean", () => {
    expect(GROK_STANDARD_FEW_SHOT.startsWith("<examples>")).toBe(true);
    expect(GROK_STANDARD_FEW_SHOT.trimEnd().endsWith("</examples>")).toBe(true);
    noEdgeWhitespace(GROK_STANDARD_FEW_SHOT);
  });

  it("has the ten worked examples A–J, each ending in a submit_answer call", () => {
    const exampleOpens = GROK_STANDARD_FEW_SHOT.match(/<example name="/g) ?? [];
    expect(exampleOpens).toHaveLength(10);
    for (const id of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
      expect(GROK_STANDARD_FEW_SHOT).toContain(`<example name="${id} —`);
    }
    const submits = GROK_STANDARD_FEW_SHOT.match(/→ submit_answer\(\{/g) ?? [];
    expect(submits.length).toBeGreaterThanOrEqual(10);
  });
});

describe("Grok Champions body — XML-sectioned, Champions-correct", () => {
  it("adds the Champions scope + mechanics sections and the regulation string", () => {
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT.startsWith("<role>")).toBe(true);
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("<champions_scope>");
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("</champions_scope>");
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("<champions_mechanics>");
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("</champions_mechanics>");
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain(CHAMPIONS_REGULATION);
    noEdgeWhitespace(GROK_CHAMPIONS_SYSTEM_PROMPT);
  });

  it("uses Stat Points and forbids Terastallization", () => {
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("Stat Points");
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).toContain("NO Terastallization");
    // No EV-budget language leaks in from the standard body.
    expect(GROK_CHAMPIONS_SYSTEM_PROMPT).not.toContain("252 per stat");
  });

  it("few-shot is scoped to Champions with the champions generation_basis", () => {
    expect(GROK_CHAMPIONS_FEW_SHOT.startsWith("<examples>")).toBe(true);
    expect(GROK_CHAMPIONS_FEW_SHOT).toContain('generation: "champions"');
    expect(GROK_CHAMPIONS_FEW_SHOT).toContain(CHAMPIONS_REGULATION);
    const exampleOpens = GROK_CHAMPIONS_FEW_SHOT.match(/<example name="/g) ?? [];
    expect(exampleOpens).toHaveLength(8);
  });
});

describe("grokDomainForMode — mode selection", () => {
  it("returns the standard Grok pair for standard mode", () => {
    expect(grokDomainForMode("standard")).toEqual({
      systemPrompt: GROK_STANDARD_SYSTEM_PROMPT,
      fewShot: GROK_STANDARD_FEW_SHOT,
    });
  });

  it("returns the Champions Grok pair for champions mode", () => {
    expect(grokDomainForMode("champions")).toEqual({
      systemPrompt: GROK_CHAMPIONS_SYSTEM_PROMPT,
      fewShot: GROK_CHAMPIONS_FEW_SHOT,
    });
  });
});
