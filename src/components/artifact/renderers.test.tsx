/**
 * B-4 Phase 5 — per-kind renderer tests. Each renderer is rendered standalone
 * from a fixture (no provider mounted — EntityLink's no-op default keeps it
 * renderable, TD-5). Asserts the shape, the grouped + clickable movepool, the
 * matchup grids, and that clicking a nested entity without a provider is a safe
 * no-op.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";

import PokemonArtifact from "./PokemonArtifact";
import MoveArtifact from "./MoveArtifact";
import AbilityArtifact from "./AbilityArtifact";
import ItemArtifact from "./ItemArtifact";
import TypeMatchupsArtifact from "./TypeMatchupsArtifact";
import ComparisonArtifact from "./ComparisonArtifact";
import DamageCalcArtifact from "./DamageCalcArtifact";
import {
  ABILITY_ARTIFACT,
  ITEM_ARTIFACT,
  MOVE_ARTIFACT,
  POKEMON_ARTIFACT,
  TYPE_ARTIFACT,
} from "./artifact-fixtures";
import {
  DAMAGE_CALC_GARCHOMP,
  SUBJECT_GARCHOMP,
} from "@/components/test-fixtures";
import type { PokemonArtifactData } from "@/lib/entity-artifact";

afterEach(() => cleanup());

describe("PokemonArtifact", () => {
  // Component fixture layering the contract-B quad arrays (#12) onto the shared
  // Garchomp fixture: ice is a 4x weakness, fire a 1/4 resist.
  const POKEMON_WITH_QUAD = {
    ...POKEMON_ARTIFACT.data,
    matchups: {
      ...POKEMON_ARTIFACT.data.matchups,
      quad_weak_to: ["ice"],
      quad_resists: ["fire"],
    },
  } as PokemonArtifactData;

  it("renders stats, abilities, matchups, and a grouped clickable movepool", () => {
    render(<PokemonArtifact data={POKEMON_WITH_QUAD} />);

    expect(screen.getByTestId("pokemon-artifact")).toBeInTheDocument();
    // Base stats (per-stat value) + the total row.
    expect(screen.getByTestId("pokemon-stats")).toHaveTextContent("130");
    expect(screen.getByTestId("pokemon-stats")).toHaveTextContent("600");

    // Abilities: titleized DISPLAY label (#3), with the hidden marker lifted
    // into a standalone badge (#4) — not inline "(Hidden)" text.
    const abilities = screen.getByTestId("pokemon-abilities");
    expect(within(abilities).getByText("Rough Skin")).toBeInTheDocument();
    expect(
      within(abilities).queryByText(/\(Hidden\)/),
    ).not.toBeInTheDocument();
    const hiddenBadge = within(abilities).getByText("Hidden");
    expect(hiddenBadge).toHaveClass("ability-chip__hidden-badge");

    // Combined defensive grid + magnitudes (#12): quad members read x4 / x1/4,
    // the remainder x2 / x1/2, immunities x0.
    const weak = screen.getByTestId("matchups-weak");
    expect(weak).toHaveTextContent("x4"); // ice (quad)
    expect(weak).toHaveTextContent("x2"); // dragon / fairy
    const resists = screen.getByTestId("matchups-resists");
    expect(resists).toHaveTextContent("x1/4"); // fire (quad)
    expect(resists).toHaveTextContent("x1/2"); // poison / rock
    const immune = screen.getByTestId("matchups-immune");
    expect(immune).toHaveTextContent("electric");
    expect(immune).toHaveTextContent("x0");

    // Movepool grouped by method; moves are clickable EntityLink buttons.
    expect(screen.getByTestId("movepool-group-Level-up")).toBeInTheDocument();
    const moveBtn = screen.getByTestId("movepool-move-dragon-claw");
    expect(moveBtn.tagName).toBe("BUTTON");
    // No provider mounted → click is a safe no-op (does not throw).
    expect(() => fireEvent.click(moveBtn)).not.toThrow();
  });
});

describe("MoveArtifact", () => {
  it("renders the move stats and effect", () => {
    render(<MoveArtifact data={MOVE_ARTIFACT.data} />);
    expect(screen.getByTestId("move-stats")).toHaveTextContent("physical");
    expect(screen.getByTestId("move-effect")).toHaveTextContent(
      "hits all adjacent",
    );
    expect(screen.getByTestId("type-badge-ground")).toBeInTheDocument();
  });
});

describe("AbilityArtifact", () => {
  it("renders the effect and a clickable learned_by roster", () => {
    render(<AbilityArtifact data={ABILITY_ARTIFACT.data} />);
    expect(screen.getByTestId("ability-effect")).toHaveTextContent("contact");
    const holders = screen.getByTestId("ability-holders");
    expect(within(holders).getByTestId("ability-holder-garchomp")).toBeInTheDocument();
  });
});

describe("ItemArtifact", () => {
  it("renders the item effect", () => {
    render(<ItemArtifact data={ITEM_ARTIFACT.data} />);
    expect(screen.getByTestId("item-effect")).toHaveTextContent("max HP");
  });
});

describe("TypeMatchupsArtifact", () => {
  it("renders offensive + defensive grids", () => {
    render(<TypeMatchupsArtifact data={TYPE_ARTIFACT.data} />);
    expect(screen.getByTestId("type-offensive")).toHaveTextContent("flying");
    expect(screen.getByTestId("defensive-weak")).toHaveTextContent("water");
  });
});

describe("ComparisonArtifact", () => {
  it("renders one clickable card per subject", () => {
    render(<ComparisonArtifact subjects={[SUBJECT_GARCHOMP]} />);
    expect(screen.getByTestId("comparison-subject-0")).toBeInTheDocument();
    expect(screen.getByTestId("sprite-card")).toBeInTheDocument();
  });
});

describe("DamageCalcArtifact", () => {
  it("reuses the DamageReadout for the breakdown", () => {
    render(<DamageCalcArtifact damageCalc={DAMAGE_CALC_GARCHOMP} />);
    expect(screen.getByTestId("damage-calc-artifact")).toBeInTheDocument();
    expect(screen.getByTestId("damage-readout")).toBeInTheDocument();
  });
});
