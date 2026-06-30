/**
 * EntityLink — wraps any content in a clickable control that drills into another
 * entity artifact (AV-US-5: nested entities inside an artifact are clickable).
 *
 * Uses `useArtifactViewer().openEntity`, whose no-op default (TD-5) keeps the
 * link harmless — and the renderers fully renderable — in isolation tests with
 * no provider mounted.
 */

"use client";

import type { ReactNode } from "react";

import { useArtifactViewer } from "./useArtifactViewer";
import type { EntityKind } from "./types";

export interface EntityLinkProps {
  kind: EntityKind;
  /** Display name or canonical slug handed to `/api/entity`. */
  q: string;
  className?: string;
  testid?: string;
  children: ReactNode;
}

export default function EntityLink({
  kind,
  q,
  className,
  testid,
  children,
}: EntityLinkProps): React.JSX.Element {
  const { openEntity } = useArtifactViewer();
  return (
    <button
      type="button"
      className={className ? `entity-link ${className}` : "entity-link"}
      data-testid={testid}
      data-entity-kind={kind}
      onClick={(e) => {
        // Opening an entity is terminal — never also trigger a parent handler
        // (e.g. a CandidateTable row's follow-up onClick).
        e.stopPropagation();
        openEntity({ kind, q });
      }}
    >
      {children}
    </button>
  );
}
