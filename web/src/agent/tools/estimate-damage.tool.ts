/**
 * T10 — `estimate_damage` (tools.md T10).
 *
 * Wraps the pure formula (src/agent/formulas/estimate-damage). Validates inputs
 * via the Zod schema; invalid values (e.g. a zero defense_stat) resolve to the
 * documented `{ error: "invalid_input", detail }` shape rather than throwing.
 * The result is always tagged `is_estimate: true` (the 0.85–1.0 roll range).
 *
 * No Champions (`ctx.mode`) branch: the core Lv50 damage equation is identical in
 * Champions. Champions correctness comes entirely from Champions-correct INPUTS —
 * effective stats from the Champions `compute_stat` variant and move base power
 * from the Champions reference data — not from a different formula here.
 */

import type { ToolDef } from "@/agent/types";
import {
  estimateDamageInputSchema,
  toJsonSchema,
  type EstimateDamageOutput,
} from "@/agent/schemas";
import { estimateDamage } from "@/agent/formulas/estimate-damage";

const description =
  "Estimate damage for one attack using the standard damage formula, returning " +
  "the min–max range (from the 0.85–1.0 random roll) and a breakdown. Provide " +
  "attacker/defender effective stats, move power, STAB, type effectiveness " +
  "multiplier, and any extra modifiers. Use this for damage questions — do not " +
  "compute damage yourself. Always present the result as an estimate.";

export const estimateDamageTool: ToolDef = {
  name: "estimate_damage",
  description,
  inputSchema: toJsonSchema(estimateDamageInputSchema),
  run(args): Promise<EstimateDamageOutput> {
    const parsed = estimateDamageInputSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({
        error: "invalid_input",
        detail:
          parsed.error.issues[0]?.message ?? "invalid estimate_damage input",
      });
    }
    return Promise.resolve(estimateDamage(parsed.data));
  },
};
