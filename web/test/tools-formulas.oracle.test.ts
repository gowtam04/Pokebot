/**
 * INDEPENDENT ORACLE — compute_stat (T9) and estimate_damage (T10).
 *
 * Expected values are derived by hand from the exact formulas in tools.md /
 * design.md § Interface Definitions, NOT from the implementation. These tests
 * target the pure formula functions directly (src/agent/formulas/*), the level
 * whose signatures are pinned by the design doc.
 *
 *   compute_stat (non-HP):
 *     floor((floor((2*Base + IV + floor(EV/4)) * Level/100) + 5) * NatureMod)
 *   compute_stat (HP):
 *     floor((2*Base + IV + floor(EV/4)) * Level/100) + Level + 10
 *   estimate_damage:
 *     base = floor(floor(floor((2*Level/5 + 2) * Power * A / D) / 50) + 2)
 *     then x STAB(1.5) x type x other x roll, roll in [0.85, 1.0]; min=0.85 max=1.0
 *
 * Until Phase 4 builds the formulas these imports fail; `beforeAll` captures the
 * load error and every test reports it as a clear, single failure (the red gate)
 * rather than a collection crash.
 */

import { beforeAll, describe, expect, it } from "vitest";

type ComputeStat = (p: {
  base_stat: number;
  is_hp?: boolean;
  iv?: number;
  ev?: number;
  level?: number;
  nature_effect?: "boosted" | "neutral" | "hindered";
}) => unknown;

type EstimateDamage = (p: {
  level?: number;
  power: number;
  attack_stat: number;
  defense_stat: number;
  stab?: boolean;
  type_effectiveness?: number;
  other_modifier?: number;
}) => unknown;

let computeStat: ComputeStat;
let estimateDamage: EstimateDamage;
let loadError: unknown = null;

beforeAll(async () => {
  try {
    const csMod = (await import("@/agent/formulas/compute-stat")) as Record<
      string,
      unknown
    >;
    const edMod = (await import("@/agent/formulas/estimate-damage")) as Record<
      string,
      unknown
    >;
    computeStat = (csMod.computeStat ?? csMod.default) as ComputeStat;
    estimateDamage = (edMod.estimateDamage ?? edMod.default) as EstimateDamage;
    if (
      typeof computeStat !== "function" ||
      typeof estimateDamage !== "function"
    ) {
      throw new Error(
        "Expected computeStat / estimateDamage function exports from src/agent/formulas/*",
      );
    }
  } catch (e) {
    loadError = e;
  }
});

function ensureLoaded(): void {
  if (loadError) {
    throw new Error(
      `Formula modules not loadable yet (Phase 4 incomplete): ${String(loadError)}`,
    );
  }
}

function asValue(out: unknown): number {
  expect(
    out,
    "expected a success result, not a structured error",
  ).toMatchObject({
    value: expect.any(Number),
  });
  return (out as { value: number }).value;
}

describe("compute_stat oracle (T9)", () => {
  it("Garchomp Speed: base 102, lvl 50, 252 EV, 31 IV, boosted == 169", () => {
    ensureLoaded();
    const out = computeStat({
      base_stat: 102,
      level: 50,
      ev: 252,
      iv: 31,
      nature_effect: "boosted",
    });
    // floor((2*102+31+63)*50/100)=149; (149+5)*1.1=169.4 -> 169
    expect(asValue(out)).toBe(169);
  });

  it("Garchomp Speed neutral (252 EV) == 154; hindered == 138", () => {
    ensureLoaded();
    expect(
      asValue(
        computeStat({
          base_stat: 102,
          level: 50,
          ev: 252,
          iv: 31,
          nature_effect: "neutral",
        }),
      ),
    ).toBe(154);
    // (149+5)*0.9 = 138.6 -> 138
    expect(
      asValue(
        computeStat({
          base_stat: 102,
          level: 50,
          ev: 252,
          iv: 31,
          nature_effect: "hindered",
        }),
      ),
    ).toBe(138);
  });

  it("applies documented defaults (lvl 50, 31 IV, 0 EV, neutral): Garchomp Speed == 122", () => {
    ensureLoaded();
    // (2*102+31+0)*50/100 = 117.5 -> 117; (117+5)*1.0 = 122
    expect(asValue(computeStat({ base_stat: 102 }))).toBe(122);
  });

  it("HP uses the HP formula: Garchomp HP base 108, lvl 50, 0 EV, 31 IV == 183", () => {
    ensureLoaded();
    // floor((2*108+31)*50/100)=123; 123+50+10 = 183
    expect(
      asValue(
        computeStat({ base_stat: 108, is_hp: true, level: 50, ev: 0, iv: 31 }),
      ),
    ).toBe(183);
  });

  it("returns a structured invalid_input (never throws) on an out-of-range EV", () => {
    ensureLoaded();
    let out: unknown;
    expect(() => {
      out = computeStat({ base_stat: 102, ev: 300 });
    }).not.toThrow();
    expect(out).toMatchObject({ error: "invalid_input" });
    expect((out as { detail?: unknown }).detail).toEqual(expect.any(String));
  });
});

