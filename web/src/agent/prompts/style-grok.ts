/**
 * Grok 4.3 prompt style.
 *
 * Grok is Oak's default/primary model, so it runs on a Grok-NATIVE prompt body
 * (`./domain-grok`) authored directly in xAI's idiom — a fully XML-sectioned
 * system prompt (constraints + `<output_contract>` front-loaded, an explicit
 * `<tool_routing>` map, a single `<stop_condition>`) and `<examples>` worked
 * cases. It is NOT the Claude/OpenAI Markdown body (`./domain`) wrapped in a
 * `<playbook>`; the two are independent prompts kept in parity (see CLAUDE.md +
 * the Grok block of `style.test.ts`).
 *
 * Because the body already carries all the XML scaffolding, this builder is a
 * thin two-segment split (system + examples) with one ephemeral cache breakpoint
 * on the last segment — the same shape as the Claude style. xAI caches a stable
 * prefix automatically, and we never force tool_choice (Grok reasons natively and
 * submit_answer is driven by the `<stop_condition>` + the iteration cap).
 *
 * Note: xAI streams a tool call as a single chunk, so answer_markdown arrives at
 * once rather than token-by-token — handled transparently by the runtime; no
 * prompt accommodation needed.
 */

import type { PromptDomain } from "@/agent/prompts/domain";
import type { SystemSegment } from "@/agent/providers/types";

export function buildGrokSegments(domain: PromptDomain): SystemSegment[] {
  return [
    { text: domain.systemPrompt },
    { text: domain.fewShot, cacheBreakpoint: true },
  ];
}
