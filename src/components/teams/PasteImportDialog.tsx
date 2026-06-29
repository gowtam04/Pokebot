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
    >
      <div
        className="import-dialog"
        data-testid="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import team from paste"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="import-dialog__header">
          <h2 className="import-dialog__title">Import from paste ({format})</h2>
          <button
            type="button"
            className="import-dialog__close"
            data-testid="import-close"
            aria-label="Close import"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {phase.kind === "done" ? (
          <div className="import-dialog__result" data-testid="import-result">
            <p data-testid="import-success" role="status">
              Imported. {phase.notes.length === 0
                ? "Everything resolved cleanly."
                : `${phase.notes.length} item(s) need a look:`}
            </p>
            {phase.notes.length > 0 && (
              <ul className="import-dialog__notes" data-testid="import-notes">
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
              className="import-dialog__textarea"
              data-testid="import-text"
              aria-label="Showdown paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder="Paste a Showdown export here…"
            />
            <div className="import-dialog__actions">
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
