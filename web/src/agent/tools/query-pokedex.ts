/**
 * T2 — `query_pokedex` (tools.md T2, the workhorse).
 *
 * Maps the model-facing input (types/abilities/moves/stat_filters/sort_by/...)
 * to `PokedexFilters` and delegates to the pokedex repo, which performs the
 * dynamic filter/sort/threshold SQL and the multi-move Gen-9 intersection
 * (BR-7). The repo already returns the T2 output union:
 *   - success: { total_count, truncated, sort, results }
 *   - { error: "index_unavailable" }       (empty / un-ingested index)
 *   - { unresolved: [...] }                (a passed slug is not in the index)
 * — those shapes pass straight through; this tool never throws in-domain.
 */

import type { ToolDef } from "@/agent/types";
import {
  queryPokedexInputSchema,
  toJsonSchema,
  type QueryPokedexOutput,
} from "@/agent/schemas";
import { queryPokedex, type PokedexFilters } from "@/data/repos/pokedex-repo";
import { formatForMode } from "@/data/formats";
import type { OakDb } from "@/data/db";

const description =
  "Search the local Pokédex index for Pokémon matching structured filters, " +
  "with optional sorting and a result limit. Use this for any filter, " +
  "threshold, superlative ('fastest'), or compound query — never fetch Pokémon " +
  "one by one for these. Pass multiple moves to get the set of Pokémon that can " +
  "learn ALL of them in Gen 9 (intersection). Returns the total match count " +
  "plus the top-N rows with stats, types, abilities, and sprite.";

export const queryPokedexTool: ToolDef = {
  name: "query_pokedex",
  description,
  inputSchema: toJsonSchema(queryPokedexInputSchema),
  run(args, ctx): Promise<QueryPokedexOutput> {
    const parsed = queryPokedexInputSchema.safeParse(args);
    if (!parsed.success) {
      // No documented "bad input" error for T2; an empty filter set is a valid,
      // honest empty result rather than a fabricated error.
      return Promise.resolve({
        total_count: 0,
        truncated: false,
        sort: null,
        results: [],
      });
    }
    const i = parsed.data;
    const filters: PokedexFilters = {
      types: i.types,
      abilities: i.abilities,
      moveIds: i.moves,
      statFilters: i.stat_filters,
      sortBy: i.sort_by,
      order: i.order,
      limit: i.limit,
    };
    return queryPokedex(
      filters,
      formatForMode(ctx.mode),
      ctx.db as unknown as OakDb,
    );
  },
};
