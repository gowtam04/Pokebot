/**
 * T15 — `get_usage_stats`.
 *
 * Live Pokémon Champions competitive usage (most-used moves / items / abilities /
 * natures / stat-spreads / teammates, each with a usage %) from
 * championsbattledata.com AT REQUEST TIME — the only network-at-request-time tool.
 * CHAMPIONS MODE ONLY: a standard-mode turn short-circuits to
 * `not_available_in_standard` (the mirror of get_encounters' champions gate). The
 * data is live, community-maintained, and time-varying, so the prompt tells the
 * model to cite the source + season + freshness and flag uncertainty. Never throws
 * in-domain: a name miss returns `{ found:false, suggestions }`; any network/parse
 * fault maps to `{ error:"upstream_unavailable" }`.
 */

import type { ToolDef } from "@/agent/types";
import {
  getUsageStatsInputSchema,
  toJsonSchema,
  type GetUsageStatsOutput,
  type UsageEntry,
} from "@/agent/schemas";
import {
  getUsage,
  USAGE_ATTRIBUTION,
  type UsageData,
} from "@/server/champions-usage/usage-client";

/** Top-N entries surfaced per category (keeps the tool payload tight). */
const TOP_N = 8;

const description =
  "Get LIVE competitive usage for a Pokémon in Pokémon Champions — the most-used " +
  "moves, items, abilities, natures, stat spreads, and teammates, each with a " +
  "usage %. Use for 'what's X running right now', 'most common item/move/" +
  "teammate', 'is X meta', and other CURRENT-usage questions. Champions mode " +
  "only. Pass format ('doubles' default — the official VGC ladder — or " +
  "'singles'). Data is live and community-sourced (championsbattledata.com), may " +
  "not cover every Pokémon, and MUST be cited with its season + freshness. " +
  "Resolve the species name first (resolve_entity) if it might be misspelled.";

function topN(entries: UsageEntry[]): UsageEntry[] {
  return entries.slice(0, TOP_N);
}

function toOutput(name: string, data: UsageData): GetUsageStatsOutput {
  return {
    found: true,
    name,
    saved_name: data.saved_name,
    format: data.format,
    season: data.season,
    fetched_at: data.fetched_at,
    moves: topN(data.moves),
    items: topN(data.items),
    abilities: topN(data.abilities),
    natures: topN(data.natures),
    spreads: topN(data.spreads),
    teammates: topN(data.teammates),
    source_url: data.source_url,
    attribution: USAGE_ATTRIBUTION,
  };
}

export const getUsageStatsTool: ToolDef = {
  name: "get_usage_stats",
  description,
  inputSchema: toJsonSchema(getUsageStatsInputSchema),
  async run(args, ctx): Promise<GetUsageStatsOutput> {
    const parsed = getUsageStatsInputSchema.safeParse(args);
    if (!parsed.success) {
      return { found: false, suggestions: [] };
    }
    // Champions-only — the exact mirror of get_encounters' standard-only gate.
    if (ctx.mode !== "champions") {
      return { error: "not_available_in_standard" };
    }
    try {
      const result = await getUsage(parsed.data.name, parsed.data.format, {
        signal: ctx.signal,
      });
      if (!result.found) {
        return { found: false, suggestions: result.suggestions };
      }
      return toOutput(parsed.data.name, result.data);
    } catch {
      // Any transport/parse fault — never throw in-domain.
      return { error: "upstream_unavailable" };
    }
  },
};
