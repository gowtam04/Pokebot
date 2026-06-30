import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import TeamList from "./TeamList";
import type { TeamSummary } from "@/lib/api/teams-client";

afterEach(() => cleanup());

const TEAMS: TeamSummary[] = [
  {
    id: "t1",
    name: "Rain Offense",
    format: "scarlet-violet",
    memberCount: 6,
    incomplete: false,
    updatedAt: 2,
  },
  {
    id: "t2",
    name: "Draft WIP",
    format: "scarlet-violet",
    memberCount: 3,
    incomplete: true,
    updatedAt: 1,
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof TeamList>> = {}) {
  const props = {
    teams: TEAMS,
    selectedId: null as string | null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onImport: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<TeamList {...props} />);
  return props;
}

describe("TeamList", () => {
  it("shows an empty state when there are no teams", () => {
    setup({ teams: [] });
    expect(screen.getByTestId("team-list-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("team-list-items")).not.toBeInTheDocument();
  });

  it("renders a row per team with name, format and member count", () => {
    setup();
    expect(screen.getByText("Rain Offense")).toBeInTheDocument();
    expect(screen.getByText(/scarlet-violet · 6\/6/)).toBeInTheDocument();
  });

  it("flags incomplete teams", () => {
    setup();
    expect(screen.getByTestId("team-incomplete-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("team-incomplete-t1")).not.toBeInTheDocument();
  });

  it("calls onNew / onImport", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("team-new"));
    fireEvent.click(screen.getByTestId("team-import"));
    expect(props.onNew).toHaveBeenCalledOnce();
    expect(props.onImport).toHaveBeenCalledOnce();
  });

  it("selects a team when its name is clicked", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("team-open-t1"));
    expect(props.onSelect).toHaveBeenCalledWith("t1");
  });

  it("duplicates a team", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("team-duplicate-t2"));
    expect(props.onDuplicate).toHaveBeenCalledWith("t2");
  });

  it("requires a two-step confirm before deleting", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("team-delete-t1"));
    // Nothing deleted yet — only the confirm controls appear.
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("team-delete-confirm-t1"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("team-delete-confirm-t1"));
    expect(props.onDelete).toHaveBeenCalledWith("t1");
  });

  it("can cancel a pending delete", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("team-delete-t1"));
    fireEvent.click(screen.getByTestId("team-delete-cancel-t1"));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId("team-delete-t1")).toBeInTheDocument();
  });

  it("marks the selected row", () => {
    setup({ selectedId: "t1" });
    expect(screen.getByTestId("team-row-t1")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("team-row-t2")).toHaveAttribute(
      "data-selected",
      "false",
    );
  });
});
