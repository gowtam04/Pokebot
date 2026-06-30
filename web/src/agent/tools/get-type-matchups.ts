/**
 * T6 — `get_type_matchups` (tools.md T6).
 *
 * One type  -> return its full offensive + defensive profile straight from the
 *              read-through reference cache (DS-4).
 * Two types -> fetch each type's single-type profile and compute the COMBINED
 *              DEFENSIVE profile (the product of both types' multipliers).
 *
 * Immunities are 0× and MUST be reported under `immune_to`, never as a resist
 * (BR-5). A combined multiplier of exactly 0 -> immune_to; >1 -> weak_to;
 * 0 < m < 1 -> resists; 1 -> neutral (omitted). The combined result carries no
 * `offensive` block (a two-type request is defensive only).
 *
 * Misses / upstream failures pass straight through:
 *   - { found: false, suggestions: [...] }   (unknown type)
 *   - { error: "upstream_unavailable" }
 */

import type { ToolDef } from "@/agent/types";
import {
  getTypeMatchupsInputSchema,
  toJsonSchema,
  type GetTypeMatchupsOutput,
  type TypeMatchupsDetail,
} from "@/agent/schemas";
import { combineDefensive } from "@/agent/formulas/type-chart";
import { getReference } from "@/data/repos/reference-cache";
import { formatForMode } from "@/data/formats";

const description =
  "Get type effectiveness relationships using the latest type chart. Pass one " +
  "type for its offensive and defensive profile, or two types for a combined " +
  "defensive profile (the product of both types' weaknesses/resistances/" +
  "immunities). Use for matchup questions. Immunities are 0× and must be " +
  "treated as immunities, not resistances.";

function isFoundProfile(ref: unknown): ref is TypeMatchupsDetail {
  return (
    typeof ref === "object" &&
    ref !== null &&
    (ref as { found?: unknown }).found === true
  );
}

export const getTypeMatchupsTool: ToolDef = {
  name: "get_type_matchups",
  description,
  inputSchema: toJsonSchema(getTypeMatchupsInputSchema),
  async run(args, ctx): Promise<GetTypeMatchupsOutput> {
    const parsed = getTypeMatchupsInputSchema.safeParse(args);
    if (!parsed.success) {
      return { found: false, suggestions: [] };
    }
    const { types } = parsed.data;
    const format = formatForMode(ctx.mode);

    // Single type: the cached profile already has offensive + defensive.
    if (types.length === 1) {
      return (await getReference(
        "type",
        types[0]!,
        format,
        ctx.db,
      )) as GetTypeMatchupsOutput;
    }

    // Two types: combine defensive multipliers.
    const ref1 = (await getReference(
      "type",
      types[0]!,
      format,
      ctx.db,
    )) as GetTypeMatchupsOutput;
    if (!isFoundProfile(ref1)) return ref1;

    const ref2 = (await getReference(
      "type",
      types[1]!,
      format,
      ctx.db,
    )) as GetTypeMatchupsOutput;
    if (!isFoundProfile(ref2)) return ref2;

    return {
      found: true,
      types: [types[0]!, types[1]!],
      defensive: combineDefensive([ref1.defensive, ref2.defensive]),
    };
  },
};
