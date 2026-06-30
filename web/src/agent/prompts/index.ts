/**
 * Prompt assembly — the single entry point the runtime calls to get a turn's
 * system prompt as provider-tuned {@link SystemSegment}s.
 *
 * Two orthogonal axes:
 *  - MODE (standard vs champions) selects the DOMAIN body.
 *  - PROVIDER (anthropic/openai/xai) selects the body's authoring + the tuned
 *    STYLE that wraps it. anthropic/openai share the Markdown body (`./domain`)
 *    via their style wrappers (`./style-claude`, `./style-openai`); xai (Oak's
 *    default model) runs on a Grok-NATIVE, XML-sectioned body (`./domain-grok`)
 *    behind a thin `./style-grok` builder. The two bodies carry the same domain
 *    facts in two prompt structures and are kept in parity (see CLAUDE.md).
 *
 * No SDK/env imports — the runtime imports this; nothing here pulls a secret or a
 * client.
 */

import { domainForMode } from "@/agent/prompts/domain";
import { grokDomainForMode } from "@/agent/prompts/domain-grok";
import { buildClaudeSegments } from "@/agent/prompts/style-claude";
import { buildGrokSegments } from "@/agent/prompts/style-grok";
import { buildOpenAISegments } from "@/agent/prompts/style-openai";
import type { ProviderKind } from "@/agent/models";
import type { SystemSegment } from "@/agent/providers/types";
import type { AgentMode } from "@/agent/types";

export interface BuildSystemSegmentsOptions {
  provider: ProviderKind;
  mode: AgentMode;
}

/** Build the provider-tuned system segments for a turn (mode × provider). */
export function buildSystemSegments({
  provider,
  mode,
}: BuildSystemSegmentsOptions): SystemSegment[] {
  switch (provider) {
    case "openai":
      return buildOpenAISegments(domainForMode(mode));
    case "xai":
      // Grok runs on its own XML-sectioned body, not the shared Markdown one.
      return buildGrokSegments(grokDomainForMode(mode));
    case "anthropic":
    default:
      return buildClaudeSegments(domainForMode(mode));
  }
}
