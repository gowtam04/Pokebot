/**
 * T7 — `get_evolution_chain` (tools.md T7).
 *
 * Full evolution line + per-stage conditions, via the read-through reference
 * cache (DS-4, resource kind "evolution"). Pass-through of miss / upstream
 * shapes; never throws.
 */

import type { ToolDef } from "@/agent/types";
import {
  getEvolutionChainInputSchema,
  toJsonSchema,
  type GetEvolutionChainOutput,
} from "@/agent/schemas";
import { getReference } from "@/data/repos/reference-cache";
import { formatForMode } from "@/data/formats";

const description =
  "Get a Pokémon's full evolution line and the condition(s) for each stage " +
  "(level, item, friendship, trade, time of day, etc.) as provided by PokeAPI. " +
  "Use for evolution questions.";

export const getEvolutionChainTool: ToolDef = {
  name: "get_evolution_chain",
  description,
  inputSchema: toJsonSchema(getEvolutionChainInputSchema),
  async run(args, ctx): Promise<GetEvolutionChainOutput> {
    const parsed = getEvolutionChainInputSchema.safeParse(args);
    if (!parsed.success) {
      return { found: false, suggestions: [] };
    }
    return (await getReference(
      "evolution",
      parsed.data.species,
      formatForMode(ctx.mode),
      ctx.db,
    )) as GetEvolutionChainOutput;
  },
};
