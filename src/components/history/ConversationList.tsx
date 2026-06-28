"use client";

/**
 * ConversationList — the signed-in history sidebar (chat-history Phase 6).
 *
 * A "New chat" action, a search field, a format filter, and the conversations
 * grouped pinned-first then most-recently-active (HIST-US-3, 6, 10, 11). Renders
 * a clear empty state (no conversations yet) and a distinct no-results state
 * (search/filter matched nothing). Purely presentational — all state + data come
 * from the parent (which wires the `useConversations` hook).
 */

import type { ConversationSummary } from "@/lib/history-client";
import ConversationRow from "./ConversationRow";

export interface ConversationListProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  formatFilter: string | null;
  onFormatFilterChange: (f: string | null) => void;
  onNewChat: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
}

const FILTERS: { label: string; value: string | null }[] = [
  { label: "All", value: null },
  { label: "Gen 9", value: "scarlet-violet" },
  { label: "Champions", value: "champions" },
];

export default function ConversationList({
  conversations,
  activeId,
  query,
  onQueryChange,
  formatFilter,
  onFormatFilterChange,
  onNewChat,
  onOpen,
  onRename,
  onPin,
  onDelete,
}: ConversationListProps) {
  const pinned = conversations.filter((c) => c.pinned);
  const recent = conversations.filter((c) => !c.pinned);
  const filtersActive = query.trim().length > 0 || formatFilter !== null;

  const row = (c: ConversationSummary) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      active={c.id === activeId}
      onOpen={() => onOpen(c.id)}
      onRename={(title) => onRename(c.id, title)}
      onPin={(p) => onPin(c.id, p)}
      onDelete={() => onDelete(c.id)}
    />
  );

  const heading = (text: string) => (
    <div
      style={{
        padding: "var(--space-2) var(--space-3) var(--space-1)",
        fontSize: "11px",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--text-faint)",
      }}
    >
      {text}
    </div>
  );

  return (
    <nav
      data-testid="conversation-list"
      aria-label="Conversation history"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        gap: "var(--space-3)",
        padding: "var(--space-3)",
      }}
    >
      <button
        type="button"
        className="conv-list__newchat"
        onClick={onNewChat}
        data-testid="new-chat"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-2)",
          height: "40px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--poke-red)",
          color: "var(--neutral-0)",
          font: "inherit",
          fontSize: "14px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        + New chat
      </button>

      <input
        type="search"
        className="conv-list__search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search conversations…"
        aria-label="Search conversations"
        style={{
          height: "36px",
          padding: "0 var(--space-3)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: "16px", // 16px so iOS Safari doesn't zoom on focus
        }}
      />

      <div role="group" aria-label="Filter by format" style={{ display: "inline-flex", gap: "var(--space-1)" }}>
        {FILTERS.map((f) => {
          const selected = formatFilter === f.value;
          return (
            <button
              key={f.label}
              type="button"
              className="conv-list__filter"
              onClick={() => onFormatFilterChange(f.value)}
              aria-pressed={selected}
              style={{
                flex: 1,
                height: "30px",
                borderRadius: "var(--radius-pill)",
                border: "1px solid var(--border)",
                background: selected ? "var(--surface-sunken)" : "transparent",
                color: selected ? "var(--text-strong)" : "var(--text-muted)",
                font: "inherit",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" }}>
        {conversations.length === 0 ? (
          <p
            data-testid="history-empty"
            style={{
              padding: "var(--space-4) var(--space-3)",
              color: "var(--text-faint)",
              fontSize: "13px",
              textAlign: "center",
            }}
          >
            {filtersActive
              ? "No conversations match your search."
              : "No conversations yet. Start chatting to build your history."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                {heading("Pinned")}
                {pinned.map(row)}
              </>
            )}
            {recent.length > 0 && (
              <>
                {pinned.length > 0 && heading("Recent")}
                {recent.map(row)}
              </>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
