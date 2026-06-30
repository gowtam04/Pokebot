import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import ConversationRow from "./ConversationRow";
import type { ConversationSummary } from "@/lib/api/history-client";

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "c1",
    title: "What beats Garchomp?",
    format: "scarlet-violet",
    pinned: false,
    updatedAt: Date.now(),
    ...over,
  };
}

function setup(over: Partial<ConversationSummary> = {}, props: Partial<Parameters<typeof ConversationRow>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onPin: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ConversationRow conversation={summary(over)} active={false} {...handlers} {...props} />,
  );
  return handlers;
}

describe("ConversationRow", () => {
  it("renders title, format badge, and relative time", () => {
    setup();
    expect(screen.getByText("What beats Garchomp?")).toBeInTheDocument();
    expect(screen.getByTestId("format-badge")).toHaveTextContent("Gen 9");
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("shows the Champions badge for champions conversations", () => {
    setup({ format: "champions" });
    expect(screen.getByTestId("format-badge")).toHaveTextContent("Champions");
  });

  it("opens on title click", () => {
    const h = setup();
    fireEvent.click(screen.getByTitle("What beats Garchomp?"));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  it("pins an unpinned conversation", () => {
    const h = setup({ pinned: false });
    fireEvent.click(screen.getByRole("button", { name: "Pin conversation" }));
    expect(h.onPin).toHaveBeenCalledWith(true);
  });

  it("unpins a pinned conversation", () => {
    const h = setup({ pinned: true });
    fireEvent.click(screen.getByRole("button", { name: "Unpin conversation" }));
    expect(h.onPin).toHaveBeenCalledWith(false);
  });

  it("renames inline on Enter", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    const input = screen.getByRole("textbox", { name: "Conversation title" });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).toHaveBeenCalledWith("New name");
  });

  it("cancels rename on Escape (no callback, reverts)", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    const input = screen.getByRole("textbox", { name: "Conversation title" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.onRename).not.toHaveBeenCalled();
    expect(screen.getByText("What beats Garchomp?")).toBeInTheDocument();
  });

  it("requires a confirm step before deleting (AC-8.1)", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
    // Not deleted until confirmed.
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("can cancel the delete confirm", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel delete" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    // Back to the normal actions.
    expect(screen.getByRole("button", { name: "Delete conversation" })).toBeInTheDocument();
  });

  it("marks the active row", () => {
    const h = {
      onOpen: vi.fn(),
      onRename: vi.fn(),
      onPin: vi.fn(),
      onDelete: vi.fn(),
    };
    render(<ConversationRow conversation={summary()} active {...h} />);
    expect(screen.getByTestId("conversation-row")).toHaveAttribute("data-active");
  });
});
