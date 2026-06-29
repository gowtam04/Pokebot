"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSseClient } from "@/lib/sse-client";
import ChatThread from "@/components/ChatThread";
import Composer from "@/components/Composer";
import ThemeToggle from "@/components/ThemeToggle";
import ChampionsToggle from "@/components/ChampionsToggle";
import ModelSelector from "@/components/ModelSelector";
import { DEFAULT_MODEL_KEY, isModelKey, type ModelKey } from "@/agent/models";
import AuthMenu from "@/components/auth/AuthMenu";
import AuthDialog from "@/components/auth/AuthDialog";
import ConversationList from "@/components/history/ConversationList";
import SidebarToggle from "@/components/SidebarToggle";
import ActiveTeamSelector from "@/components/teams/ActiveTeamSelector";
import SavedTeamAutoOpen from "@/components/teams/SavedTeamAutoOpen";
import { ArtifactViewerProvider } from "@/components/artifact/ArtifactViewerProvider";
import ArtifactViewer from "@/components/artifact/ArtifactViewer";
import { fetchMe, type MeResult } from "@/lib/auth-client";
import { useConversations } from "@/lib/use-conversations";
import { getConversation, importConversation } from "@/lib/history-client";
import type {
  ChatStatus,
  ChatTurn,
  OakAnswer,
  PendingImage,
  SavedTeam,
} from "@/components/types";

/** localStorage key for the persisted Champions-mode choice. */
const CHAMPIONS_STORAGE_KEY = "oak-champions-mode";

/** localStorage key for the persisted model choice (global preference). */
const MODEL_STORAGE_KEY = "oak-model";

/** localStorage key for the persisted history-sidebar collapsed choice. */
const SIDEBAR_STORAGE_KEY = "oak-sidebar-collapsed";

/** DOM id of the history sidebar — the toggle's `aria-controls` target. */
const SIDEBAR_ID = "history-sidebar";

/** A request stopped within this many ms of being sent wipes the chat. */
const QUICK_STOP_MS = 2000;

/** Generate a stable id (session id + turn ids). Falls back when crypto.randomUUID is absent. */
function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Home — the Oak chat page (design.md § Phase 7).
 *
 * Owns the conversation surface: a stable `session_id`, the committed `turns[]`
 * (user + assistant), and the in-flight turn via `useSseClient` (the manual SSE
 * client hook — NOT EventSource). When a turn's terminal answer lands it is
 * committed as an assistant turn (in-domain failures included — they arrive as a
 * normal answer). Suggestion/candidate follow-ups are plain `send` calls reusing
 * the same `session_id` (ux-design.md). Visuals deferred to `frontend-design`.
 */
