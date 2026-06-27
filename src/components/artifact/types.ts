/**
 * Client-side artifact-viewer view types + the context API (B-4, Phase 4).
 *
 * The viewer shows ONE artifact at a time (BR-AV-4) backed by a back-stack
 * (AV-US-5/6): every open pushes, `back` pops, `close` clears. Two artifact
 * sources (TD-2): ENTITY artifacts are fetched from `/api/entity`; STRUCTURED
 * artifacts (comparison, damage-calc) are derived from the committed
 * `PokebotAnswer` payload (no fetch). The current data `format` is snapshotted
 * onto each view at open time (BR-AV-7).
 *
 * Type-only module — safe for client + isolation tests.
 */

import type { DamageCalc, EntityKind, Subject } from "@/agent/schemas";
import type {
  ArtifactFormat,
  EntityArtifactResponse,
} from "@/lib/entity-artifact";
import type { TeamMember } from "@/data/teams/team-schema";
import type { TeamDetail } from "@/lib/teams-client";

export type { ArtifactFormat, EntityKind };

/** What an entity view asked for (format snapshotted at open). */
export interface EntityRequest {
  kind: EntityKind;
  q: string;
  format: ArtifactFormat;
}

/** A fetched entity-detail view and its load phase. */
export interface EntityArtifactView {
  id: number;
  type: "entity";
  request: EntityRequest;
  /**
   * "loading" — fetch in flight; "done" — `response` is set (which may itself be
   * an ok / not_found / unavailable envelope); "error" — transport/contract fault.
   */
  phase: "loading" | "done" | "error";
  response: EntityArtifactResponse | null;
}

/** A payload-derived structured view (no fetch), with its format snapshot. */
export type StructuredArtifact =
  | { kind: "comparison"; format: ArtifactFormat; subjects: Subject[] }
  | { kind: "damage-calc"; format: ArtifactFormat; damageCalc: DamageCalc };

export interface StructuredArtifactView {
  id: number;
  type: "structured";
  artifact: StructuredArtifact;
}

/**
 * A team view (TEAM-AD-7). A SAVED team is fetched by id from `/api/teams/[id]`
 * (live, with computed warnings — like an entity view); a PROPOSED team is
 * rendered inline from the answer payload (no fetch — like a structured view).
 * Read-only: editing happens on the `/teams` page (the "Edit" link).
 */
export interface TeamArtifactView {
  id: number;
  type: "team";
  format: ArtifactFormat;
  /** Best-known title (the team name); refined to `detail.name` once loaded. */
  title: string;
  /** "saved" → owns a `/teams` row (Edit link); "proposed" → not yet saved. */
  source: "saved" | "proposed";
  phase: "loading" | "done" | "error";
  detail: TeamDetail | null;
}

export type ArtifactView =
  | EntityArtifactView
  | StructuredArtifactView
  | TeamArtifactView;

/** Open-a-team input — a saved team by id, or a proposed team rendered inline. */
export type TeamArtifactInput =
  | { teamId: string; name?: string }
  | { team: { name: string; format: string; members: TeamMember[] } };

/** Open-a-structured-artifact input — the provider stamps the format. */
export type StructuredArtifactInput =
  | { kind: "comparison"; subjects: Subject[] }
  | { kind: "damage-calc"; damageCalc: DamageCalc };

/** The viewer API exposed through context (no-op default when no provider). */
export interface ArtifactViewerApi {
  /** True when an artifact is open (the chat reflows to make room). */
  isOpen: boolean;
  /** The artifact currently shown (top of the back-stack), or null. */
  current: ArtifactView | null;
  /** Whether a `back` is possible (more than one entry on the stack). */
  canGoBack: boolean;
  /** Open an entity-detail artifact (fetches `/api/entity`; pushes). */
  openEntity: (req: { kind: EntityKind; q: string }) => void;
  /** Open a structured artifact from a committed answer payload (pushes). */
  openStructured: (input: StructuredArtifactInput) => void;
  /** Open a team — a saved one by id (fetched), or a proposed one inline (pushes). */
  openTeam: (input: TeamArtifactInput) => void;
  /** Pop the back-stack to the previous artifact. */
  back: () => void;
  /** Close the viewer and clear the stack. */
  close: () => void;
  /** Pre-fill the chat composer with a follow-up about the open artifact (TD-7). */
  askInChat: (text: string) => void;
}
