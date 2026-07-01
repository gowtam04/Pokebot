import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

import ConversationsBrowser, {
  type ConversationsBrowserProps,
} from "./ConversationsBrowser";
import type { ConversationSummary } from "@/lib/admin/admin-types";

// ---------------------------------------------------------------------------
// Fixtures — ConversationSummary rows (the GET /api/admin/conversations
// projection). Components render fixtures only; no db/repos imported (admin
// component-test rule).
// ---------------------------------------------------------------------------

const SIGNED_CONVO: ConversationSummary = {
  id: "c-1",
  accountId: "a-1",
  accountEmail: "trainer@example.com",
  title: "Garchomp moveset help",
  format: "scarlet-violet",
  messageCount: 6,
  createdAt: 1_700_000_100_000,
  updatedAt: 1_700_000_300_000,
};

const CHAMPIONS_CONVO: ConversationSummary = {
  id: "c-2",
  accountId: "a-2",
  accountEmail: null, // email not joined → falls back to accountId
  title: "",
  format: "champions",
  messageCount: 2,
  createdAt: 1_700_000_050_000,
  updatedAt: 1_700_000_080_000,
};

const GUEST_CONVO: ConversationSummary = {
  id: "c-3",
  accountId: null, // guest session — synthesized from turn_record, no real row
  accountEmail: null,
  title: "Type chart for Ground?",
  format: "scarlet-violet",
  messageCount: 4,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
};

const ROWS = [SIGNED_CONVO, CHAMPIONS_CONVO];

function renderBrowser(overrides: Partial<ConversationsBrowserProps> = {}) {
  const props: ConversationsBrowserProps = {
    filter: {},
    onFilterChange: vi.fn(),
    rows: ROWS,
    ...overrides,
  };
  render(<ConversationsBrowser {...props} />);
  return props;
}

describe("ConversationsBrowser", () => {
  it("renders the Conversations title, the filter controls, and the table", () => {
    renderBrowser();
    expect(screen.getByTestId("conversations-browser")).toBeInTheDocument();
    expect(screen.getByText("Conversations")).toBeInTheDocument();
    expect(screen.getByTestId("conversations-filter")).toBeInTheDocument();
    expect(screen.getByTestId("conversations-search")).toBeInTheDocument();
    expect(screen.getByTestId("conversations-format")).toBeInTheDocument();
    expect(screen.getByTestId("admin-data-table")).toBeInTheDocument();
  });

  it("renders a row per conversation with the owning account (cross-account)", () => {
    renderBrowser();
    expect(screen.getByTestId("admin-row-c-1")).toBeInTheDocument();
    expect(screen.getByTestId("admin-row-c-2")).toBeInTheDocument();
    expect(screen.getByTestId("admin-cell-c-1-account")).toHaveTextContent(
      "trainer@example.com",
    );
    // email not joined → falls back to the account id (still cross-account).
    expect(screen.getByTestId("admin-cell-c-2-account")).toHaveTextContent("a-2");
  });

  it("shows a human-readable format label and the message count", () => {
    renderBrowser();
    expect(screen.getByTestId("admin-cell-c-1-format")).toHaveTextContent(
      "Scarlet/Violet",
    );
    expect(screen.getByTestId("admin-cell-c-2-format")).toHaveTextContent(
      "Champions",
    );
    expect(screen.getByTestId("admin-cell-c-1-messages")).toHaveTextContent("6");
  });

  it("shows a Guest label for a synthesized guest-session row (accountId: null)", () => {
    renderBrowser({ rows: [...ROWS, GUEST_CONVO] });
    expect(screen.getByTestId("admin-cell-c-3-account")).toHaveTextContent(
      "Guest",
    );
  });

  it("falls back to a placeholder title for an untitled conversation", () => {
    renderBrowser();
    expect(screen.getByTestId("admin-cell-c-2-title")).toHaveTextContent(
      "Untitled conversation",
    );
  });

  it("emits the next filter with q when the search input changes (ADMIN-AC-9.1)", () => {
    const onFilterChange = vi.fn();
    renderBrowser({ filter: {}, onFilterChange });
    fireEvent.change(screen.getByTestId("conversations-search"), {
      target: { value: "garchomp" },
    });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange.mock.calls[0][0]).toEqual({ q: "garchomp" });
  });

  it("emits the next filter with format when the format select changes", () => {
    const onFilterChange = vi.fn();
    renderBrowser({ filter: {}, onFilterChange });
    fireEvent.change(screen.getByTestId("conversations-format"), {
      target: { value: "champions" },
    });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange.mock.calls[0][0]).toEqual({ format: "champions" });
  });

  it("drops a dimension when its control is cleared", () => {
    const onFilterChange = vi.fn();
    renderBrowser({ filter: { q: "garchomp", format: "champions" }, onFilterChange });
    fireEvent.change(screen.getByTestId("conversations-search"), {
      target: { value: "" },
    });
    expect(onFilterChange.mock.calls[0][0]).toEqual({ format: "champions" });
  });

  it("shows a Clear control only when a filter is active and resets all dimensions", () => {
    const onFilterChange = vi.fn();
    const { rerender } = render(
      <ConversationsBrowser
        filter={{}}
        onFilterChange={onFilterChange}
        rows={ROWS}
      />,
    );
    expect(screen.queryByTestId("conversations-clear")).not.toBeInTheDocument();
    rerender(
      <ConversationsBrowser
        filter={{ q: "garchomp" }}
        onFilterChange={onFilterChange}
        rows={ROWS}
      />,
    );
    fireEvent.click(screen.getByTestId("conversations-clear"));
    expect(onFilterChange).toHaveBeenCalledWith({});
  });

  it("calls onRowClick with the conversation when a row is clicked (read-only drill-down)", () => {
    const onRowClick = vi.fn();
    renderBrowser({ onRowClick });
    fireEvent.click(screen.getByTestId("admin-row-c-1"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0][0]).toMatchObject({ id: "c-1" });
  });

  it("surfaces a Load more affordance and invokes onLoadMore (keyset pagination)", () => {
    const onLoadMore = vi.fn();
    renderBrowser({ hasMore: true, onLoadMore });
    fireEvent.click(screen.getByTestId("admin-table-load-more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when there is no further page", () => {
    renderBrowser({ hasMore: false });
    expect(
      screen.queryByTestId("admin-table-load-more"),
    ).not.toBeInTheDocument();
  });

  it("shows a loading empty-state while the first page loads", () => {
    renderBrowser({ rows: [], loading: true });
    expect(screen.getByTestId("admin-table-empty")).toHaveTextContent(
      "Loading conversations…",
    );
  });

  it("shows the no-match empty-state when there are no rows and not loading", () => {
    renderBrowser({ rows: [], loading: false });
    expect(screen.getByTestId("admin-table-empty")).toHaveTextContent(
      "No conversations match this search.",
    );
  });

  it("renders an error banner when an error is present", () => {
    renderBrowser({ rows: [], error: "Failed to load conversations." });
    const banner = screen.getByTestId("conversations-browser-error");
    expect(banner).toHaveTextContent("Failed to load conversations.");
    expect(banner).toHaveAttribute("role", "alert");
  });

  it("exposes NO mutating controls — read-only (ADMIN-BR-2 / ADMIN-AC-9.3)", () => {
    renderBrowser();
    // The only interactive controls are query refinement (search/format/clear),
    // column sort, load-more, and a read-only row click. Nothing deletes, edits,
    // redacts, or flags a conversation.
    expect(
      screen.queryByRole("button", { name: /delete|remove|edit|redact|flag/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/delete|redact|flag/i)).not.toBeInTheDocument();
  });
});
