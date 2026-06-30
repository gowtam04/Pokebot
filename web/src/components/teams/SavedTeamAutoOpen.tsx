/**
 * SavedTeamAutoOpen — headless bridge that opens a JUST-saved team in the
 * artifact viewer exactly once on arrival (TEAM-AD-7).
 *
 * Must render INSIDE the ArtifactViewerProvider (so `useArtifactViewer` resolves
 * the real API). The page sets `savedTeam` only from a freshly-committed answer's
 * `saved_team`, so re-opening a conversation from history never triggers an
 * auto-open; the per-id ref guard keeps a re-render from re-opening it.
 */

"use client";

import { useEffect, useRef } from "react";

import type { SavedTeam } from "@/components/types";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";

export default function SavedTeamAutoOpen({
  savedTeam,
}: {
  savedTeam: SavedTeam | null;
}): null {
  const { openTeam } = useArtifactViewer();
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!savedTeam) return;
    if (openedRef.current === savedTeam.id) return;
    openedRef.current = savedTeam.id;
    openTeam({ teamId: savedTeam.id, name: savedTeam.name });
  }, [savedTeam, openTeam]);

  return null;
}
