/**
 * DamageCalcArtifact — the battle-math breakdown opened from an answer's
 * damage-calc block (B-4, payload-derived; TD-2 — no fetch). Reuses the answer's
 * DamageReadout (assumptions, result, worked breakdown, estimate tag).
 */

"use client";

import DamageReadout from "@/components/answer-card/DamageReadout";
import type { DamageCalc } from "@/agent/schemas";

export interface DamageCalcArtifactProps {
  damageCalc: DamageCalc;
}

export default function DamageCalcArtifact({
  damageCalc,
}: DamageCalcArtifactProps): React.JSX.Element {
  return (
    <div className="damage-calc-artifact" data-testid="damage-calc-artifact">
      <DamageReadout damageCalc={damageCalc} />
    </div>
  );
}
