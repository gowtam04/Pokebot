/**
 * ArtifactViewer — the panel shell (B-4, Phase 5). Renders the open artifact
 * (top of the back-stack): a header (title, format/generation tag, back, close,
 * "ask about this in chat") and a body that dispatches by view type and load
 * state. Hidden when nothing is open (the chat reflows to full width, AV-US-7).
 *
 * Honest states throughout (BR-AV-5, AV-US-11): loading, transport error,
 * `not_found` (+ suggestions), and `unavailable` each render a clear message
 * rather than a blank or a crash. Esc closes (NFR-4).
 */

"use client";

import { useEffect, useRef, useState } from "react";

import CaveatStrip from "@/components/CaveatStrip";
import type { EntityArtifactOk } from "@/lib/entity-artifact";

import { useArtifactViewer } from "./useArtifactViewer";
import type { ArtifactView } from "./types";
import ArtifactSources from "./ArtifactSources";
import PokemonArtifact from "./PokemonArtifact";
import MoveArtifact from "./MoveArtifact";
import AbilityArtifact from "./AbilityArtifact";
import ItemArtifact from "./ItemArtifact";
import TypeMatchupsArtifact from "./TypeMatchupsArtifact";
import ComparisonArtifact from "./ComparisonArtifact";
import DamageCalcArtifact from "./DamageCalcArtifact";
import TeamArtifact from "./TeamArtifact";

function formatLabel(format: string): string {
  return format === "champions" ? "Champions" : "Scarlet/Violet";
}

interface HeaderInfo {
  title: string;
  formatTag: string;
  askText: string;
}

function headerFor(view: ArtifactView): HeaderInfo {
  if (view.type === "team") {
    const name = view.detail?.name || view.title;
    return {
      title: name,
      formatTag: formatLabel(view.format),
      askText: `Tell me about the team "${name}".`,
    };
  }
  if (view.type === "structured") {
    if (view.artifact.kind === "comparison") {
      return {
        title: "Comparison",
        formatTag: formatLabel(view.artifact.format),
        askText: "Tell me more about this comparison.",
      };
    }
    return {
      title: "Damage calculation",
      formatTag: formatLabel(view.artifact.format),
      askText: "Explain this damage calculation in more detail.",
    };
  }
  // Entity view.
  if (view.phase === "done" && view.response?.status === "ok") {
    return {
      title: view.response.resolved.display_name,
      formatTag: view.response.generation,
      askText: `Tell me more about ${view.response.resolved.display_name}.`,
    };
  }
  return {
    title: view.request.q,
    formatTag: formatLabel(view.request.format),
    askText: `Tell me about ${view.request.q}.`,
  };
}

function EntityRenderer({
  response,
}: {
  response: EntityArtifactOk;
}): React.JSX.Element {
  switch (response.kind) {
    case "pokemon":
      return <PokemonArtifact data={response.data} />;
    case "move":
      return <MoveArtifact data={response.data} />;
    case "ability":
      return <AbilityArtifact data={response.data} />;
    case "item":
      return <ItemArtifact data={response.data} />;
    case "type":
      return <TypeMatchupsArtifact data={response.data} />;
  }
}

