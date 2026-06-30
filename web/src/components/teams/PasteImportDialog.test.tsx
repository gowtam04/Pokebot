import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

import PasteImportDialog from "./PasteImportDialog";
import type { ImportNote, TeamDetail } from "@/lib/api/teams-client";

afterEach(() => cleanup());

const TEAM: TeamDetail = {
  id: "new1",
  name: "Imported",
  format: "scarlet-violet",
  members: [],
  validation: [],
};

const NOTES: ImportNote[] = [
  {
    slot: 0,
    kind: "pokemon",
    raw: "Garchompp",
    message: "Couldn't resolve “Garchompp”.",
  },
];

describe("PasteImportDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <PasteImportDialog
        open={false}
        format="scarlet-violet"
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables Import until the textarea has content", () => {
    render(
      <PasteImportDialog
        open
        format="scarlet-violet"
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(screen.getByTestId("import-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: "Garchomp @ Life Orb" },
    });
    expect(screen.getByTestId("import-submit")).not.toBeDisabled();
  });

  it("imports and shows the resolve-or-clarify notes", async () => {
    const onImport = vi
      .fn()
      .mockResolvedValue({ team: TEAM, notes: NOTES });
    const onImported = vi.fn();
    render(
      <PasteImportDialog
        open
        format="scarlet-violet"
        onClose={vi.fn()}
        onImport={onImport}
        onImported={onImported}
      />,
    );
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: "Garchompp @ Life Orb" },
    });
    fireEvent.click(screen.getByTestId("import-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("import-result")).toBeInTheDocument(),
    );
    expect(onImport).toHaveBeenCalledWith(
      "scarlet-violet",
      "Garchompp @ Life Orb",
    );
    expect(onImported).toHaveBeenCalledWith(TEAM);
    const notes = screen.getAllByTestId("import-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(/Couldn't resolve/);
  });

  it("reports a clean import with no notes", async () => {
    render(
      <PasteImportDialog
        open
        format="scarlet-violet"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue({ team: TEAM, notes: [] })}
      />,
    );
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: "paste" },
    });
    fireEvent.click(screen.getByTestId("import-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("import-success")).toHaveTextContent(
        /resolved cleanly/,
      ),
    );
    expect(screen.queryByTestId("import-notes")).not.toBeInTheDocument();
  });

  it("surfaces a failure inline when import returns null", async () => {
    render(
      <PasteImportDialog
        open
        format="scarlet-violet"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(null)}
      />,
    );
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: "paste" },
    });
    fireEvent.click(screen.getByTestId("import-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("import-error")).toBeInTheDocument(),
    );
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(
      <PasteImportDialog
        open
        format="scarlet-violet"
        onClose={onClose}
        onImport={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("import-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
