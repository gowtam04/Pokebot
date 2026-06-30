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

import type { ConversationSummary } from "@/lib/api/history-client";
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
    <div className="conv-list__heading">{text}</div>
  );

  return (
    <nav
      className="conv-list"
      data-testid="conversation-list"
      aria-label="Conversation history"
    >
      <button
        type="button"
        className="conv-list__newchat"
        onClick={onNewChat}
        data-testid="new-chat"
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
      />

      <div role="group" aria-label="Filter by format" className="conv-list__filters">
        {FILTERS.map((f) => {
          const selected = formatFilter === f.value;
          return (
            <button
              key={f.label}
              type="button"
              className="conv-list__filter"
              onClick={() => onFormatFilterChange(f.value)}
              aria-pressed={selected}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="conv-list__scroll">
        {conversations.length === 0 ? (
          <p data-testid="history-empty" className="conv-list__empty">
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