describe("estimate_damage oracle (T10)", () => {
  it("is an estimate and returns min < max for the canonical 120-BP STAB super-effective hit", () => {
    ensureLoaded();
    const out = estimateDamage({
      level: 50,
      power: 120,
      attack_stat: 169,
      defense_stat: 95,
      stab: true,
      type_effectiveness: 2,
    });
    expect(out).toMatchObject({ is_estimate: true });
    const r = out as { min_damage: number; max_damage: number };
    expect(Number.isInteger(r.min_damage)).toBe(true);
    expect(Number.isInteger(r.max_damage)).toBe(true);
    expect(r.min_damage).toBeLessThan(r.max_damage);
    expect(r.min_damage).toBeGreaterThan(0);
  });

  it("floors PER STEP (roll -> STAB -> type): canonical STAB x2 hit -> min 240, max 284", () => {
    ensureLoaded();
    // base = floor(floor(floor((2*50/5+2)*120*169/95)/50)+2):
    //   (2*50/5+2)=22; floor(22*120*169/95)=floor(4696.42)=4696;
    //   floor(4696/50)=93; 93+2=95.
    // Per-step floor (the in-game order):
    //   min = floor(floor(floor(95*0.85)*1.5)*2)
    //       = floor(floor(80*1.5)*2) = floor(120*2) = 240
    //   max = floor(floor(floor(95*1.0)*1.5)*2)
    //       = floor(floor(142*... )) -> floor(95*1.5)=142; 142*2=284
    // A single product then one floor (the old code) would overstate this as
    //   242..285 (floor(95*3*0.85)=242, floor(95*3)=285).
    const out = estimateDamage({
      level: 50,
      power: 120,
      attack_stat: 169,
      defense_stat: 95,
      stab: true,
      type_effectiveness: 2,
    });
    expect(out).toMatchObject({
      is_estimate: true,
      min_damage: 240,
      max_damage: 284,
    });
  });

  it("per-step flooring diverges more at STAB x4: base 95 -> min 480, max 568", () => {
    ensureLoaded();
    // Same base 95 as above, type_effectiveness 4:
    //   min = floor(floor(floor(95*0.85)*1.5)*4) = floor(floor(80*1.5)*4)
    //       = floor(120*4) = 480
    //   max = floor(floor(floor(95*1.0)*1.5)*4) = floor(142*4) = 568
    // Old one-shot code: floor(95*6*0.85)=484, floor(95*6)=570.
    const out = estimateDamage({
      level: 50,
      power: 120,
      attack_stat: 169,
      defense_stat: 95,
      stab: true,
      type_effectiveness: 4,
    });
    expect(out).toMatchObject({
      is_estimate: true,
      min_damage: 480,
      max_damage: 568,
    });
  });

  it("unmodified hit (power 80, A 100, D 100, no STAB, neutral): base 37 -> min 31, max 37", () => {
    ensureLoaded();
    // (2*50/5+2)=22; 22*80*100/100=1760; floor(1760/50)=35; 35+2=37
    // min=floor(37*0.85)=31; max=floor(37*1.0)=37
    const out = estimateDamage({
      power: 80,
      attack_stat: 100,
      defense_stat: 100,
    });
    expect(out).toMatchObject({
      is_estimate: true,
      min_damage: 31,
      max_damage: 37,
    });
  });

  it("a 0x (immune) hit deals 0 damage at both ends", () => {
    ensureLoaded();
    const out = estimateDamage({
      power: 120,
      attack_stat: 169,
      defense_stat: 95,
      stab: true,
      type_effectiveness: 0,
    });
    expect(out).toMatchObject({
      is_estimate: true,
      min_damage: 0,
      max_damage: 0,
    });
  });

  it("returns a structured invalid_input (never throws) on a zero defense_stat", () => {
    ensureLoaded();
    let out: unknown;
    expect(() => {
      out = estimateDamage({ power: 80, attack_stat: 100, defense_stat: 0 });
    }).not.toThrow();
    expect(out).toMatchObject({ error: "invalid_input" });
  });
});
