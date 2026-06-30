/**
 * T14 — `get_encounters`.
 *
 * Where and how to OBTAIN a Pokémon (wild encounters + gifts / gift-eggs /
 * static / in-game trades), grouped by game, from the pre-built PokeAPI snapshot
 * (reference_cache resource_kind "encounters"). STANDARD MODE ONLY: Champions
 * ships no encounter data, so a Champions turn short-circuits to a structured
 * `not_available_in_champions` (mirrors compute-stat.tool.ts's mode branch).
 * Pass-through of the repo's miss / index shapes; never throws in-domain.
 */

import type { ToolDef } from "@/agent/types";
import {
  getEncountersInputSchema,
  toJsonSchema,
  type GetEncountersOutput,
} from "@/agent/schemas";
import { getEncounters } from "@/data/repos/encounter-repo";
import { formatForMode } from "@/data/formats";
import type { OakDb } from "@/data/db";

const description =
  "Find where and how to OBTAIN a Pokémon — wild encounters (grass/surf/" +
  "fishing) plus gifts, gift-eggs, static and in-game trades — grouped by game. " +
  "Use for 'where do I catch / how do I get X' questions. Coverage is Gen 1 " +
  "through Sword/Shield and Let's Go ONLY; there is NO data for Scarlet/Violet, " +
  "Legends: Arceus, or BDSP — say so plainly when asked about those games. " +
  "Resolve the species name first (resolve_entity) if it might be misspelled.";

export const getEncountersTool: ToolDef = {
  name: "get_encounters",
  description,
  inputSchema: toJsonSchema(getEncountersInputSchema),
  run(args, ctx): Promise<GetEncountersOutput> {
    const parsed = getEncountersInputSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ found: false, suggestions: [] });
    }
    if (ctx.mode === "champions") {
      return Promise.resolve({ error: "not_available_in_champions" });
    }
    return getEncounters(
      parsed.data.name,
      formatForMode(ctx.mode),
      ctx.db as unknown as OakDb,
    );
  },
};
