/**
 * useArtifactViewer — read the artifact-viewer API from context (B-4, Phase 4).
 *
 * Returns the no-op default when no provider is mounted (TD-5), so clickable
 * leaves (SpriteCard, TypeBadge, SourceList citations, …) can call `openEntity`
 * unconditionally and still render in isolation tests.
 */

"use client";

import { useContext } from "react";

import { ArtifactViewerContext } from "./ArtifactViewerProvider";
import type { ArtifactViewerApi } from "./types";

export function useArtifactViewer(): ArtifactViewerApi {
  return useContext(ArtifactViewerContext);
}
