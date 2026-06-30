import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// TeamEditor resolves sprites for its live members; stub it out so tests stay
// hermetic (the prop seed still drives the live-stat assertions).
vi.mock("@/lib/api/sprites-client", () => ({
  resolveSprites: vi.fn(async () => ({})),
}));

import TeamEditor from "./TeamEditor";
import type { TeamDetail } from "@/lib/api/teams-client";
import type { SpriteRef } from "@/lib/api/sprites-client";
import type { TeamMember } from "@/data/teams/team-schema";

afterEach(() => cleanup());

function fullMember(species: string): TeamMember {
  return {
    species,
    ability: "intimidate",
    item: "leftovers",
    moves: ["a", "b", "c", "d"],
    nature: "adamant",
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: "water",
    level: 50,
    nickname: null,
  };
}

function detail(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: "t1",
    name: "My Team",
    format: "scarlet-violet",
    members: [fullMember("gyarados"), fullMember("garchomp")],
    validation: [],
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof TeamEditor>> = {}) {
  const props = {
    team: detail(),
    onSave: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  const utils = render(<TeamEditor {...props} />);
  return { ...utils, props };
}

describe("TeamEditor", () => {
  it("seeds the name, a roster chip per member, and a focused panel", () => {
    setup();
    expect(screen.getByTestId("team-name")).toHaveValue("My Team");
    // The roster shows every member; only the selected slot mounts a panel.
    expect(screen.getByTestId("roster-slot-0")).toBeInTheDocument();
    expect(screen.getByTestId("roster-slot-1")).toBeInTheDocument();
    expect(screen.getByTestId("member-0-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("member-1-panel")).not.toBeInTheDocument();
  });

  it("focuses a member when its roster chip is clicked", () => {
    setup();
    expect(screen.getByTestId("member-0-species")).toHaveValue("gyarados");
    fireEvent.click(screen.getByTestId("roster-slot-1"));
    expect(screen.getByTestId("member-1-panel")).toBeInTheDocument();
    expect(screen.getByTestId("member-1-species")).toHaveValue("garchomp");
  });

  it("renames and saves the draft", () => {
    const { props } = setup();
    fireEvent.change(screen.getByTestId("team-name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByTestId("team-save"));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" }),
    );
  });

  it("adds a blank member and focuses it", () => {
    setup({ team: detail({ members: [fullMember("ditto")] }) });
    expect(screen.queryByTestId("member-1-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("team-add-member"));
    // The new (empty) slot becomes the focused panel (partial team — BR-T4).
    expect(screen.getByTestId("member-1-panel")).toBeInTheDocument();
    expect(screen.getByTestId("member-1-species")).toHaveValue("");
  });

  it("hides Add at six members", () => {
    const six = Array.from({ length: 6 }, (_, i) => fullMember(`p${i}`));
    setup({ team: detail({ members: six }) });
    expect(screen.queryByTestId("team-add-member")).not.toBeInTheDocument();
  });

  it("removes the focused member", () => {
    setup();
    fireEvent.click(screen.getByTestId("roster-slot-1"));
    fireEvent.click(screen.getByTestId("member-1-remove"));
    // Back to a single member; slot 1 no longer exists.
    expect(screen.queryByTestId("roster-slot-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("member-0-species")).toHaveValue("gyarados");
  });

  it("reorders members (swap on move up, focus follows)", () => {
    setup();
    fireEvent.click(screen.getByTestId("roster-slot-1"));
    expect(screen.getByTestId("member-1-species")).toHaveValue("garchomp");
    fireEvent.click(screen.getByTestId("member-1-up"));
    // The moved member (garchomp) is now slot 0 and stays focused.
    expect(screen.getByTestId("member-0-species")).toHaveValue("garchomp");
    fireEvent.click(screen.getByTestId("roster-slot-1"));
    expect(screen.getByTestId("member-1-species")).toHaveValue("gyarados");
  });

  it("saves even a partial team (BR-T4)", () => {
    const { props } = setup({ team: detail({ members: [] }) });
    fireEvent.click(screen.getByTestId("team-add-member"));
    fireEvent.click(screen.getByTestId("team-save"));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({ species: null })],
      }),
    );
  });

  it("renders team-level warnings and per-slot warnings separately", () => {
    setup({
      team: detail({
        validation: [
          { code: "duplicate_item", message: "Two Leftovers." },
          {
            code: "incomplete",
            message: "Slot 2 incomplete.",
            slot: 1,
          },
        ],
      }),
    });
    // Team-level (no slot) in the editor's header warnings.
    expect(screen.getByTestId("team-level-warnings")).toHaveTextContent(
      "Two Leftovers.",
    );
    // Per-slot warnings show inside that member's panel once it is focused.
    fireEvent.click(screen.getByTestId("roster-slot-1"));
    expect(screen.getByTestId("member-1-warnings")).toHaveTextContent(
      "Slot 2 incomplete.",
    );
  });

  it("triggers export", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("team-export"));
    expect(props.onExport).toHaveBeenCalledOnce();
  });

  it("passes live stats through when base stats are supplied", () => {
    const garchompRef: SpriteRef = {
      display_name: "Garchomp",
      sprite_url: "https://example.test/garchomp.png",
      dex_number: 445,
      types: ["dragon", "ground"],
      base_stats: {
        hp: 108,
        attack: 130,
        defense: 95,
        special_attack: 80,
        special_defense: 85,
        speed: 102,
      },
    };
    setup({
      team: detail({ members: [fullMember("garchomp")] }),
      spriteBySpecies: { garchomp: garchompRef },
    });
    expect(screen.getByTestId("member-0-stat-hp")).toBeInTheDocument();
  });

  it("disables Save while saving", () => {
    setup({ saving: true });
    expect(screen.getByTestId("team-save")).toBeDisabled();
  });
});
