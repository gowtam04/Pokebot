/**
 * Claude prompt style — the canonical, unchanged Oak prompt.
 *
 * Produces the SAME two system segments the runtime used inline before the
 * model switcher (the domain system body, then the few-shot with the single
 * ephemeral cache breakpoint on the last segment). Keeping this byte-identical
 * is what guarantees the default Claude path does not regress and its prompt
 * cache stays warm. Claude reads the XML-light, "you are"-framed, adaptive-
 * thinking prompt well, so no extra scaffolding is layered on.
 */

import type { PromptDomain } from "@/agent/prompts/domain";
import type { SystemSegment } from "@/agent/providers/types";

export function buildClaudeSegments(domain: PromptDomain): SystemSegment[] {
  return [
    { text: domain.systemPrompt },
    { text: domain.fewShot, cacheBreakpoint: true },
  ];
}
