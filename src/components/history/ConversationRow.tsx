"use client";

/**
 * ConversationRow — one row in the history sidebar (chat-history Phase 6).
 *
 * Shows the conversation's title, a format badge, and a relative last-activity
 * time, plus unobtrusive per-row actions: pin/unpin, inline rename, and delete
 * (with a confirm step the row owns — AC-8.1). Stateless apart from the local
 * rename-edit and delete-confirm UI; the parent owns the data + persistence.
 *
 * Inline styles + design tokens, matching ChampionsToggle / the chat shell.
 */

import { useEffect, useRef, useState } from "react";

import type { ConversationSummary } from "@/lib/history-client";

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

  const iconBtn = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    font: "inherit",
    fontSize: "13px",
  } as const;

  return (
    <div
      data-testid="conversation-row"
      data-active={active || undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--surface-sunken)" : "transparent",
        border: active ? "1px solid var(--border)" : "1px solid transparent",
      }}
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
          style={{
            flex: 1,
            minWidth: 0,
            font: "inherit",
            fontSize: "16px", // 16px so iOS Safari doesn't zoom on focus
            padding: "var(--space-1) var(--space-2)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-strong)",
            background: "var(--surface)",
            color: "var(--text)",
          }}
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          title={conversation.title}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "2px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            font: "inherit",
            textAlign: "left",
            padding: 0,
            color: "var(--text)",
          }}
        >
          <span
            style={{
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "14px",
              fontWeight: active ? 600 : 500,
              color: "var(--text-strong)",
            }}
          >
            {conversation.title}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "12px",
              color: "var(--text-faint)",
            }}
          >
            <span
              data-testid="format-badge"
              style={{
                padding: "0 6px",
                borderRadius: "var(--radius-pill)",
                background: "var(--surface-sunken)",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontWeight: 600,
              }}
            >
              {formatLabel(conversation.format)}
            </span>
            <span>{relativeTime(conversation.updatedAt)}</span>
          </span>
        </button>
      )}

      {!editing && (
        <div
          className="conv-row__actions"
          style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}
        >
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
                aria-label="Confirm delete"
                style={{ ...iconBtn, width: "auto", paddingInline: "8px", color: "var(--danger)", fontWeight: 600 }}
              >
                Delete?
              </button>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => setConfirmingDelete(false)}
                aria-label="Cancel delete"
                style={{ ...iconBtn, width: "auto", paddingInline: "8px" }}
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
                style={{
                  ...iconBtn,
                  color: conversation.pinned ? "var(--poke-red)" : "var(--text-muted)",
                }}
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
                style={iconBtn}
              >
                ✎
              </button>
              <button
                type="button"
                className="conv-row__icon-btn"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete conversation"
                title="Delete"
                style={iconBtn}
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
