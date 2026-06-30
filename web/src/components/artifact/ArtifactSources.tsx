/**
 * ArtifactSources — the grounding footer for an entity artifact (BR-AV-6,
 * AV-US-10). Reuses the answer card's `SourceList` so artifacts carry the same
 * cited treatment as answers.
 */

import SourceList from "@/components/answer-card/SourceList";
import type { Citation } from "@/agent/schemas";

export interface ArtifactSourcesProps {
  citations: Citation[];
}

export default function ArtifactSources({
  citations,
}: ArtifactSourcesProps): React.JSX.Element {
  return (
    <div className="artifact-sources" data-testid="artifact-sources">
      <SourceList citations={citations} />
    </div>
  );
}
