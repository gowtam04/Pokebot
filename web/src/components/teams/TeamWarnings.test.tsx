import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import TeamWarnings from "./TeamWarnings";
import type { TeamWarning } from "@/lib/api/teams-client";

afterEach(() => cleanup());

const WARNINGS: TeamWarning[] = [
  { code: "incomplete", message: "Slot 1 has fewer than 4 moves.", slot: 0 },
  { code: "duplicate_species", message: "Two Garchomp (species clause)." },
];

describe("TeamWarnings", () => {
  it("renders nothing for a clean (empty) list", () => {
    const { container } = render(<TeamWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one item per warning with its message", () => {
    render(<TeamWarnings warnings={WARNINGS} />);
    const items = screen.getAllByTestId("team-warning");
    expect(items).toHaveLength(2);
    expect(screen.getByText(/fewer than 4 moves/)).toBeInTheDocument();
    expect(screen.getByText(/species clause/)).toBeInTheDocument();
  });

  it("tags each item with its warning code", () => {
    render(<TeamWarnings warnings={WARNINGS} />);
    const items = screen.getAllByTestId("team-warning");
    expect(items[0]).toHaveAttribute("data-code", "incomplete");
    expect(items[1]).toHaveAttribute("data-code", "duplicate_species");
  });

  it("shows an optional title", () => {
    render(<TeamWarnings warnings={WARNINGS} title="Team legality" />);
    expect(screen.getByText("Team legality")).toBeInTheDocument();
  });

  it("honors a custom test id", () => {
    render(<TeamWarnings warnings={WARNINGS} testid="my-warnings" />);
    expect(screen.getByTestId("my-warnings")).toBeInTheDocument();
  });
});
