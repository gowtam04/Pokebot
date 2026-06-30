/**
 * MoveArtifact — a move's full detail (B-4): clickable type, damage category,
 * power/accuracy/PP/priority/target, and effect text.
 */

"use client";

import TypeBadge from "@/components/TypeBadge";
import type { TypeName } from "@/agent/schemas";
import type { MoveArtifactData } from "@/lib/entity-artifact";

import EntityLink from "./EntityLink";

export interface MoveArtifactProps {
  data: MoveArtifactData;
}

function fmt(value: number | null): string {
  return value == null ? "—" : String(value);
}

export default function MoveArtifact({
  data,
}: MoveArtifactProps): React.JSX.Element {
  const stats: { label: string; value: string }[] = [
    { label: "Category", value: data.damage_class },
    { label: "Power", value: fmt(data.power) },
    { label: "Accuracy", value: data.accuracy == null ? "—" : `${data.accuracy}%` },
    { label: "PP", value: fmt(data.pp) },
    { label: "Priority", value: String(data.priority) },
    { label: "Target", value: data.target },
  ];

  return (
    <div className="move-artifact" data-testid="move-artifact">
      <div className="move-artifact__type">
        <EntityLink kind="type" q={data.type} className="entity-link--type">
          <TypeBadge type={data.type as TypeName} />
        </EntityLink>
      </div>

      <dl className="kv-grid" data-testid="move-stats">
        {stats.map((s) => (
          <div key={s.label} className="kv-grid__pair">
            <dt className="kv-grid__key">{s.label}</dt>
            <dd className="kv-grid__value">{s.value}</dd>
          </div>
        ))}
      </dl>

      <section className="move-artifact__effect">
        <h3 className="artifact-section__title">Effect</h3>
        <p className="artifact-text" data-testid="move-effect">
          {data.effect_full || data.effect_short}
        </p>
      </section>
    </div>
  );
}
