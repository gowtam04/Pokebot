import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// The Move pickers load a species' legal movepool via this client.
const learnset = vi.hoisted(() => ({ fetchLearnset: vi.fn() }));
vi.mock("@/lib/api/learnset-client", () => learnset);

import TeamMemberPanel, {
  type MemberBaseStats,
} from "./TeamMemberPanel";
import type { TeamMember } from "@/data/teams/team-schema";
import type { TeamWarning } from "@/lib/api/teams-client";

beforeEach(() => {
  learnset.fetchLearnset.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  learnset.fetchLearnset.mockReset();
});

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: "life-orb",
    moves: ["earthquake", "dragon-claw"],
    nature: "jolly",
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: "steel",
    level: 50,
    nickname: null,
    ...overrides,
  };
}

// Garchomp base stats (hp/atk/def/spa/spd/spe = 108/130/95/80/85/102).
const GARCHOMP_BASE: MemberBaseStats = {
  hp: 108,
  attack: 130,
  defense: 95,
  special_attack: 80,
  special_defense: 85,
  speed: 102,
};

function noop() {}

describe("TeamMemberPanel", () => {
  it("renders every set field as a controlled input", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByTestId("member-0-species")).toHaveValue("garchomp");
    expect(screen.getByTestId("member-0-ability")).toHaveValue("rough-skin");
    expect(screen.getByTestId("member-0-item")).toHaveValue("life-orb");
    expect(screen.getByTestId("member-0-nature")).toHaveValue("jolly");
    expect(screen.getByTestId("member-0-tera")).toHaveValue("steel");
    expect(screen.getByTestId("member-0-level")).toHaveValue(50);
    expect(screen.getByTestId("member-0-move-0")).toHaveValue("earthquake");
    expect(screen.getByTestId("member-0-move-1")).toHaveValue("dragon-claw");
    expect(screen.getByTestId("member-0-ev-spe")).toHaveValue(252);
    expect(screen.getByTestId("member-0-iv-hp")).toHaveValue(31);
  });

  it("commits a selected option and clears a field to null", () => {
    const onChange = vi.fn();
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    // Selecting from a static dropdown (require-selection) commits the slug.
    const nature = screen.getByTestId("member-0-nature");
    fireEvent.change(nature, { target: { value: "mod" } });
    fireEvent.keyDown(nature, { key: "ArrowDown" });
    fireEvent.keyDown(nature, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ nature: "modest" }),
    );
    // Clearing a committed field and blurring commits null.
    const item = screen.getByTestId("member-0-item");
    fireEvent.change(item, { target: { value: "" } });
    fireEvent.blur(item);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ item: null }),
    );
  });

  it("offers only the species' learnset and emits move slugs in order", async () => {
    learnset.fetchLearnset.mockResolvedValue([
      { slug: "stealth-rock", display_name: "Stealth Rock" },
    ]);
    const onChange = vi.fn();
    render(
      <TeamMemberPanel
        slot={0}
        member={member({ moves: [] })}
        warnings={[]}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    const move0 = screen.getByTestId("member-0-move-0");
    fireEvent.focus(move0);
    // The learnset arrives asynchronously and surfaces in the dropdown.
    const option = await screen.findByText("Stealth Rock");
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ moves: ["stealth-rock"] }),
    );
  });

  it("disables the Move pickers until a species is chosen", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member({ species: null })}
        warnings={[]}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByTestId("member-0-move-0")).toBeDisabled();
  });

  it("hides Tera and tightens the EV budget in Champions", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        format="champions"
        warnings={[]}
        onChange={noop}
        onRemove={noop}
      />,
    );
    // No Terastallization in Champions.
    expect(screen.queryByTestId("member-0-tera")).not.toBeInTheDocument();
    // Stat-Point budget reads "/ 66" and each EV input caps at 32.
    expect(screen.getByTestId("member-0-ev-total")).toHaveTextContent("/ 66");
    expect(screen.getByTestId("member-0-ev-spe")).toHaveAttribute("max", "32");
  });

  it("clamps an EV edit into 0..255", () => {
    const onChange = vi.fn();
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    fireEvent.change(screen.getByTestId("member-0-ev-atk"), {
      target: { value: "999" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        evs: expect.objectContaining({ atk: 255 }),
      }),
    );
  });

  it("shows live computed stats when base stats are supplied", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        baseStats={GARCHOMP_BASE}
        onChange={noop}
        onRemove={noop}
      />,
    );
    // HP at lvl 50: floor((2*108+31+0)*50/100)+50+10 = floor(123.5)+60 = 123+60 = 183.
    expect(screen.getByTestId("member-0-stat-hp")).toHaveTextContent("183");
    // Speed: 252 EV, +Spe nature (jolly), lvl 50.
    // inner = floor((2*102+31+63)*50/100)=floor(149)=149; (149+5)*1.1=169.4→169.
    expect(screen.getByTestId("member-0-stat-spe")).toHaveTextContent("169");
  });

  it("omits the live column when no base stats are given", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.queryByTestId("member-0-stat-hp")).not.toBeInTheDocument();
  });

  it("calls onRemove and reorder callbacks", () => {
    const onRemove = vi.fn();
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(
      <TeamMemberPanel
        slot={1}
        member={member()}
        warnings={[]}
        onChange={noop}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        canMoveUp
        canMoveDown
      />,
    );
    fireEvent.click(screen.getByTestId("member-1-remove"));
    fireEvent.click(screen.getByTestId("member-1-up"));
    fireEvent.click(screen.getByTestId("member-1-down"));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onMoveUp).toHaveBeenCalledOnce();
    expect(onMoveDown).toHaveBeenCalledOnce();
  });

  it("disables up/down at the ends", () => {
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={[]}
        onChange={noop}
        onRemove={noop}
        canMoveUp={false}
        canMoveDown
      />,
    );
    expect(screen.getByTestId("member-0-up")).toBeDisabled();
    expect(screen.getByTestId("member-0-down")).not.toBeDisabled();
  });

  it("renders per-slot warnings inline", () => {
    const warnings: TeamWarning[] = [
      {
        code: "move_not_in_learnset",
        message: "Garchomp can't learn Surf.",
        slot: 0,
        field: "moves[2]",
      },
    ];
    render(
      <TeamMemberPanel
        slot={0}
        member={member()}
        warnings={warnings}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/can't learn Surf/)).toBeInTheDocument();
  });
});
