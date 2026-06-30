import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

afterEach(() => cleanup());
import ConversationList from "./ConversationList";
import type { ConversationSummary } from "@/lib/api/history-client";

function summary(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: "c",
    title: "t",
    format: "scarlet-violet",
    pinned: false,
    updatedAt: Date.now(),
    ...over,
  };
}

function setup(
  conversations: ConversationSummary[],
  props: Partial<Parameters<typeof ConversationList>[0]> = {},
) {
  const handlers = {
    onQueryChange: vi.fn(),
    onFormatFilterChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onPin: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ConversationList
      conversations={conversations}
      activeId={null}
      query=""
      formatFilter={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("ConversationList", () => {
  it("fires onNewChat", () => {
    const h = setup([]);
    fireEvent.click(screen.getByTestId("new-chat"));
    expect(h.onNewChat).toHaveBeenCalled();
  });

  it("forwards search input to onQueryChange", () => {
    const h = setup([]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversations" }), {
      target: { value: "garchomp" },
    });
    expect(h.onQueryChange).toHaveBeenCalledWith("garchomp");
  });

  it("forwards format filter clicks", () => {
    const h = setup([]);
    fireEvent.click(screen.getByRole("button", { name: "Champions" }));
    expect(h.onFormatFilterChange).toHaveBeenCalledWith("champions");
  });

  it("shows the empty state when there are no conversations and no filter", () => {
    setup([]);
    expect(screen.getByTestId("history-empty")).toHaveTextContent(
      "No conversations yet",
    );
  });

  it("shows a no-results state when a search matches nothing", () => {
    setup([], { query: "zzz" });
    expect(screen.getByTestId("history-empty")).toHaveTextContent(
      "No conversations match",
    );
  });

  it("groups pinned above recent with headings", () => {
    setup([
      summary({ id: "p", title: "Pinned one", pinned: true }),
      summary({ id: "r", title: "Recent one", pinned: false }),
    ]);
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Pinned one")).toBeInTheDocument();
    expect(screen.getByText("Recent one")).toBeInTheDocument();
  });

  it("renders a format badge per row and highlights the active row", () => {
    setup(
      [
        summary({ id: "a", title: "Alpha", format: "champions" }),
        summary({ id: "b", title: "Beta" }),
      ],
      { activeId: "b" },
    );
    expect(screen.getAllByTestId("format-badge")).toHaveLength(2);
    const rows = screen.getAllByTestId("conversation-row");
    const active = rows.find((r) => r.hasAttribute("data-active"));
    expect(active && within(active).getByText("Beta")).toBeTruthy();
  });

  it("delegates row open with the conversation id", () => {
    const h = setup([summary({ id: "abc", title: "Openable" })]);
    fireEvent.click(screen.getByTitle("Openable"));
    expect(h.onOpen).toHaveBeenCalledWith("abc");
  });
});
