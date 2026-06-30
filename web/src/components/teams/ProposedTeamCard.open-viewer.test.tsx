import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import type { ArtifactViewerApi } from "@/components/artifact/types";
import type { ProposedTeam } from "@/components/types";
import type { TeamMember } from "@/data/teams/team-schema";

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

// The card lists same-format teams on mount; stub the never-throwing client.
vi.mock("@/lib/api/teams-client", () => ({
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  listTeams: vi.fn().mockResolvedValue([]),
}));

import ProposedTeamCard from "./ProposedTeamCard";

const MEMBER: TeamMember = {
  species: "pelipper",
  ability: "drizzle",
  item: null,
  moves: ["hurricane"],
  nature: null,
  evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: null,
  level: 50,
};

const TEAM: ProposedTeam = {
  name: "Rain",
  format: "champions",
  members: [MEMBER],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProposedTeamCard — Open in viewer", () => {
  it("opens the proposed team INLINE in the viewer (no fetch)", () => {
    render(<ProposedTeamCard proposedTeam={TEAM} />);
    fireEvent.click(screen.getByTestId("proposed-team-open-viewer"));
    // The proposal's server-stamped legality warnings ride along so the viewer
    // can flag an illegal member; none here ⇒ an empty array.
    expect(openTeam).toHaveBeenCalledWith({
      team: { name: "Rain", format: "champions", members: TEAM.members },
      validation: [],
    });
  });
});
