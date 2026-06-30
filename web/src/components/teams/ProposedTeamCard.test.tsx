import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

import { createTeam, updateTeam, listTeams } from "@/lib/api/teams-client";
import type { TeamMember } from "@/data/teams/team-schema";
import type { ProposedTeam } from "@/components/types";

vi.mock("@/lib/api/teams-client", () => ({
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  listTeams: vi.fn().mockResolvedValue([]),
}));

import ProposedTeamCard from "./ProposedTeamCard";

const createMock = vi.mocked(createTeam);
const updateMock = vi.mocked(updateTeam);
const listMock = vi.mocked(listTeams);

function member(over: Partial<TeamMember>): TeamMember {
  return {
    species: "great-tusk",
    ability: "protosynthesis",
    item: "booster-energy",
    moves: ["headlong-rush", "close-combat", "ice-spinner", "rapid-spin"],
    nature: "Jolly",
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: "steel",
    level: 100,
    ...over,
  };
}

function proposed(over: Partial<ProposedTeam> = {}): ProposedTeam {
  return {
    name: "Hyper Offense",
    format: "scarlet-violet",
    members: [member({}), member({ species: "kingambit" })],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
});

describe("ProposedTeamCard", () => {
  it("renders the proposed team name and members", async () => {
    render(<ProposedTeamCard proposedTeam={proposed()} />);
    expect(screen.getByTestId("proposed-team-name")).toHaveTextContent(
      "Hyper Offense",
    );
    const members = screen.getByTestId("proposed-team-members");
    expect(members).toHaveTextContent("Great Tusk");
    expect(members).toHaveTextContent("Kingambit");
  });

  it("Save as new team calls createTeam with the proposed shape", async () => {
    createMock.mockResolvedValue({
      id: "new-1",
      name: "Hyper Offense",
      format: "scarlet-violet",
      members: [],
      validation: [],
    });
    const team = proposed();
    render(<ProposedTeamCard proposedTeam={team} />);

    fireEvent.click(screen.getByTestId("proposed-team-save-new"));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: team.name,
        format: team.format,
        members: team.members,
      }),
    );
    expect(await screen.findByTestId("proposed-team-status")).toHaveTextContent(
      "Saved as a new team",
    );
  });

  it("shows an error when the save fails (e.g. a guest gets 401 → null)", async () => {
    createMock.mockResolvedValue(null);
    render(<ProposedTeamCard proposedTeam={proposed()} />);

    fireEvent.click(screen.getByTestId("proposed-team-save-new"));

    expect(await screen.findByTestId("proposed-team-status")).toHaveTextContent(
      "Sign in to save teams",
    );
  });

  it("applies onto an existing same-format team via updateTeam", async () => {
    listMock.mockResolvedValue([
      {
        id: "existing-1",
        name: "Old Team",
        format: "scarlet-violet",
        memberCount: 6,
        incomplete: false,
        updatedAt: Date.now(),
      },
    ]);
    updateMock.mockResolvedValue({
      id: "existing-1",
      name: "Old Team",
      format: "scarlet-violet",
      members: [],
      validation: [],
    });
    const team = proposed();
    render(<ProposedTeamCard proposedTeam={team} />);

    // Same-format teams are listed for the apply-existing path.
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ format: "scarlet-violet" }),
    );
    const target = await screen.findByTestId("proposed-team-target");
    fireEvent.change(target, { target: { value: "existing-1" } });
    fireEvent.click(screen.getByTestId("proposed-team-apply-existing"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("existing-1", {
        members: team.members,
      }),
    );
    expect(await screen.findByTestId("proposed-team-status")).toHaveTextContent(
      "Applied onto",
    );
  });

  it("hides the apply-existing picker when the account has no same-format teams", async () => {
    listMock.mockResolvedValue([]);
    render(<ProposedTeamCard proposedTeam={proposed()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(screen.queryByTestId("proposed-team-apply-existing")).toBeNull();
  });

  it("renders a species_illegal legality badge when warnings are present", async () => {
    render(
      <ProposedTeamCard
        proposedTeam={proposed()}
        warnings={[
          {
            code: "species_illegal",
            message: 'Species "heatran" is not legal in this format.',
            slot: 0,
            field: "species",
          },
        ]}
      />,
    );
    const block = screen.getByTestId("proposed-team-warnings");
    expect(block).toHaveTextContent("not legal in this format");
    expect(screen.getByTestId("team-warning")).toHaveAttribute(
      "data-code",
      "species_illegal",
    );
  });

  it("renders no legality block for a clean proposal (no warnings)", async () => {
    render(<ProposedTeamCard proposedTeam={proposed()} />);
    expect(screen.queryByTestId("proposed-team-warnings")).toBeNull();
  });
});
