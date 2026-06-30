/**
 * ArtifactViewerProvider — the viewer's state machine (B-4, Phase 4, TD-5).
 *
 * Holds the back-stack of open artifacts; the top entry is what's shown. Entity
 * opens fetch `/api/entity` (with a per-session in-memory result cache so
 * re-opening the same entity is instant, NFR-1); structured opens carry the
 * payload inline. The current `format` prop is snapshotted onto each view at
 * open time (BR-AV-7) — a later Champions-toggle does NOT mutate open artifacts.
 *
 * The context default is all no-ops (TD-5): clickable leaves can call
 * `openEntity` directly and still render in isolation tests without a provider.
 */

"use client";

import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { EntityArtifactResponse } from "@/lib/entity-artifact";
import { fetchEntityArtifact } from "@/lib/api/entity-client";
import { getTeam, type TeamDetail } from "@/lib/api/teams-client";
import { resolveSprites } from "@/lib/api/sprites-client";
import type { TeamMember } from "@/data/teams/team-schema";

import type {
  ArtifactFormat,
  ArtifactView,
  ArtifactViewerApi,
  EntityKind,
  StructuredArtifact,
  StructuredArtifactInput,
  TeamArtifactInput,
} from "./types";

const NOOP_API: ArtifactViewerApi = {
  isOpen: false,
  current: null,
  canGoBack: false,
  openEntity: () => {},
  openStructured: () => {},
  openTeam: () => {},
  back: () => {},
  close: () => {},
  askInChat: () => {},
};

export const ArtifactViewerContext = createContext<ArtifactViewerApi>(NOOP_API);

function cacheKey(format: string, kind: string, q: string): string {
  return `${format}:${kind}:${q.toLowerCase()}`;
}

export interface ArtifactViewerProviderProps {
  /** Current data scope; snapshotted onto each artifact at open (BR-AV-7). */
  format: ArtifactFormat;
  /** Pre-fill the chat composer with a follow-up (TD-7); lifted to the page. */
  onAskInChat?: (text: string) => void;
  children: ReactNode;
}

export function ArtifactViewerProvider({
  format,
  onAskInChat,
  children,
}: ArtifactViewerProviderProps): React.JSX.Element {
  const [stack, setStack] = useState<ArtifactView[]>([]);
  const idRef = useRef(0);
  const cacheRef = useRef(new Map<string, EntityArtifactResponse>());
  // Latest format, read inside callbacks so opens snapshot the current scope
  // without re-creating the callbacks (which would thrash leaf memoization).
  const formatRef = useRef(format);
  formatRef.current = format;

  const openEntity = useCallback(({ kind, q }: { kind: EntityKind; q: string }) => {
    const fmt = formatRef.current;
    const id = ++idRef.current;
    const request = { kind, q, format: fmt };
    const cached = cacheRef.current.get(cacheKey(fmt, kind, q));

    setStack((prev) => [
      ...prev,
      cached
        ? { id, type: "entity", request, phase: "done", response: cached }
        : { id, type: "entity", request, phase: "loading", response: null },
    ]);
    if (cached) return;

    void fetchEntityArtifact(kind, q, fmt).then((res) => {
      if (res) cacheRef.current.set(cacheKey(fmt, kind, q), res);
      setStack((prev) =>
        prev.map((v) =>
          v.id === id && v.type === "entity"
            ? { ...v, phase: res ? "done" : "error", response: res }
            : v,
        ),
      );
    });
  }, []);

  const openStructured = useCallback((input: StructuredArtifactInput) => {
    const fmt = formatRef.current;
    const id = ++idRef.current;
    const artifact: StructuredArtifact =
      input.kind === "comparison"
        ? { kind: "comparison", format: fmt, subjects: input.subjects }
        : { kind: "damage-calc", format: fmt, damageCalc: input.damageCalc };
    setStack((prev) => [...prev, { id, type: "structured", artifact }]);
  }, []);

  const openTeam = useCallback((input: TeamArtifactInput) => {
    const fmt = formatRef.current;
    const id = ++idRef.current;

    // Resolve sprite/type/base-stat refs for the members and patch them onto the
    // matching view (progressive enhancement — the card renders without them).
    const resolveAndPatch = (members: TeamMember[], teamFormat: string) => {
      const slugs = members
        .map((m) => m.species)
        .filter((s): s is string => Boolean(s));
      if (slugs.length === 0) return;
      void resolveSprites(teamFormat, slugs).then((refs) => {
        setStack((prev) =>
          prev.map((v) =>
            v.id === id && v.type === "team" ? { ...v, spriteRefs: refs } : v,
          ),
        );
      });
    };

    // Proposed team → render inline (no fetch), like a structured artifact.
    if ("team" in input) {
      const detail: TeamDetail = {
        id: "", // not yet saved → no /teams row → no Edit link
        name: input.team.name,
        format: input.team.format,
        members: input.team.members,
        // Server-stamped legality warnings (e.g. a species not in this format's
        // roster) so the viewer flags an illegal proposal just like a saved team;
        // absent ⇒ clean.
        validation: input.validation ?? [],
      };
      setStack((prev) => [
        ...prev,
        {
          id,
          type: "team",
          format: fmt,
          title: detail.name || "Proposed team",
          source: "proposed",
          phase: "done",
          detail,
        },
      ]);
      resolveAndPatch(input.team.members, input.team.format);
      return;
    }

    // Saved team → fetch live (members + computed warnings), like an entity.
    setStack((prev) => [
      ...prev,
      {
        id,
        type: "team",
        format: fmt,
        title: input.name ?? "Team",
        source: "saved",
        phase: "loading",
        detail: null,
      },
    ]);
    void getTeam(input.teamId).then((detail) => {
      setStack((prev) =>
        prev.map((v) =>
          v.id === id && v.type === "team"
            ? {
                ...v,
                phase: detail ? "done" : "error",
                detail,
                title: detail?.name ?? v.title,
              }
            : v,
        ),
      );
      if (detail) resolveAndPatch(detail.members, detail.format);
    });
  }, []);

  const back = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
  }, []);

  const close = useCallback(() => {
    setStack([]);
  }, []);

  const askInChat = useCallback(
    (text: string) => {
      onAskInChat?.(text);
    },
    [onAskInChat],
  );

  const api = useMemo<ArtifactViewerApi>(() => {
    const current = stack.length > 0 ? stack[stack.length - 1]! : null;
    return {
      isOpen: stack.length > 0,
      current,
      canGoBack: stack.length > 1,
      openEntity,
      openStructured,
      openTeam,
      back,
      close,
      askInChat,
    };
  }, [stack, openEntity, openStructured, openTeam, back, close, askInChat]);

  return (
    <ArtifactViewerContext.Provider value={api}>
      {children}
    </ArtifactViewerContext.Provider>
  );
}
