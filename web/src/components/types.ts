/**
 * Frontend prop contract — the INTERFACE seam for Phase 7 (Frontend renderer).
 *
 * This module is the single, shared contract that the `AnswerCard` tree, the
 * chat shell, and the `sse-client` hook all target. It is authored by the
 * Frontend INTERFACE step so the parallel leaf-component authors and the hook
 * author can build against fixed prop shapes without coordinating directly.
 *
 * Field → component mapping is fixed by `output-formats.md` / `ux-design.md`:
 *   answer_markdown                          → AnswerBody
 *   reasoning_markdown                       → ReasoningBlock (collapsible)
 *   subjects[]                               → SpriteCard (+ TypeBadge per type)
 *   candidates                               → CandidateTable ("N of M" when truncated)
 *   citations[]                              → SourceList (collapsible "Sources")
 *   inferences[]                             → InferenceCallout
 *   generation_basis.fallback + uncertainty_flags[] → CaveatStrip
 *   damage_calc                              → DamageReadout (assumptions + estimate tag)
 *   suggestions[] (+ status)                 → SuggestionChips (click → follow-up POST)
 *
 * Rules (per the shared-tree + risk directives):
 *  - The `OakAnswer` type and all its sub-types are owned by
 *    `@/agent/schemas` — they are imported/re-exported here, never redefined.
 *  - The SSE wire types (`ToolActivityEvent`, `ErrorEvent`, `ChatRequestBody`)
 *    are owned by `@/lib/sse/sse-types` — imported/re-exported here, never redefined.
 *  - Leaf components import their props from THIS module (type-only). They must
 *    NOT import `db` / `repos` / `runtime` (no server/native code under jsdom).
 *    Every type below is structural and erasable, so importing it pulls in no
 *    runtime/server code.
 */

import type {
  OakAnswer,
  Subject,
  Candidates,
  Citation,
  Inference,
  GenerationBasis,
  DamageCalc,
  Question,
  QuestionOption,
  TypeName,
} from "@/agent/schemas";
import type {
  ToolActivityEvent,
  ErrorEvent,
  ChatRequestBody,
} from "@/lib/sse/sse-types";

// Re-export the payload sub-types so leaf authors can import everything they
// need from `@/components/types` alone (one frontend contract surface).
export type {
  OakAnswer,
  Subject,
  Candidates,
  Citation,
  Inference,
  GenerationBasis,
  DamageCalc,
  Question,
  QuestionOption,
  TypeName,
  ToolActivityEvent,
  ErrorEvent,
  ChatRequestBody,
};

/** The `status` discriminant of a OakAnswer (drives clarification UI). */
export type AnswerStatus = OakAnswer["status"];

/** One row of a candidate result set (`candidates.shown[]`). */
export type CandidateRow = Candidates["shown"][number];

/**
 * Send a normal follow-up turn for the SAME session — used by clickable
 * affordances (suggestion chips, candidate rows). The string becomes a new user
 * message; there is no special protocol (ux-design.md UI → Agent Input Map).
 */
export type OnFollowUp = (message: string) => void;

// ---------------------------------------------------------------------------
// Top-level renderer — AnswerCard
// ---------------------------------------------------------------------------

/**
 * Props for the top-level `AnswerCard` (the barrel/assembly component).
 *
 * AnswerCard receives the whole `OakAnswer` and fans its fields out to the
 * leaf components below. `onFollowUp` is threaded down to the interactive leaves
 * (SuggestionChips, CandidateTable) so a click POSTs a follow-up turn.
 */