export default function Home() {
  const [sessionId, setSessionId] = useState<string>(() => makeId());
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // Session-only thumbnails for user turns that attached images, keyed by turn id
  // (a client side-channel — the turn + persisted history stay text-only).
  const [imagePreviews, setImagePreviews] = useState<Record<string, string[]>>(
    {},
  );
  const { status, activities, answer, streamingMarkdown, error, send, reset } =
    useSseClient();

  // Track the active request so Stop can decide between a quick-stop reset and a
  // plain stop, and restore the stopped message into the composer.
  const requestStartRef = useRef<number>(0);
  const inFlightMessageRef = useRef<string>("");
  // A fresh object pushed into the Composer to reload its input after a quick
  // stop (identity change is what triggers the reload).
  const [prefill, setPrefill] = useState<{ text: string } | null>(null);

  // Active team bound to THIS on-screen conversation (TEAM-US-8 / AC-8.1).
  // Server-controlled scope, default none: sent as `active_team_id` on every
  // chat turn (the route resolves + binds it onto ctx.activeTeam, format-gated),
  // restored from GET /api/conversations/[id] on open, and cleared on a format
  // toggle / different-format conversation (AC-8.3). It is conversation-scoped,
  // never auth-scoped — a guest simply has no teams to select.
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

  // Champions mode: server-controlled scope sent on every request as
  // `champions_mode`. Defaults to ON — resolve from localStorage only AFTER
  // mount so the SSR markup stays stable (mirrors ThemeToggle's
  // `getInitialTheme` + mounted guard) and we avoid a hydration mismatch. A
  // never-set value (null) means the user hasn't chosen, so default to on; an
  // explicit "false" (the user turned it off) is honored.
  const [championsMode, setChampionsMode] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHAMPIONS_STORAGE_KEY);
      setChampionsMode(stored === null ? true : stored === "true");
    } catch {
      /* storage unavailable (private mode) — fall back to the default (on) */
      setChampionsMode(true);
    }
  }, []);

  const setChampionsModePersisted = useCallback((next: boolean) => {
    setChampionsMode(next);
    try {
      localStorage.setItem(CHAMPIONS_STORAGE_KEY, String(next));
    } catch {
      /* storage unavailable (private mode) — fall back to in-session only */
    }
  }, []);

  // Selected model: a GLOBAL preference (not conversation-scoped) sent on every
  // request as `model`. Default to the primary model (Grok) so SSR markup is
  // deterministic, then resolve the stored choice AFTER mount (same hydration
  // pattern as championsMode), validating it through `isModelKey` so a
  // stale/garbage value falls back to the default rather than being trusted.
  const [selectedModel, setSelectedModel] =
    useState<ModelKey>(DEFAULT_MODEL_KEY);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(MODEL_STORAGE_KEY);
      if (stored && isModelKey(stored)) setSelectedModel(stored);
    } catch {
      /* storage unavailable (private mode) — keep the default (Grok) */
    }
  }, []);

  const setSelectedModelPersisted = useCallback((next: ModelKey) => {
    setSelectedModel(next);
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, next);
    } catch {
      /* storage unavailable (private mode) — fall back to in-session only */
    }
  }, []);

  // Which models the SERVER actually has configured (GET /api/config). Drives the
  // dropdown's disabled options and an auto-revert if the persisted/selected model
  // isn't usable. `null` until resolved (or on failure) ⇒ nothing is disabled.
  const [configuredModels, setConfiguredModels] = useState<ModelKey[] | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { configuredModels?: unknown } | null) => {
        if (!active || !data) return;
        if (Array.isArray(data.configuredModels)) {
          setConfiguredModels(
            data.configuredModels.filter((k): k is ModelKey => isModelKey(k)),
          );
        }
      })
      .catch(() => {
        /* config is non-critical — leave every model enabled */
      });
    return () => {
      active = false;
    };
  }, []);

  // If the persisted/selected model isn't configured on this server, fall back to
  // the default (Grok — always configured, since XAI_API_KEY is required at boot)
  // so the user can't sit on an unusable selection.
  useEffect(() => {
    if (configuredModels && !configuredModels.includes(selectedModel)) {
      setSelectedModelPersisted(DEFAULT_MODEL_KEY);
    }
  }, [configuredModels, selectedModel, setSelectedModelPersisted]);

  // A model/provider fault (503 model_unavailable pre-stream, or model_provider_error
  // mid-stream) means the chosen model isn't usable right now — revert to the
  // default (Grok) so the next attempt works.
  useEffect(() => {
    if (
      status === "error" &&
      (error?.code === "model_unavailable" ||
        error?.code === "model_provider_error") &&
      selectedModel !== DEFAULT_MODEL_KEY
    ) {
      setSelectedModelPersisted(DEFAULT_MODEL_KEY);
    }
  }, [status, error, selectedModel, setSelectedModelPersisted]);

  // History-sidebar collapsed state. Default expanded so the first render is
  // deterministic (the sidebar + its toggle are both gated on `auth.signedIn`,
  // which only flips after `fetchMe()` resolves post-mount, so no SSR markup
  // ever contains them — no hydration risk). Resolve the real choice after
  // mount: a stored explicit choice wins; absent one, narrow screens (≤768px)
  // start collapsed (decided once, like the artifact viewer's CSS breakpoint).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      // On a phone the sidebar is an overlay drawer, so it must NEVER start open
      // (it would cover the chat). Force-collapse there regardless of a stored
      // desktop preference — without persisting, so the desktop choice survives.
      const isMobile =
        window.matchMedia?.("(max-width: 768px)").matches ?? false;
      if (isMobile) {
        setSidebarCollapsed(true);
        return;
      }
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === "true" || stored === "false") {
        setSidebarCollapsed(stored === "true");
      }
      // else: keep the default (expanded) on desktop.
    } catch {
      /* storage/matchMedia unavailable — keep the default (expanded) */
    }
  }, []);

  const setSidebarCollapsedPersisted = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      /* storage unavailable (private mode) — fall back to in-session only */
    }
  }, []);

  // Auth identity (account-creation design.md § API "/api/auth/me"; AUTH-US-1 /
  // AC-1.2). Auth is a SEPARATE concern from the conversation: it lives in a
  // cookie/account, never in `sessionId`/`turns[]`, so signing in or out must
  // leave the on-screen thread untouched (BR-A10 / AUTH-US-6 — enforced below).
  const [auth, setAuth] = useState<MeResult>({ signedIn: false });
  const [authDialogOpen, setAuthDialogOpen] = useState(false);

  // Durable chat history (chat-history B-3). The hook lists/searches/filters and
  // mutates the signed-in account's conversations; it stays empty + makes no
  // fetch for guests (`enabled = auth.signedIn`). The conversation `sessionId`
  // below IS the conversation id (HIST-AD-1), so opening / new-chat / import all
  // hang off it. `refresh`/`remove` are stable, so we use them in deps directly.
  const conversations = useConversations(auth.signedIn);
  const { refresh: refreshConversations, remove: removeConversation } =
    conversations;

  // Resolve auth state on mount so the header renders guest vs signed-in. The
  // page is a client component, so this runs after hydration; `fetchMe` never
  // throws (a guest / unknown cookie / transport fault all resolve to
  // `{ signedIn: false }`), so no error path is needed (BR-A11).
  useEffect(() => {
    let active = true;
    void fetchMe().then((me) => {
      if (active) setAuth(me);
    });
    return () => {
      active = false;
    };
  }, []);

  // Sign-in completed in the dialog. Close it and re-resolve identity (to pick up
  // the account email for the menu). CRITICAL: we do NOT touch `sessionId` or
  // `turns[]` — the conversation visible before sign-in stays visible and usable
  // (BR-A10 / AC-6.1, AC-6.2). The `created` flag (new account vs returning
  // login) is intentionally not surfaced here; both paths land in the same UI.
  const handleSignedIn = useCallback(() => {
    setAuthDialogOpen(false);
    void fetchMe().then((me) => {
      setAuth(me);
      // BR-H10 / HIST-US-12: the on-screen guest thread's full-fidelity turns
      // live only on the client at this moment, so save them into the new
      // account (idempotent import), then surface it in the now-enabled history
      // list. An empty thread imports nothing (AC-12.2 — repo returns null).
      if (me.signedIn && turns.length > 0) {
        void importConversation(sessionId, championsMode, turns).then(() =>
          refreshConversations(),
        );
      }
    });
  }, [sessionId, championsMode, turns, refreshConversations]);

  // Sign-out completed (current device only — AC-5.2). Revert to the guest tier
  // WITHOUT resetting `sessionId` or clearing `turns[]`: the thread persists
  // across the user→guest transition exactly as it does across guest→user
  // (BR-A10).
  const handleSignedOut = useCallback(() => {
    setAuth({ signedIn: false });
  }, []);

  // Commit each terminal answer exactly once (guard against effect re-runs /
  // React strict-mode double-invoke by tracking the committed object identity).
  const committedAnswerRef = useRef<OakAnswer | null>(null);
  // A team the agent JUST saved (save_team, T13) — set only from a fresh answer
  // so the viewer auto-opens on arrival, never when reloading history.
  const [savedTeamToOpen, setSavedTeamToOpen] = useState<SavedTeam | null>(null);
  useEffect(() => {
    if (status === "done" && answer && committedAnswerRef.current !== answer) {
      committedAnswerRef.current = answer;
      setTurns((prev) => [
        ...prev,
        { id: makeId(), role: "assistant", answer },
      ]);
      if (answer.saved_team) setSavedTeamToOpen(answer.saved_team);
      // Signed in: the server just persisted this turn (creating the
      // conversation on the first turn, or bumping it to the top on a
      // follow-up). Re-list so the sidebar reflects the new title / ordering.
      if (auth.signedIn) refreshConversations();
    }
  }, [status, answer, auth.signedIn, refreshConversations]);

  const handleSend = useCallback(
    (message: string, images: PendingImage[] = []) => {
      requestStartRef.current = Date.now();
      inFlightMessageRef.current = message;
      const userTurnId = makeId();
      setTurns((prev) => [
        ...prev,
        { id: userTurnId, role: "user", content: message },
      ]);
      // Stash the thumbnails in a session-only side-channel keyed by turn id, so
      // the user bubble can show what they sent without putting (large, transient)
      // image data on the ChatTurn itself — keeping history/import payloads text.
      if (images.length > 0) {
        setImagePreviews((prev) => ({
          ...prev,
          [userTurnId]: images.map((img) => img.previewUrl),
        }));
      }
      committedAnswerRef.current = null;
      // Build the body as a variable (not a fresh literal) so the additive
      // team-builder field `active_team_id` rides along without tripping
      // excess-property checks on the `ChatRequestBody` param. The server
      // resolves + format-gates it and persists it last-selected-wins.
      const body = {
        session_id: sessionId,
        message,
        champions_mode: championsMode,
        active_team_id: activeTeamId,
        model: selectedModel,
        // Wire-only image fields (mimeType + raw base64); the preview URLs stay
        // client-side. Omitted entirely for a text-only turn.
        ...(images.length > 0
          ? { images: images.map((img) => ({ mimeType: img.mimeType, data: img.data })) }
          : {}),
      };
      send(body);
    },
    [send, sessionId, championsMode, activeTeamId, selectedModel],
  );

  // Start a brand-new conversation (AC-6.1): a fresh session id + empty thread.
  // No DB row is created until the first successful turn. The previous
  // conversation remains saved + unchanged.
  const handleNewChat = useCallback(() => {
    reset();
    committedAnswerRef.current = null;
    setSessionId(makeId());
    setTurns([]);
    setImagePreviews({});
    setActiveTeamId(null);
  }, [reset]);

  // Open a saved conversation (HIST-US-4): load its full-fidelity turns, make it
  // the live thread (its id becomes the session id, so the composer continues
  // it), and follow its stored format (AC-5.4).
  const handleOpenConversation = useCallback(
    (id: string) => {
      void getConversation(id).then((detail) => {
        if (!detail) return;
        reset();
        committedAnswerRef.current = null;
        setSessionId(detail.id);
        setTurns(detail.turns);
        setImagePreviews({}); // session-only thumbnails don't survive a reload
        setChampionsModePersisted(detail.format === "champions");
        // Restore the conversation's bound active team (AC-8.1). The server only
        // ever persists a format-matched team, so the restored id is already
        // valid for this conversation's format; `active_team_id` is present on
        // the GET body even though `ConversationDetail` doesn't type it.
        setActiveTeamId(
          (detail as { active_team_id?: string | null }).active_team_id ?? null,
        );
      });
    },
    [reset, setChampionsModePersisted],
  );

  // Delete a conversation (HIST-US-8). If it is the one currently on screen,
  // reset to a fresh empty chat so we never show a broken/empty thread (AC-8.2).
  const handleDeleteConversation = useCallback(
    (id: string) => {
      void removeConversation(id);
      if (id === sessionId) handleNewChat();
    },
    [removeConversation, sessionId, handleNewChat],
  );

  // Stop the in-flight turn. `reset()` aborts the fetch (which propagates to the
  // server, halting generation) and returns the SSE hook to idle. If the request
  // was stopped within QUICK_STOP_MS, wipe the conversation to a brand-new
  // session and restore the message into the composer for an easy redo;
  // otherwise leave the (now answer-less) turn in the thread.
  const handleStop = useCallback(() => {
    const elapsed = Date.now() - requestStartRef.current;
    reset();
    committedAnswerRef.current = null;
    if (elapsed < QUICK_STOP_MS) {
      setTurns([]);
      setImagePreviews({});
      setSessionId(makeId());
      setActiveTeamId(null);
      setPrefill({ text: inFlightMessageRef.current });
    }
  }, [reset]);

  // Champions toggle from the header (AC-8.3). Switching format changes the data
  // scope, so any team bound for the previous format no longer applies — clear
  // the active selection. (Opening a saved conversation also flips the format,
  // but goes through `setChampionsModePersisted` directly so its just-restored
  // active team is preserved — only an EXPLICIT user toggle clears.)
  const handleChampionsToggle = useCallback(
    (next: boolean) => {
      setChampionsModePersisted(next);
      setActiveTeamId(null);
    },
    [setChampionsModePersisted],
  );

  const chatStatus: ChatStatus =
    status === "thinking" ? "streaming" : status === "error" ? "error" : "idle";

  // Artifact viewer (B-4). The viewer's data scope mirrors the current Champions
  // toggle (snapshotted onto each artifact at open, BR-AV-7). "Ask about this in
  // chat" pre-fills the composer (TD-7) by reusing the existing prefill channel —
  // a fresh object so the same text can be re-applied on its next use.
  const artifactFormat = championsMode ? "champions" : "scarlet-violet";
  const handleAskInChat = useCallback((text: string) => {
    setPrefill({ text });
  }, []);

  // Header overflow menu (mobile): below 640px the secondary controls (model /
  // champions / theme + the signed-in team controls) collapse behind a single
  // gear button so they stop overflowing the red band off-screen. Desktop
  // renders them inline and never shows the gear. Close on outside-tap / Escape.
  const [menuOpen, setMenuOpen] = useState(false);
  const headerClusterRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!headerClusterRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        // Return focus to the trigger — the focused control inside the panel is
        // about to be display:none'd, which would otherwise drop focus to <body>.
        moreBtnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Mobile history drawer is a modal overlay (covers the chat behind a scrim), so
  // let Escape dismiss it too — parity with the popover + artifact viewer. Uses
  // the NON-persisting setter + a viewport guard so it never collapses the
  // in-flow desktop sidebar or clobbers the stored desktop preference.
  useEffect(() => {
    if (!auth.signedIn || sidebarCollapsed) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        (window.matchMedia?.("(max-width: 768px)").matches ?? false)
      ) {
        setSidebarCollapsed(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [auth.signedIn, sidebarCollapsed]);

  return (
    <main className="chat-page" data-testid="chat-page">
      <header className="chat-page__header">
        <div className="chat-page__title-cluster">
          {auth.signedIn && (
            <SidebarToggle
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsedPersisted(!sidebarCollapsed)}
              controlsId={SIDEBAR_ID}
            />
          )}
          <h1 className="chat-page__title">Oak</h1>
        </div>
        <div className="chat-page__header-cluster" ref={headerClusterRef}>
          {/* Collapsible group: inline on desktop, a popover under the gear on
              mobile (≤640px). The popover panel re-uses the red-band background
              in CSS so the translucent-white pills keep their contrast. */}
          <div
            id="header-controls"
            className={
              "chat-page__controls" +
              (menuOpen ? " chat-page__controls--open" : "")
            }
          >
            {auth.signedIn && (
              <>
                <ActiveTeamSelector
                  format={artifactFormat}
                  conversationId={sessionId}
                  value={activeTeamId}
                  onChange={setActiveTeamId}
                  enabled={auth.signedIn}
                />
                <a className="chat-page__teams-link" href="/teams">
                  Teams
                </a>
                <span className="chat-page__header-divider" aria-hidden></span>
              </>
            )}
            <ModelSelector
              value={selectedModel}
              onChange={setSelectedModelPersisted}
              configuredModels={configuredModels ?? undefined}
            />
            <ChampionsToggle
              checked={championsMode}
              onChange={handleChampionsToggle}
            />
            <span className="chat-page__header-divider" aria-hidden></span>
            <ThemeToggle />
          </div>
          {/* Mobile-only trigger for the control popover (CSS hides it ≥640px). */}
          <button
            ref={moreBtnRef}
            type="button"
            className="chat-page__more"
            aria-label="More settings"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="header-controls"
            data-testid="header-more"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <SlidersIcon />
          </button>
          <AuthMenu
            signedIn={auth.signedIn}
            email={auth.email}
            onSignInClick={() => setAuthDialogOpen(true)}
            onSignedOut={handleSignedOut}
          />
        </div>
      </header>

      <div className="chat-page__body">
        <ArtifactViewerProvider
          format={artifactFormat}
          onAskInChat={handleAskInChat}
        >
          {/* History sidebar — signed-in only (guests have no server history).
              Collapses to width 0 via the toggle; the inner wrapper keeps its
              fixed width so content doesn't reflow mid-slide, and goes `inert`
              when collapsed so its controls leave the tab + a11y trees. */}
          {auth.signedIn && (
            <aside
              id={SIDEBAR_ID}
              data-testid="history-sidebar"
              className={
                "chat-page__sidebar" +
                (sidebarCollapsed ? " chat-page__sidebar--collapsed" : "")
              }
            >
              <div
                className="chat-page__sidebar-inner"
                inert={sidebarCollapsed ? true : undefined}
              >
                <ConversationList
                  conversations={conversations.conversations}
                  activeId={sessionId}
                  query={conversations.query}
                  onQueryChange={conversations.setQuery}
                  formatFilter={conversations.formatFilter}
                  onFormatFilterChange={conversations.setFormatFilter}
                  onNewChat={handleNewChat}
                  onOpen={handleOpenConversation}
                  onRename={conversations.rename}
                  onPin={conversations.pin}
                  onDelete={handleDeleteConversation}
                />
              </div>
            </aside>
          )}

          {/* Mobile drawer scrim: tap to dismiss the history sidebar. Only
              rendered when the drawer is open; CSS shows it as a full-screen
              overlay below 768px and hides it on desktop (where the sidebar is
              an in-flow column, not an overlay). */}
          {auth.signedIn && !sidebarCollapsed && (
            <div
              className="chat-page__scrim"
              data-testid="sidebar-scrim"
              aria-hidden="true"
              // Non-persisting: dismissing the mobile overlay must not overwrite
              // the stored DESKTOP sidebar preference (mount force-collapses on
              // mobile without persisting for the same reason).
              onClick={() => setSidebarCollapsed(true)}
            />
          )}

          <div className="chat-page__main">
            <ChatThread
              turns={turns}
              activity={activities}
              status={chatStatus}
              streamingMarkdown={streamingMarkdown}
              transportError={status === "error" ? error : null}
              onFollowUp={handleSend}
              imagePreviews={imagePreviews}
            />

            <Composer
              onSend={handleSend}
              disabled={status === "thinking"}
              streaming={status === "thinking"}
              onStop={handleStop}
              prefill={prefill}
            />
          </div>

          {/* Headless: auto-opens a just-saved team in the viewer on arrival. */}
          <SavedTeamAutoOpen savedTeam={savedTeamToOpen} />

          {/* Docked side panel (full-screen overlay on mobile); hidden until an
              artifact is opened, at which point the chat reflows (AV-US-7). */}
          <ArtifactViewer />
        </ArtifactViewerProvider>
      </div>

      <AuthDialog
        open={authDialogOpen}
        onClose={() => setAuthDialogOpen(false)}
        onSignedIn={handleSignedIn}
      />
    </main>
  );
}

/** Sliders / settings glyph for the mobile header overflow trigger. */
function SlidersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2" />
      <circle cx={16} cy={6} r={2} />
      <circle cx={8} cy={12} r={2} />
      <circle cx={16} cy={18} r={2} />
    </svg>
  );
}
