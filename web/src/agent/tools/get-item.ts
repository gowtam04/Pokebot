/**
 * T8 — `get_item` (tools.md T8).
 *
 * Item effect text (and, where available, wild-held data), via the read-through
 * reference cache (DS-4). Pass-through of miss / upstream shapes; never throws.
 */

import type { ToolDef } from "@/agent/types";
import {
  getItemInputSchema,
  toJsonSchema,
  type GetItemOutput,
} from "@/agent/schemas";
import { getReference } from "@/data/repos/reference-cache";
import { formatForMode } from "@/data/formats";

const description =
  "Get an item's effect text and, where available, which Pokémon are found " +
  "holding it in the wild. Use for item questions.";

export const getItemTool: ToolDef = {
  name: "get_item",
  description,
  inputSchema: toJsonSchema(getItemInputSchema),
  async run(args, ctx): Promise<GetItemOutput> {
    const parsed = getItemInputSchema.safeParse(args);
    if (!parsed.success) {
      return { found: false, suggestions: [] };
    }
    return (await getReference(
      "item",
      parsed.data.name,
      formatForMode(ctx.mode),
      ctx.db,
    )) as GetItemOutput;
  },
};
