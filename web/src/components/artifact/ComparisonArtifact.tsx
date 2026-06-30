/**
 * ComparisonArtifact — a side-by-side of the answer's subjects (B-4, payload-
 * derived; TD-2 — no fetch). Each subject reuses the answer's SpriteCard and is
 * clickable to drill into that Pokémon's full profile (AV-US-5).
 */

"use client";

import SpriteCard from "@/components/answer-card/SpriteCard";
import type { Subject } from "@/agent/schemas";

export interface ComparisonArtifactProps {
  subjects: Subject[];
}

export default function ComparisonArtifact({
  subjects,
}: ComparisonArtifactProps): React.JSX.Element {
  // SpriteCard is itself clickable (name → Pokémon, badges → type), so render it
  // bare — no outer link (which would nest interactive controls, AV-US-5).
  return (
    <div className="comparison-artifact" data-testid="comparison-artifact">
      <div className="comparison-artifact__cards">
        {subjects.map((subject, i) => (
          <div
            key={`${subject.name}-${i}`}
            className="comparison-artifact__card"
            data-testid={`comparison-subject-${i}`}
          >
            <SpriteCard subject={subject} />
          </div>
        ))}
      </div>
    </div>
  );
}
