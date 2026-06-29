/**
 * ExportDialog — shows a team as a copyable Showdown paste (TEAM-US-11, AC).
 *
 * Pure presentational over a `paste` string the page fetches via the teams-client
 * (`exportPaste`, which never throws). While the fetch is in flight `loading` is
 * true; a `null` paste after loading means the export failed (not owned /
 * transport) — surfaced as an inline message, never a thrown error. The text sits
 * in a read-only textarea plus a Copy button that uses the async clipboard API
 * when available and falls back to selecting the text otherwise.
 */

"use client";

import { useRef, useState } from "react";

export interface ExportDialogProps {
  open: boolean;
  /** The Showdown paste, or `null` while loading / on failure. */
  paste: string | null;
  /** True while the export request is in flight. */
  loading?: boolean;
  /** Team name for the dialog heading. */
  teamName?: string;
  onClose: () => void;
}

export default function ExportDialog({
  open,
  paste,
  loading = false,
  teamName,
  onClose,
}: ExportDialogProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  async function copy() {
    if (!paste) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(paste);
      } else {
        textRef.current?.select();
        document.execCommand?.("copy");
      }
      setCopied(true);
    } catch {
      // Clipboard blocked — leave the text selectable so the user can copy it.
      textRef.current?.select();
    }
  }

  return (
    <div
      className="export-dialog__backdrop"
      data-testid="export-dialog-backdrop"
      onClick={onClose}
    >
      <div
        className="export-dialog"
        data-testid="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Export team"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export-dialog__header">
          <h2 className="export-dialog__title">
            Export {teamName ? `“${teamName}”` : "team"}
          </h2>
          <button
            type="button"
            className="export-dialog__close"
            data-testid="export-close"
            aria-label="Close export"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {loading ? (
          <p data-testid="export-loading">Generating paste…</p>
        ) : paste === null ? (
          <p data-testid="export-error" role="alert">
            Couldn&apos;t export this team. Please try again.
          </p>
        ) : (
          <>
            <textarea
              ref={textRef}
              className="export-dialog__text"
              data-testid="export-text"
              readOnly
              value={paste}
              rows={12}
            />
            <div className="export-dialog__actions">
              <button type="button" data-testid="export-copy" onClick={copy}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
