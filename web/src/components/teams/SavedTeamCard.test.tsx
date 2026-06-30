import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import type { ArtifactViewerApi } from "@/components/artifact/types";

const { openTeam } = vi.hoisted(() => ({ openTeam: vi.fn() }));

vi.mock("@/components/artifact/useArtifactViewer", () => ({
  useArtifactViewer: (): ArtifactViewerApi => ({
    openTeam,
    openEntity: () => {},
    openStructured: () => {},
    back: () => {},
    close: () => {},
    askInChat: () => {},
    isOpen: false,
    current: null,
    canGoBack: false,
  }),
}));

import SavedTeamCard from "./SavedTeamCard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SavedTeamCard", () => {
  it("renders the saved name + format badge", () => {
    render(
      <SavedTeamCard
        savedTeam={{ id: "t1", name: "Rain Offense", format: "champions" }}
      />,
    );
    expect(screen.getByTestId("saved-team-label")).toHaveTextContent(
      "Rain Offense",
    );
    expect(screen.getByTestId("saved-team-format")).toHaveTextContent(
      "Champions",
    );
  });

  it("opens the saved team in the viewer BY ID (re-fetched, works after reload)", () => {
    render(
      <SavedTeamCard
        savedTeam={{ id: "t1", name: "Rain Offense", format: "champions" }}
      />,
    );
    fireEvent.click(screen.getByTestId("saved-team-open-viewer"));
    expect(openTeam).toHaveBeenCalledWith({ teamId: "t1", name: "Rain Offense" });
  });
});
