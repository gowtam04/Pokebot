/**
 * PasteImportDialog — paste a Showdown export, import it as a NEW team
 * (TEAM-US-10, AC). The paste is tolerant: unresolved names / over-cap / illegal
 * sets still import, each annotated with an {@link ImportNote} the server returns
 * (BR-T7/BR-T11) — nothing is silently dropped and no wholesale abort happens.
 *
 * `onImport` is the never-throwing `useTeams.importPaste` (folds guest/transport
 * failures to `null`). On success the dialog shows the resolve-or-clarify notes
 * and an "Open team" action that hands the saved team back to the page
 * (`onImported`) to select it in the editor; a `null` result surfaces an inline
 * failure message, never a thrown error.
 */

"use client";

import { useEffect, useState } from "react";

import type { ImportNote, TeamDetail } from "@/lib/teams-client";

export interface PasteImportDialogProps {
  open: boolean;
  /** Format the imported team is created under. */
  format: string;
  onClose: () => void;
  onImport: (
    format: string,
    paste: string,
  ) => Promise<{ team: TeamDetail; notes: ImportNote[] } | null>;
  /** Called with the saved team once import succeeds (page selects it). */
  onImported?: (team: TeamDetail) => void;
}

type Phase =
  | { kind: "edit" }
  | { kind: "error" }
  | { kind: "done"; notes: ImportNote[] };

export default function PasteImportDialog({
  open,
  format,
  onClose,
  onImport,
  onImported,
}: PasteImportDialogProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });

  // Reset to a clean edit state each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setText("");
      setSubmitting(false);
      setPhase({ kind: "edit" });
    }
  }, [open]);

  if (!open) return null;

  async function submit() {
    if (submitting || text.trim().length === 0) return;
    setSubmitting(true);
    const result = await onImport(format, text);
    setSubmitting(false);
    if (!result) {
      setPhase({ kind: "error" });
      return;
    }
    setPhase({ kind: "done", notes: result.notes });
    onImported?.(result.team);
  }

  return (
    <div
      className="import-dialog__backdrop"
      data-testid="import-dialog-backdrop"
      onClick={onClose}
      style={backdropStyle}
    >
      <div
        className="import-dialog"
        data-testid="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import team from paste"
        onClick={(e) => e.stopPropagation()}
        style={dialogStyle}
      >
        <div style={headerStyle}>
          <h2 style={titleStyle}>Import from paste ({format})</h2>
          <button
            type="button"
            data-testid="import-close"
            aria-label="Close import"
            onClick={onClose}
            style={closeButtonStyle}
          >
            ×
          </button>
        </div>

        {phase.kind === "done" ? (
          <div
            data-testid="import-result"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <p data-testid="import-success" role="status">
              Imported. {phase.notes.length === 0
                ? "Everything resolved cleanly."
                : `${phase.notes.length} item(s) need a look:`}
            </p>
            {phase.notes.length > 0 && (
              <ul data-testid="import-notes" style={{ margin: 0 }}>
                {phase.notes.map((note, i) => (
                  <li
                    key={`${note.slot}-${note.kind}-${i}`}
                    data-testid="import-note"
                    data-kind={note.kind}
                  >
                    Slot {note.slot + 1} ({note.kind}): {note.message}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" data-testid="import-done" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            {phase.kind === "error" && (
              <p data-testid="import-error" role="alert">
                Couldn&apos;t import that paste. Check you&apos;re signed in and
                try again.
              </p>
            )}
            <textarea
              data-testid="import-text"
              aria-label="Showdown paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder="Paste a Showdown export here…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                font: "400 13px/1.5 var(--font-mono)",
              }}
            />
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                type="button"
                data-testid="import-submit"
                onClick={submit}
                disabled={submitting || text.trim().length === 0}
              >
                {submitting ? "Importing…" : "Import"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-4)",
  background: "rgba(35, 31, 28, 0.45)",
  zIndex: 50,
};

const dialogStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-overlay)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  font: "600 20px/1.3 var(--font-display)",
  color: "var(--text-strong)",
};

// 44px touch target for the "×" close (was unstyled, ~24px on a phone).
const closeButtonStyle: React.CSSProperties = {
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "44px",
  height: "44px",
  fontSize: "24px",
  lineHeight: 1,
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
};
