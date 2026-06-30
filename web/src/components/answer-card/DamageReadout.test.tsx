import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import DamageReadout from "./DamageReadout";
import { DAMAGE_CALC_GARCHOMP } from "@/components/test-fixtures";
import type { DamageCalc } from "@/components/types";

describe("DamageReadout", () => {
  it("always shows the 'Estimate' tag", () => {
    render(<DamageReadout damageCalc={DAMAGE_CALC_GARCHOMP} />);
    expect(screen.getByTestId("damage-estimate-tag")).toHaveTextContent(
      "Estimate",
    );
  });

  it("renders all result key-value pairs", () => {
    render(<DamageReadout damageCalc={DAMAGE_CALC_GARCHOMP} />);
    const result = screen.getByTestId("damage-result");
    expect(result).toHaveTextContent("min_damage");
    expect(result).toHaveTextContent("142");
    expect(result).toHaveTextContent("max_damage");
    expect(result).toHaveTextContent("168");
  });

  it("renders the breakdown when present", () => {
    render(<DamageReadout damageCalc={DAMAGE_CALC_GARCHOMP} />);
    const breakdown = screen.getByTestId("damage-breakdown");
    expect(breakdown).toHaveTextContent(DAMAGE_CALC_GARCHOMP.breakdown!);
  });

  it("does not render a breakdown element when breakdown is absent", () => {
    const noBreakdown: DamageCalc = {
      ...DAMAGE_CALC_GARCHOMP,
      breakdown: undefined,
    };
    render(<DamageReadout damageCalc={noBreakdown} />);
    expect(screen.queryByTestId("damage-breakdown")).not.toBeInTheDocument();
  });

  it("renders assumptions in the collapsible section", () => {
    render(<DamageReadout damageCalc={DAMAGE_CALC_GARCHOMP} />);
    const assumptions = screen.getByTestId("damage-assumptions");
    expect(assumptions.tagName).toBe("DETAILS");
    // assumptions should contain each key
    expect(assumptions).toHaveTextContent("level");
    expect(assumptions).toHaveTextContent("50");
    expect(assumptions).toHaveTextContent("attacker");
    expect(assumptions).toHaveTextContent("Garchomp");
  });

  it("renders a stat-calc result as well as a damage result", () => {
    const statCalc: DamageCalc = {
      assumptions: {
        level: 50,
        base_stat: 102,
        iv: 31,
        ev: 0,
        nature: "neutral",
      },
      result: { stat: "speed", value: 169 },
      is_estimate: true,
      breakdown: "floor((floor((2*102+31+0)*50/100)+5)*1.0) = 169",
    };
    render(<DamageReadout damageCalc={statCalc} />);
    expect(screen.getByTestId("damage-result")).toHaveTextContent("169");
    expect(screen.getByTestId("damage-result")).toHaveTextContent("speed");
  });
});
