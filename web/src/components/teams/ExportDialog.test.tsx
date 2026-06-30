import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

import ExportDialog from "./ExportDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PASTE = "Garchomp @ Life Orb\nAbility: Rough Skin\n- Earthquake";

describe("ExportDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ExportDialog open={false} paste={PASTE} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the paste in a read-only textarea", () => {
    render(<ExportDialog open paste={PASTE} onClose={vi.fn()} />);
    const text = screen.getByTestId("export-text");
    expect(text).toHaveValue(PASTE);
    expect(text).toHaveAttribute("readOnly");
  });

  it("shows a loading state while the paste is null + loading", () => {
    render(<ExportDialog open paste={null} loading onClose={vi.fn()} />);
    expect(screen.getByTestId("export-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("export-text")).not.toBeInTheDocument();
  });

  it("shows an error when the paste is null and not loading", () => {
    render(<ExportDialog open paste={null} onClose={vi.fn()} />);
    expect(screen.getByTestId("export-error")).toBeInTheDocument();
  });

  it("copies the paste via the clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ExportDialog open paste={PASTE} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("export-copy"));
    expect(writeText).toHaveBeenCalledWith(PASTE);
    await waitFor(() =>
      expect(screen.getByTestId("export-copy")).toHaveTextContent("Copied!"),
    );
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(<ExportDialog open paste={PASTE} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("export-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the team name in the heading", () => {
    render(
      <ExportDialog open paste={PASTE} teamName="Rain" onClose={vi.fn()} />,
    );
    expect(screen.getByText(/Rain/)).toBeInTheDocument();
  });
});
