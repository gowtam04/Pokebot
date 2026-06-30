import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import TeamArtifact from "./TeamArtifact";
import type { TeamArtifactView } from "./types";
import type { TeamMember } from "@/data/teams/team-schema";

const MEMBER: TeamMember = {
  species: "pelipper",
  ability: "drizzle",
  item: "damp-rock",
  moves: ["hurricane", "hydro-pump"],
  nature: "modest",
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "water",
  level: 50,
};

/** Sprite/type/base-stat refs as the provider would resolve them, keyed by slug. */
const REFS: NonNullable<TeamArtifactView["spriteRefs"]> = {
  pelipper: {
    display_name: "Pelipper",
    sprite_url: "https://example.test/pelipper.png",
    dex_number: 279,
    types: ["water", "flying"],
    base_stats: {
      hp: 60,
      attack: 50,
      defense: 100,
      special_attack: 95,
      special_defense: 70,
      speed: 65,
    },
  },
};

function view(over: Partial<TeamArtifactView> = {}): TeamArtifactView {
  return {
    id: 1,
    type: "team",
    format: "champions",
    title: "Rain Offense",
    source: "saved",
    phase: "done",
    detail: {
      id: "t1",
      name: "Rain Offense",
      format: "champions",
      members: [MEMBER],
      validation: [
        { code: "incomplete", message: "Pelipper has fewer than 4 moves." },
      ],
    },
    ...over,
  };
}

afterEach(cleanup);

describe("TeamArtifact", () => {
  it("renders members + warnings and an Edit link for a SAVED team", () => {
    render(<TeamArtifact view={view()} />);
    const members = screen.getByTestId("team-artifact-members");
    expect(members).toHaveTextContent("Pelipper");
    expect(members).toHaveTextContent("Damp Rock");
    expect(members).toHaveTextContent("Hurricane");
    expect(screen.getByTestId("team-artifact-warnings")).toHaveTextContent(
      "fewer than 4 moves",
    );
    expect(screen.getByTestId("team-artifact-edit")).toHaveAttribute(
      "href",
      "/teams",
    );
  });

  it("omits the Edit link for a PROPOSED (unsaved) team", () => {
    render(
      <TeamArtifact
        view={view({
          source: "proposed",
          detail: {
            id: "",
            name: "Rain",
            format: "champions",
            members: [MEMBER],
            validation: [],
          },
        })}
      />,
    );
    expect(screen.queryByTestId("team-artifact-edit")).toBeNull();
  });

  it("renders sprite, type badges, nature, and computed stats from spriteRefs", () => {
    render(<TeamArtifact view={view({ spriteRefs: REFS })} />);
    // Sprite image resolved from the ref.
    expect(screen.getByAltText("Pelipper")).toHaveAttribute(
      "src",
      "https://example.test/pelipper.png",
    );
    // Species type badges.
    expect(screen.getByTestId("type-badge-water")).toBeInTheDocument();
    expect(screen.getByTestId("type-badge-flying")).toBeInTheDocument();
    // Nature is shown explicitly.
    expect(screen.getByTestId("team-artifact-members")).toHaveTextContent(
      "Modest Nature",
    );
    // Computed final stats render; champions HP = base(60) + SP(0) + 75 = 135.
    expect(screen.getByTestId("team-member-stats")).toHaveTextContent("135");
  });

  it("shows the canonical display name (e.g. Mega forme) over a titleized slug", () => {
    const mega: TeamMember = { ...MEMBER, species: "swampert-mega" };
    render(
      <TeamArtifact
        view={view({
          detail: {
            id: "t1",
            name: "Rain",
            format: "champions",
            members: [mega],
            validation: [],
          },
          spriteRefs: {
            "swampert-mega": {
              display_name: "Swampert (Mega)",
              sprite_url: "https://example.test/swampert-mega.png",
              dex_number: 260,
              types: ["water", "ground"],
              base_stats: {
                hp: 100,
                attack: 150,
                defense: 110,
                special_attack: 95,
                special_defense: 110,
                speed: 70,
              },
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId("team-artifact-members")).toHaveTextContent(
      "Swampert (Mega)",
    );
  });

  it("shows a placeholder when a member has no moves", () => {
    const noMoves: TeamMember = { ...MEMBER, moves: [] };
    render(
      <TeamArtifact
        view={view({
          detail: {
            id: "t1",
            name: "Rain",
            format: "champions",
            members: [noMoves],
            validation: [],
          },
        })}
      />,
    );
    expect(screen.getByTestId("team-artifact-members")).toHaveTextContent(
      "No moves set",
    );
  });

  it("renders without stats/sprite when spriteRefs are absent", () => {
    render(<TeamArtifact view={view()} />);
    expect(screen.queryByTestId("team-member-stats")).toBeNull();
    // Slug-only data still renders.
    expect(screen.getByTestId("team-artifact-members")).toHaveTextContent(
      "Pelipper",
    );
  });

  it("shows an empty state when the team has no members", () => {
    render(
      <TeamArtifact
        view={view({
          detail: {
            id: "t1",
            name: "Empty",
            format: "champions",
            members: [],
            validation: [],
          },
        })}
      />,
    );
    expect(screen.getByTestId("team-artifact-empty")).toBeInTheDocument();
  });
});