export interface AnswerCardProps {
  /** The structured answer emitted by `submit_answer` for this assistant turn. */
  answer: OakAnswer;
  /** Send a follow-up turn when the user clicks a suggestion / candidate. */
  onFollowUp?: OnFollowUp;
  /**
   * True while a turn is streaming — disables the follow-up affordances
   * (suggestion chips, question options, "Show all N") so a mid-stream click
   * can't abort/orphan the in-flight turn. The viewer-opening controls (candidate
   * rows, "Open/Compare in viewer") stay enabled: they don't POST a turn. Default
   * false (chips live). Absent at the admin call sites (read-only, no follow-up).
   */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Leaf component props (one per field; authors build these in parallel)
// ---------------------------------------------------------------------------

/** `answer_markdown` — the direct, bottom-line-first answer. Always present. */
export interface AnswerBodyProps {
  markdown: string;
}

/**
 * Shared markdown renderer (react-markdown + remark-gfm). Wraps output in a
 * `.markdown-body` div (the single CSS hook); `className` is merged after it.
 */
export interface MarkdownProps {
  markdown: string;
  /** Extra class merged after `markdown-body` (e.g. `answer-body__content`). */
  className?: string;
}

/** `reasoning_markdown` — the "why". Collapsible; collapsed by default. */
export interface ReasoningBlockProps {
  markdown: string;
  /** Expanded on first render (default: false → collapsed). */
  defaultExpanded?: boolean;
}

/** One entry of `subjects[]` — sprite/artwork + name + its type badges. */
export interface SpriteCardProps {
  subject: Subject;
}

/** A single type rendered as a color-coded badge. Palette owned by frontend-design. */
export interface TypeBadgeProps {
  type: TypeName;
}

/**
 * `candidates` — the filter/superlative result set. Renders rows (sprite, name,
 * type badges, key stats, ability) and an honest "N of M" header when truncated.
 * Every row is clickable and opens that Pokémon's artifact in the viewer.
 */
export interface CandidateTableProps {
  candidates: Candidates;
  /**
   * Optional "Show all N" affordance, shown only when the result set is
   * truncated. Clicking it sends a follow-up turn asking for the full list, so a
   * truncated table is never a dead-end.
   */
  onShowAll?: () => void;
  /**
   * Disabled while a turn is streaming — gates ONLY the "Show all N" follow-up
   * button (the sole `onShowAll` path). Rows stay clickable: they open the
   * artifact viewer, not a follow-up turn. Default false.
   */
  disabled?: boolean;
}

/** `citations[]` — the PokeAPI data relied on. Collapsible "Sources" list. */
export interface SourceListProps {
  citations: Citation[];
  /** Expanded on first render (default: false → collapsed). */
  defaultExpanded?: boolean;
}

/** `inferences[]` — visually distinct "deduction, not stated data" callouts. */
export interface InferenceCalloutProps {
  inferences: Inference[];
}

/**
 * Caveat strip — combines `uncertainty_flags[]` and a generation fallback
 * (`generation_basis.fallback` + its note) into one prominent banner. Renders
 * nothing when there are no flags and `generationBasis.fallback === false`.
 */
export interface CaveatStripProps {
  uncertaintyFlags: string[];
  generationBasis: GenerationBasis;
}

/** `damage_calc` — computed value, assumptions, worked breakdown, estimate tag. */
export interface DamageReadoutProps {
  damageCalc: DamageCalc;
}

/**
 * `proposed_team` — the team the agent built for a "build me a team" turn
 * (TEAM-AD-6). ADDITIVE optional field on `OakAnswer`; a `ChatTurn`'s
 * assistant `answer` carries it through unchanged (it lives inside
 * `OakAnswer`). The agent NEVER writes a team (BR-T8) — the user Applies it
 * via a normal authenticated Teams API write (save-new / apply-existing).
 */
export type ProposedTeam = NonNullable<OakAnswer["proposed_team"]>;

/**
 * `proposed_team` card — renders the agent's proposed team and the two Apply
 * affordances (save as a NEW team via `createTeam`, or apply its members onto an
 * EXISTING same-format team via `updateTeam`). All writes go through the
 * never-throwing teams-client; guests / failures fold into an inline message.
 */
export interface ProposedTeamCardProps {
  proposedTeam: ProposedTeam;
  /**
   * Server-stamped roster/legality warnings for the proposal (BR-T5), from the
   * answer's `proposed_team_warnings`. Absent/empty ⇒ a clean proposal. Drives
   * the inline "illegal in this format" badges + the viewer warnings.
   */
  warnings?: NonNullable<OakAnswer["proposed_team_warnings"]>;
}

/**
 * `saved_team` — a team the agent SAVED this turn via `save_team` (T13, stamped
 * onto `OakAnswer` by the route). Lives in the persisted `answer_json`, so a
 * `ChatTurn`'s assistant `answer` re-renders the card on reload.
 */
export type SavedTeam = NonNullable<OakAnswer["saved_team"]>;

/**
 * "Saved ✓" card — confirms a chat-driven save and offers an "Open in viewer"
 * button that re-opens the saved team (fetched fresh by id) in the artifact
 * viewer, even after navigating away.
 */
export interface SavedTeamCardProps {
  savedTeam: SavedTeam;
}

/**
 * `suggestions[]` (with `status`) — clickable closest-match chips shown for
 * `clarification_needed` / `resolution_failed`. Clicking a chip sends it as a
 * follow-up user message.
 */
export interface SuggestionChipsProps {
  suggestions: string[];
  status: AnswerStatus;
  onSelect: (suggestion: string) => void;
  /** Disabled while a turn is streaming so a chip click can't orphan it (default false). */
  disabled?: boolean;
}

/**
 * `question.options` — the "ask the user" affordance, shown when a
 * `clarification_needed` answer carries structured options. Each option renders
 * as a clickable button; clicking sends `label` verbatim as a follow-up turn.
 * The always-present Composer covers the free-text path.
 */
export interface QuestionOptionsProps {
  options: QuestionOption[];
  onSelect: (label: string) => void;
  /** Disabled while a turn is streaming so an option click can't orphan it (default false). */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Chat shell
// ---------------------------------------------------------------------------

/**
 * A client-side image attachment. Carries BOTH the wire fields (`mimeType` +
 * raw-base64 `data`, sent in `ChatRequestBody.images`) and a `previewUrl` data
 * URL for the on-screen thumbnail. Produced by `@/lib/image-attachments` from a
 * picked/pasted file (downscaled + re-encoded client-side). Session-only: never
 * persisted, so thumbnails vanish on reload of a saved conversation.
 */
export interface PendingImage {
  id: string;
  mimeType: string;
  /** RAW base64 (no `data:` prefix) — the wire payload. */
  data: string;
  /** Full `data:` URL for the thumbnail preview. */
  previewUrl: string;
  /** Original filename (alt text / tooltip). */
  name: string;
}

/** A committed user turn in the thread. */
export interface UserTurn {
  id: string;
  role: "user";
  content: string;
}

/** A committed assistant turn — its rendered `OakAnswer`. */
export interface AssistantTurn {
  id: string;
  role: "assistant";
  answer: OakAnswer;
}

/** One entry in the visible conversation thread. */
export type ChatTurn = UserTurn | AssistantTurn;

/** Lifecycle of the active POST /api/chat turn. */
export type ChatStatus = "idle" | "streaming" | "error";

/**
 * Props for `ChatThread` — renders the committed turns, plus an in-flight
 * progress indicator (from `activity`) while `status === "streaming"`, plus a
 * transport-fault affordance when `transportError` is set.
 */
export interface ChatThreadProps {
  turns: ChatTurn[];
  /** Tool-activity labels for the in-flight turn (empty when idle). */
  activity: ToolActivityEvent[];
  status: ChatStatus;
  /**
   * In-flight answer_markdown accumulated from `answer_delta` events (empty when
   * none). Rendered as a live, progressively-updating bubble while streaming.
   */
  streamingMarkdown: string;
  /** Set only on transport faults (the `error` SSE event / network failure). */
  transportError: ErrorEvent | null;
  /**
   * True while an automatic reconnect is in progress after a screen-off
   * connection drop. Swaps the in-flight label for a "Reconnecting…" affordance
   * and restarts the elapsed counter (the turn stays `status === "streaming"`).
   */
  reconnecting?: boolean;
  /**
   * Re-send the last turn from the surfaced transport-error state (reuses the
   * message + attached images, so the user need not retype / re-attach). Renders
   * a "Retry" button when provided.
   */
  onRetry?: () => void;
  /** Threaded into each AnswerCard for suggestion/candidate follow-ups. */
  onFollowUp: OnFollowUp;
  /**
   * Thumbnail preview URLs for user turns that had image attachments, keyed by
   * turn id (a session-only client side-channel — the turn itself stays text).
   * Absent/empty ⇒ a text-only turn.
   */
  imagePreviews?: Record<string, string[]>;
}

/** Props for the `Composer` input box. */
export interface ComposerProps {
  /**
   * Submit a new user turn. `images` is empty for a text-only turn; `message`
   * may be empty when `images` is non-empty (an image-only upload).
   */
  onSend: (message: string, images: PendingImage[]) => void;
  /** Disabled while a turn is streaming (default: false). */
  disabled?: boolean;
  /**
   * True while a turn is in flight — the Send button becomes a Stop button
   * (always clickable) so the user can abort the running request.
   */
  streaming?: boolean;
  /** Abort the in-flight turn. Invoked when the Stop button is clicked. */
  onStop?: () => void;
  /**
   * Push text into the (otherwise self-managed) input. Use a fresh object each
   * time so the same text can be re-applied — the Composer reloads its value
   * whenever this object's identity changes. Null leaves the input untouched.
   */
  prefill?: { text: string } | null;
  /**
   * Champions-mode scope for the next turn. When provided (together with
   * `onChampionsChange`), the composer renders the Champions logo toggle in a
   * controls row above the input. Omit both to hide the control entirely.
   */
  championsMode?: boolean;
  /** Report a Champions-mode toggle. Paired with `championsMode`. */
  onChampionsChange?: (next: boolean) => void;
}

// ---------------------------------------------------------------------------
// sse-client hook return shape (`src/lib/sse/sse-client.ts`)
// ---------------------------------------------------------------------------

/**
 * Return shape of the `useOakChat` hook (the SSE client).
 *
 * Implementation contract (design.md SSE directive): the hook POSTs to
 * `/api/chat` with `{ session_id, message }` and reads the response body with a
 * MANUAL stream reader (NOT EventSource). It surfaces progress (`tool_activity`
 * events → `activity`) and then the terminal `answer` event, committing it as an
 * `AssistantTurn`. In-domain failures arrive as a normal `answer` (a
 * `OakAnswer` with a non-`answered` status) and are committed like any other
 * answer — only the transport-level `error` event sets `transportError`.
 */
export interface UseOakChatResult {
  /** Stable session id sent as `session_id` on every turn. */
  sessionId: string;
  /** The committed conversation (user + assistant turns), in order. */
  turns: ChatTurn[];
  /** Lifecycle of the active turn. */
  status: ChatStatus;
  /** Tool-activity labels for the in-flight turn; cleared when the answer lands. */
  activity: ToolActivityEvent[];
  /** Set only on transport faults; null otherwise. */
  transportError: ErrorEvent | null;
  /**
   * POST a new user turn (same session_id). If a turn is already in flight it is
   * ABORTED and replaced — the hook does not no-op. Callers that must not
   * interrupt an in-flight turn gate the call site (the composer is disabled and
   * `handleSend` returns early while `status === "thinking"`).
   */
  send: (message: string) => void;
}

/** The hook signature implemented by `src/lib/sse/sse-client.ts`. */
export type UseOakChat = () => UseOakChatResult;

// ---------------------------------------------------------------------------
// Artifact viewer (B-4)
// ---------------------------------------------------------------------------

// Re-export the artifact-viewer client contract (the back-stack view types +
// the context API) so page/leaf consumers import it from this one frontend
// surface, alongside the OakAnswer + SSE types above.
export type {
  ArtifactView,
  ArtifactViewerApi,
  EntityRequest,
  StructuredArtifact,
  StructuredArtifactInput,
} from "@/components/artifact/types";
