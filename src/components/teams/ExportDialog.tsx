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
      style={backdropStyle}
    >
      <div
        className="export-dialog"
        data-testid="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Export team"
        onClick={(e) => e.stopPropagation()}
        style={dialogStyle}
      >
        <div style={headerStyle}>
          <h2 style={titleStyle}>
            Export {teamName ? `“${teamName}”` : "team"}
          </h2>
          <button
            type="button"
            data-testid="export-close"
            aria-label="Close export"
            onClick={onClose}
            style={closeButtonStyle}
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
              data-testid="export-text"
              readOnly
              value={paste}
              rows={12}
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontFamily: "var(--font-mono)",
                font: "400 13px/1.5 var(--font-mono)",
              }}
            />
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
