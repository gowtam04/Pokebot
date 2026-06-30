/**
 * use-conversations — list-state hook for the history sidebar
 * (docs/features/chat-history § Interface Definitions, Phase 5).
 *
 * Owns the conversation list, the debounced search query, the format filter, and
 * the optimistic rename/pin/delete mutations. When `enabled` is false (a guest)
 * it stays empty and never fetches (AC-1.3). All network calls go through the
 * never-throwing history-client, so the hook itself has no error path.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import {
  deleteConversation as apiDelete,
  listConversations,
  renameConversation as apiRename,
  setPinned as apiSetPinned,
  type ConversationSummary,
} from "@/lib/api/history-client";

/** Debounce (ms) before a typed search query triggers a re-list. */
const SEARCH_DEBOUNCE_MS = 200;

export interface UseConversationsResult {
  conversations: ConversationSummary[];
  query: string;
  setQuery: (q: string) => void;
  formatFilter: string | null;
  setFormatFilter: (f: string | null) => void;
  /** Re-list now (call after a completed signed-in turn). */
  refresh: () => void;
  rename: (id: string, title: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** False for guests → list stays empty, no fetch. */
  enabled: boolean;
}

export function useConversations(enabled: boolean): UseConversationsResult {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Debounce the search query so each keystroke does not hit the API.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Fetch the list when enabled / the (debounced) query / the format filter /
  // an explicit refresh changes. Guests stay empty and make no request.
  useEffect(() => {
    if (!enabled) {
      setConversations([]);
      return;
    }
    let active = true;
    void listConversations({
      q: debouncedQuery || undefined,
      format: formatFilter || undefined,
    }).then((list) => {
      if (active) setConversations(list);
    });
    return () => {
      active = false;
    };
  }, [enabled, debouncedQuery, formatFilter, refreshTick]);

  const rename = useCallback(
    async (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      const ok = await apiRename(id, title);
      if (!ok) refresh(); // revert to server state on failure
    },
    [refresh],
  );

  const pin = useCallback(
    async (id: string, pinned: boolean) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, pinned } : c)),
      );
      await apiSetPinned(id, pinned);
      refresh(); // re-sort (pinned group ordering is the server's call)
    },
    [refresh],
  );

  const remove = useCallback(async (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    await apiDelete(id);
  }, []);

  return {
    conversations,
    query,
    setQuery,
    formatFilter,
    setFormatFilter,
    refresh,
    rename,
    pin,
    remove,
    enabled,
  };
}
