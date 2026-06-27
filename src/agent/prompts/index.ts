/**
 * Prompt assembly — the single entry point the runtime calls to get a turn's
 * system prompt as provider-tuned {@link SystemSegment}s.
 *
 * Two orthogonal axes:
 *  - MODE (standard vs champions) selects the shared DOMAIN body (`./domain`).
 *  - PROVIDER (anthropic/openai/xai) selects the tuned STYLE that wraps it
 *    (`./style-claude`, `./style-openai`, `./style-grok`).
 *
 * This keeps the Pokémon domain knowledge authored ONCE while each model still
 * gets a prompt tuned to its own published guidance. No SDK/env imports — the
 * runtime imports this; nothing here pulls a secret or a client.
 */

import { domainForMode } from "@/agent/prompts/domain";
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
  const domain = domainForMode(mode);
  switch (provider) {
    case "openai":
      return buildOpenAISegments(domain);
    case "xai":
      return buildGrokSegments(domain);
    case "anthropic":
    default:
      return buildClaudeSegments(domain);
  }
}