function ArtifactBody({ view }: { view: ArtifactView }): React.JSX.Element {
  if (view.type === "structured") {
    return view.artifact.kind === "comparison" ? (
      <ComparisonArtifact subjects={view.artifact.subjects} />
    ) : (
      <DamageCalcArtifact damageCalc={view.artifact.damageCalc} />
    );
  }

  if (view.type === "team") {
    if (view.phase === "loading") {
      return (
        <div className="artifact-viewer__loading" data-testid="artifact-loading">
          <span className="artifact-viewer__spinner" aria-hidden />
          <span>Loading…</span>
        </div>
      );
    }
    if (view.phase === "error" || view.detail === null) {
      return (
        <div className="artifact-viewer__state" data-testid="artifact-error">
          Couldn’t load this team. It may have been deleted.
        </div>
      );
    }
    return <TeamArtifact view={view} />;
  }

  if (view.phase === "loading") {
    return (
      <div className="artifact-viewer__loading" data-testid="artifact-loading">
        <span className="artifact-viewer__spinner" aria-hidden />
        <span>Loading…</span>
      </div>
    );
  }

  if (view.phase === "error" || view.response === null) {
    return (
      <div className="artifact-viewer__state" data-testid="artifact-error">
        Couldn’t load this. Please try again.
      </div>
    );
  }

  const { response } = view;
  if (response.status === "unavailable") {
    return (
      <div
        className="artifact-viewer__state"
        data-testid="artifact-unavailable"
      >
        Data isn’t available for this format right now.
      </div>
    );
  }
  if (response.status === "not_found") {
    return (
      <div className="artifact-viewer__state" data-testid="artifact-not-found">
        <p>No match found for “{response.query}”.</p>
        {response.suggestions.length > 0 && (
          <p className="artifact-viewer__suggestions">
            Did you mean: {response.suggestions.join(", ")}?
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {response.is_fallback && (
        <CaveatStrip
          uncertaintyFlags={[]}
          generationBasis={{
            generation: response.generation,
            fallback: true,
            note: response.fallback_note,
          }}
        />
      )}
      <EntityRenderer response={response} />
      <ArtifactSources citations={response.citations} />
    </>
  );
}

export default function ArtifactViewer(): React.JSX.Element | null {
  const { isOpen, current, canGoBack, back, close, askInChat } =
    useArtifactViewer();
  const panelRef = useRef<HTMLElement>(null);

  // Are we in the full-screen-overlay regime (mirrors the CSS 768px breakpoint)?
  // There the panel is a modal dialog; on desktop it's a docked complementary
  // panel that must leave the chat scrollable/focusable.
  const [isMobileOverlay, setIsMobileOverlay] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 768px)");
    if (!mq) return;
    const update = () => setIsMobileOverlay(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // Modal behavior for the mobile overlay only: lock the page behind it (so iOS
  // can't scroll the hidden chat), move focus in, restore it on close, and trap
  // Tab so keyboard/AT focus can't escape onto the obscured chat.
  useEffect(() => {
    if (!isOpen || !isMobileOverlay) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    panel?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [isOpen, isMobileOverlay]);

  if (!isOpen || !current) return null;

  const { title, formatTag, askText } = headerFor(current);

  return (
    <aside
      ref={panelRef}
      className="artifact-viewer"
      data-testid="artifact-viewer"
      role={isMobileOverlay ? "dialog" : "complementary"}
      aria-modal={isMobileOverlay || undefined}
      aria-label="Artifact viewer"
      tabIndex={-1}
    >
      <header className="artifact-viewer__header">
        <div className="artifact-viewer__topline">
          {canGoBack && (
            <button
              type="button"
              className="artifact-viewer__btn artifact-viewer__back"
              data-testid="artifact-back"
              onClick={back}
            >
              ← Back
            </button>
          )}
          <h2 className="artifact-viewer__title" data-testid="artifact-title">
            {title}
          </h2>
          <div className="artifact-viewer__control-actions">
            <button
              type="button"
              className="artifact-viewer__btn artifact-viewer__ask"
              data-testid="artifact-ask"
              onClick={() => askInChat(askText)}
            >
              Ask about this in chat
            </button>
            <button
              type="button"
              className="artifact-viewer__btn artifact-viewer__close"
              data-testid="artifact-close"
              aria-label="Close artifact viewer"
              onClick={close}
            >
              ✕
            </button>
          </div>
        </div>
        <span
          className="artifact-viewer__format-tag"
          data-testid="artifact-format-tag"
        >
          {formatTag}
        </span>
      </header>

      <div className="artifact-viewer__body" data-testid="artifact-viewer-body">
        <ArtifactBody view={current} />
      </div>
    </aside>
  );
}
