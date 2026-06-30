/**
 * Tests for src/lib/hooks/use-conversations.ts (chat-history Phase 5). Mocks the
 * history-client entirely so the hook's list/search/filter/mutation/refresh
 * behaviour is asserted without any network. Runs under the jsdom project.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api/history-client", () => ({
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  setPinned: vi.fn(),
  deleteConversation: vi.fn(),
}));

import {
  listConversations,
  renameConversation,
  setPinned,
  deleteConversation,
  type ConversationSummary,
} from "@/lib/api/history-client";
import { useConversations } from "@/lib/hooks/use-conversations";

const SUMMARY: ConversationSummary = {
  id: "c1",
  title: "First",
  format: "scarlet-violet",
  pinned: false,
  updatedAt: 1000,
};

beforeEach(() => {
  vi.mocked(listConversations).mockResolvedValue([SUMMARY]);
  vi.mocked(renameConversation).mockResolvedValue(true);
  vi.mocked(setPinned).mockResolvedValue(true);
  vi.mocked(deleteConversation).mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useConversations", () => {
  it("stays empty and never fetches when disabled (guest)", async () => {
    const { result } = renderHook(() => useConversations(false));
    // Give any (incorrect) effect a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.conversations).toEqual([]);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("lists on mount when enabled", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(listConversations).toHaveBeenCalledWith({ q: undefined, format: undefined });
  });

  it("debounces search then re-lists with q", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    act(() => result.current.setQuery("garchomp"));
    await waitFor(() =>
      expect(listConversations).toHaveBeenCalledWith({ q: "garchomp", format: undefined }),
    );
  });

  it("re-lists when the format filter changes", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    act(() => result.current.setFormatFilter("champions"));
    await waitFor(() =>
      expect(listConversations).toHaveBeenCalledWith({ q: undefined, format: "champions" }),
    );
  });

  it("rename updates optimistically and calls the API", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    await act(async () => {
      await result.current.rename("c1", "Renamed");
    });
    expect(renameConversation).toHaveBeenCalledWith("c1", "Renamed");
    expect(result.current.conversations[0].title).toBe("Renamed");
  });

  it("pin updates optimistically, calls the API, and refreshes", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    vi.mocked(listConversations).mockClear();

    await act(async () => {
      await result.current.pin("c1", true);
    });
    expect(setPinned).toHaveBeenCalledWith("c1", true);
    // refresh() re-lists after a pin (server owns the ordering).
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
  });

  it("remove filters the row out and calls the API", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    await act(async () => {
      await result.current.remove("c1");
    });
    expect(deleteConversation).toHaveBeenCalledWith("c1");
    expect(result.current.conversations).toEqual([]);
  });

  it("refresh re-lists", async () => {
    const { result } = renderHook(() => useConversations(true));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    vi.mocked(listConversations).mockClear();

    act(() => result.current.refresh());
    await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(1));
  });
});
