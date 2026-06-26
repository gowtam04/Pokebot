/**
 * T4 — `get_move` (tools.md T4).
 *
 * Reads the move's mechanical details from the read-through reference cache
 * (DS-4). Optionally augments a successful hit with the Gen-9 learner count from
 * the learnset repo (DS-3). Misses / upstream failures pass straight through:
 *   - { found: false, suggestions: [...] }
 *   - { error: "upstream_unavailable" }
 */

import type { ToolDef } from "@/agent/types";
import {
  getMoveInputSchema,
  toJsonSchema,
  type GetMoveOutput,
  type MoveDetail,
} from "@/agent/schemas";
import { getReference } from "@/data/repos/reference-cache";
import { gen9LearnerCount } from "@/data/repos/learnset-repo";
import { formatForMode } from "@/data/formats";
import type { PokebotDb } from "@/data/db";

const description =
  "Get a move's mechanical details — type, power, accuracy, PP, priority, " +
  "damage class (physical/special/status), target, and effect text. Use " +
  "whenever reasoning depends on how a move behaves (e.g. checking that Fake " +
  "Out is a priority move). Optionally returns the count of Pokémon that learn " +
  "it in Gen 9.";

/** True when a reference result is a successful detail record (found: true). */
function isFound(ref: unknown): ref is { found: true } {
  return (
    typeof ref === "object" &&
    ref !== null &&
    (ref as { found?: unknown }).found === true
  );
}

export const getMoveTool: ToolDef = {
  name: "get_move",
  description,
  inputSchema: toJsonSchema(getMoveInputSchema),
  async run(args, ctx): Promise<GetMoveOutput> {
    const parsed = getMoveInputSchema.safeParse(args);
    if (!parsed.success) {
      return { found: false, suggestions: [] };
    }
    const { name, include_gen9_learner_count } = parsed.data;
    const format = formatForMode(ctx.mode);

    const ref = (await getReference("move", name, format, ctx.db)) as GetMoveOutput;
    if (!isFound(ref)) {
      return ref;
    }

    if (include_gen9_learner_count) {
      return {
        ...(ref as MoveDetail),
        gen9_learner_count: await gen9LearnerCount(
          name,
          format,
          ctx.db as unknown as PokebotDb,
        ),
      };
    }
    return ref;
  },
};
