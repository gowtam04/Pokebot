import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

import ChampionsItemsView, {
  type ChampionsItemsViewProps,
} from "./ChampionsItemsView";
import type { AdminChampionsItem } from "@/lib/admin/admin-types";

// Fixtures — the GET /api/admin/champions-items projection. Components render
// fixtures only; no db/repos imported (admin component-test rule).
const ITEMS: AdminChampionsItem[] = [
  { slug: "assault-vest", displayName: "Assault Vest", available: false },
  { slug: "choice-band", displayName: "Choice Band", available: true },
  { slug: "leftovers", displayName: "Leftovers", available: true },
];

function renderView(overrides: Partial<ChampionsItemsViewProps> = {}) {
  const props: ChampionsItemsViewProps = {
    items: ITEMS,
    query: "",
    onQueryChange: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
  render(<ChampionsItemsView {...props} />);
  return props;
}

describe("ChampionsItemsView", () => {
  it("renders the title, intro, grid, and a checkbox per item", () => {
    renderView();
    expect(screen.getByTestId("champions-items-view")).toBeInTheDocument();
    expect(screen.getByText("Champions items")).toBeInTheDocument();
    expect(screen.getByTestId("champions-items-intro")).toBeInTheDocument();
    expect(screen.getByTestId("champions-items-grid")).toBeInTheDocument();
    expect(screen.getByTestId("champions-item-assault-vest")).toBeInTheDocument();
    expect(screen.getByTestId("champions-item-leftovers")).toBeInTheDocument();
  });

  it("reflects availability in the checkbox checked state", () => {
    renderView();
    expect(
      (screen.getByTestId("champions-item-assault-vest") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("champions-item-leftovers") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("summarizes available / unavailable / total counts", () => {
    renderView();
    expect(screen.getByTestId("champions-items-summary")).toHaveTextContent(
      "2 available · 1 unavailable · 3 total",
    );
  });

  it("emits (slug, nextAvailable) when a checkbox is toggled", () => {
    const props = renderView();
    // Uncheck an available item → onToggle(slug, false).
    fireEvent.click(screen.getByTestId("champions-item-leftovers"));
    expect(props.onToggle).toHaveBeenCalledWith("leftovers", false);
    // Re-check an unavailable item → onToggle(slug, true).
    fireEvent.click(screen.getByTestId("champions-item-assault-vest"));
    expect(props.onToggle).toHaveBeenCalledWith("assault-vest", true);
  });

  it("filters the visible items by the query (name or slug)", () => {
    renderView({ query: "choice" });
    expect(screen.getByTestId("champions-item-choice-band")).toBeInTheDocument();
    expect(screen.queryByTestId("champions-item-leftovers")).not.toBeInTheDocument();
  });

  it("disables a checkbox while its toggle is pending", () => {
    renderView({ pending: new Set(["choice-band"]) });
    expect(
      (screen.getByTestId("champions-item-choice-band") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("champions-item-leftovers") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("shows an error message when one is provided", () => {
    renderView({ error: "Failed to save that change — reverted." });
    expect(screen.getByTestId("champions-items-error")).toHaveTextContent(
      "Failed to save that change — reverted.",
    );
  });

  it("fires onSelectAll / onDeselectAll from the bulk buttons", () => {
    const onSelectAll = vi.fn();
    const onDeselectAll = vi.fn();
    renderView({ onSelectAll, onDeselectAll });
    fireEvent.click(screen.getByTestId("champions-items-deselect-all"));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("champions-items-select-all"));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("disables both bulk buttons while a bulk action is pending", () => {
    renderView({ bulkPending: true });
    expect(
      (screen.getByTestId("champions-items-select-all") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("champions-items-deselect-all") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
