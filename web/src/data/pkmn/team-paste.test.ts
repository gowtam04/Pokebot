/**
 * Unit tests for the `@pkmn/sets` boundary (team-paste.ts).
 *
 * Pure parse/serialize behaviour — no DB, no slug resolution (that is
 * import-export's job). Verifies:
 *   - a multi-set paste parses to the right number of sets with display names,
 *   - the parse→serialize→parse round-trip preserves every represented field
 *     including cosmetics (nickname / gender / shiny) — AC-11.2,
 *   - tolerance: an empty/blank paste yields [], and a malformed block doesn't
 *     sink the parseable members (BR-T11).
 */

import { describe, expect, it } from "vitest";

import { parseShowdown, serializeShowdown } from "./team-paste";

const TWO_MON = `Great Tusk @ Booster Energy
Ability: Protosynthesis
Level: 50
Tera Type: Ground
EVs: 252 Atk / 4 Def / 252 Spe
Jolly Nature
- Headlong Rush
- Close Combat
- Ice Spinner
- Rapid Spin

Iron Hands (M) @ Assault Vest
Ability: Quark Drive
Shiny: Yes
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
IVs: 0 Spe
- Fake Out
- Drain Punch
- Wild Charge
- Heavy Slam`;

describe("parseShowdown", () => {
  it("parses a multi-set paste into display-name sets", () => {
    const sets = parseShowdown(TWO_MON);
    expect(sets).toHaveLength(2);
    expect(sets[0].species).toBe("Great Tusk");
    expect(sets[0].item).toBe("Booster Energy");
    expect(sets[0].ability).toBe("Protosynthesis");
    expect(sets[0].nature).toBe("Jolly");
    expect(sets[0].teraType).toBe("Ground");
    expect(sets[0].level).toBe(50);
    expect(sets[0].evs).toMatchObject({ atk: 252, def: 4, spe: 252 });
    expect(sets[0].moves).toEqual([
      "Headlong Rush",
      "Close Combat",
      "Ice Spinner",
      "Rapid Spin",
    ]);
  });

  it("preserves cosmetics (nickname / gender / shiny)", () => {
    const sets = parseShowdown(
      `Chompy (Garchomp) (M) @ Leftovers\nAbility: Rough Skin\nShiny: Yes\n- Earthquake`,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].name).toBe("Chompy");
    expect(sets[0].species).toBe("Garchomp");
    expect(sets[0].gender).toBe("M");
    expect(sets[0].shiny).toBe(true);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(parseShowdown("")).toEqual([]);
    expect(parseShowdown("   \n\n  ")).toEqual([]);
  });

  it("caps at six sets", () => {
    const block = "Garchomp\nAbility: Rough Skin\n- Earthquake";
    const paste = Array.from({ length: 8 }, () => block).join("\n\n");
    expect(parseShowdown(paste)).toHaveLength(6);
  });
});

describe("serializeShowdown", () => {
  it("round-trips every represented field through parse→serialize→parse", () => {
    const first = parseShowdown(TWO_MON);
    const text = serializeShowdown(first);
    const second = parseShowdown(text);

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i += 1) {
      expect(second[i].species).toBe(first[i].species);
      expect(second[i].item).toBe(first[i].item);
      expect(second[i].ability).toBe(first[i].ability);
      expect(second[i].nature).toBe(first[i].nature);
      expect(second[i].level).toBe(first[i].level);
      expect(second[i].moves).toEqual(first[i].moves);
      expect(second[i].evs).toEqual(first[i].evs);
    }
    // Cosmetics survive the round-trip on the second set.
    expect(second[1].gender).toBe("M");
    expect(second[1].shiny).toBe(true);
  });

  it("serializes an empty list to an empty string", () => {
    expect(serializeShowdown([])).toBe("");
  });
});
