"use client";

/**
 * ConversationRow — one row in the history sidebar (chat-history Phase 6).
 *
 * Shows the conversation's title, a format badge, and a relative last-activity
 * time, plus unobtrusive per-row actions: pin/unpin, inline rename, and delete
 * (with a confirm step the row owns — AC-8.1). Stateless apart from the local
 * rename-edit and delete-confirm UI; the parent owns the data + persistence.
 *
 * Styling lives in `globals.css` (`.conv-row*`); the active look is driven off
 * the `data-active` attribute and the pin look off `aria-pressed`.
 */

import { useEffect, useRef, useState } from "react";

import type { ConversationSummary } from "@/lib/api/history-client";

export interface ConversationRowProps {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
}

/** Short, user-facing label for a stored format. */
function formatLabel(format: string): string {
  return format === "champions" ? "Champions" : "Gen 9";
}

/** Compact relative time, e.g. "just now", "5m", "3h", "2d", else a date. */
function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(epochMs).toLocaleDateString();
}

export default function ConversationRow({
  conversation,
  active,
  onOpen,
  onRename,
  onPin,
  onDelete,
}: ConversationRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitRename(): void {
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== conversation.title) onRename(next);
    else setDraft(conversation.title);
  }

  return (
    <div
      className="conv-row"
      data-testid="conversation-row"
      data-active={active || undefined}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="Conversation title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              setDraft(conversation.title);
              setEditing(false);
            }
          }}
          className="conv-row__rename"
        />
      ) : (
        <button
          type="button"
          className="conv-row__open"
          onClick={onOpen}
          title={conversation.title}
        >
          <span className="conv-row__title">{conversation.title}</span>
          <span className="conv-row__meta">
            <span data-testid="format-badge" className="conv-row__badge">
              {formatLabel(conversation.format)}
            </span>
            <span>{relativeTime(conversation.updatedAt)}</span>
          </span>
        </button>
      )}

      {!editing && (
        <div className="conv-row__actions">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="conv-row__icon-btn conv-row__icon-btn--wide conv-row__icon-btn--danger"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
                aria-label="Confirm delete"
              >
                Delete?
              </button>
              <button
                type="button"
                className="conv-row__icon-btn conv-row__icon-btn--wide"
                onClick={() => setConfirmingDelete(false)}
                aria-label="Cancel delete"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => onPin(!conversation.pinned)}
                aria-label={conversation.pinned ? "Unpin conversation" : "Pin conversation"}
                aria-pressed={conversation.pinned}
                title={conversation.pinned ? "Unpin" : "Pin"}
              >
                {conversation.pinned ? "★" : "☆"}
              </button>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => {
                  setDraft(conversation.title);
                  setEditing(true);
                }}
                aria-label="Rename conversation"
                title="Rename"
              >
                ✎
              </button>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete conversation"
                title="Delete"
              >
                🗑
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
