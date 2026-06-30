/**
 * Tests for the provider-tuned prompt styles + the buildSystemSegments
 * dispatcher. Verifies each style emits exactly one cache breakpoint (on the
 * last segment), the Claude path stays byte-identical to the shared domain body
 * (zero-regression baseline), and each tuned style carries its provider-specific
 * scaffolding (GPT-5.5 Markdown + stop-condition directives; Grok XML-tagged
 * sections).
 */

import { describe, expect, it } from "vitest";

import { buildSystemSegments } from "@/agent/prompts";
import {
  STANDARD_FEW_SHOT,
  STANDARD_SYSTEM_PROMPT,
} from "@/agent/prompts/domain";
import type { SystemSegment } from "@/agent/providers/types";

function oneBreakpointOnLast(segments: SystemSegment[]): void {
  const flagged = segments.filter((s) => s.cacheBreakpoint);
  expect(flagged).toHaveLength(1);
  expect(segments[segments.length - 1].cacheBreakpoint).toBe(true);
  // No earlier segment is flagged.
  for (const s of segments.slice(0, -1)) expect(s.cacheBreakpoint).toBeFalsy();
}

describe("buildSystemSegments — cache breakpoint invariant", () => {
  for (const provider of ["anthropic", "openai", "xai"] as const) {
    it(`places exactly one breakpoint on the last segment (${provider})`, () => {
      oneBreakpointOnLast(buildSystemSegments({ provider, mode: "standard" }));
      oneBreakpointOnLast(buildSystemSegments({ provider, mode: "champions" }));
    });
  }
});

describe("Claude style — byte-identical to the domain body (no regression)", () => {
  it("is exactly [systemPrompt, fewShot] for standard mode", () => {
    const segs = buildSystemSegments({ provider: "anthropic", mode: "standard" });
    expect(segs).toEqual([
      { text: STANDARD_SYSTEM_PROMPT },
      { text: STANDARD_FEW_SHOT, cacheBreakpoint: true },
    ]);
  });
});

describe("GPT-5.5 style — tuned scaffolding", () => {
  const text = buildSystemSegments({ provider: "openai", mode: "standard" })
    .map((s) => s.text)
    .join("\n");

  it("includes the explicit agent contract + single stop condition", () => {
    expect(text).toContain("<agent_contract>");
    expect(text).toContain("submit_answer exactly once");
  });

  it("includes the explicit Markdown directive (API suppresses Markdown by default)", () => {
    expect(text).toContain("<output_contract>");
    expect(text).toContain("GitHub-Flavored Markdown");
  });

  it("still carries the shared domain body", () => {
    expect(text).toContain("You are Oak");
    expect(text).toContain("# How to use your tools");
  });
});

describe("Interpreting attached images — present in both modes and all styles", () => {
  for (const provider of ["anthropic", "openai", "xai"] as const) {
    for (const mode of ["standard", "champions"] as const) {
      it(`carries the image-interpreting section + few-shot (${provider}, ${mode})`, () => {
        const text = buildSystemSegments({ provider, mode })
          .map((s) => s.text)
          .join("\n");
        // The image-interpreting section: a Markdown heading on the shared body,
        // an XML section on the Grok-native body.
        expect(text).toContain(
          provider === "xai"
            ? "<image_input>"
            : "# Interpreting attached images",
        );
        // The general-not-just-teams guarantee + the uncertainty discipline cue.
        expect(text).toContain("general, not just teams");
        expect(text).toContain("uncertainty_flags");
        // The image few-shot example rides in the examples/few-shot segment.
        expect(text).toContain("attached screenshot");
      });
    }
  }
});

describe("Grok 4.3 style — XML-sectioned native body", () => {
  const text = buildSystemSegments({ provider: "xai", mode: "standard" })
    .map((s) => s.text)
    .join("\n");

  it("authors the whole body as labeled XML sections (no wrapper)", () => {
    expect(text).toContain("<role>");
    expect(text).toContain("<data_rules>");
    expect(text).toContain("<tool_routing>");
    expect(text).toContain("<reasoning>");
    expect(text).toContain("<examples>");
    // The wrapper-era tags are gone — the body IS Grok-native now, not the
    // shared Markdown body wrapped in a <playbook>.
    expect(text).not.toContain("<playbook>");
    expect(text).not.toContain("<grok_directives>");
  });

  it("includes the explicit stop condition and the Oak identity", () => {
    expect(text).toContain("<stop_condition>");
    expect(text).toContain("You are Oak");
  });

  it("front-loads the brittle output rules as a top-level <output_contract>", () => {
    expect(text).toContain("<output_contract>");
    // The three brittle structured-output rules a structured agent tends to drop.
    expect(text).toContain("truncated:false"); // complete-lists rule
    expect(text).toContain("national_dex_number"); // candidates-copied-verbatim rule
    expect(text).toContain("subjects[]"); // sprite rule
  });
});
