import { describe, it, expect } from "vitest";

import { computeMemberStats } from "./team-stats";
import type { SpriteRef } from "@/data/repos/pokedex-repo";

// Pelipper base stats: 60 / 50 / 100 / 95 / 70 / 65.
const BASE: SpriteRef["base_stats"] = {
  hp: 60,
  attack: 50,
  defense: 100,
  special_attack: 95,
  special_defense: 70,
  speed: 65,
};

const MEMBER = {
  nature: "modest", // +SpA, -Atk
  level: 50,
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
};

function byKey(rows: ReturnType<typeof computeMemberStats>) {
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

describe("computeMemberStats", () => {
  it("computes standard Gen-9 stats (Scarlet/Violet)", () => {
    const rows = byKey(computeMemberStats(MEMBER, BASE, "scarlet-violet"));
    // HP: floor((2*60 + 31 + floor(0/4)) * 50/100) + 50 + 10 = 75 + 60 = 135.
    expect(rows.hp.value).toBe(135);
    // SpA (boosted): floor((floor((2*95+31+63)*50/100)+5)*1.1)
    //   = floor((floor(284*0.5)+5)*1.1) = floor((142+5)*1.1) = floor(161.7) = 161.
    expect(rows.spa.value).toBe(161);
    expect(rows.spa.nature).toBe("boosted");
    expect(rows.atk.nature).toBe("hindered");
    // Speed: 252 EVs, neutral. floor((floor((2*65+31+63)*0.5)+5)*1.0)
    //   = floor(112+5) = 117.
    expect(rows.spe.value).toBe(117);
    expect(rows.spe.ev).toBe(252);
  });

  it("computes Champions Stat-Point stats (IV 31, Lv50 baked in)", () => {
    const rows = byKey(computeMemberStats(MEMBER, BASE, "champions"));
    // HP = base + SP + 75; SP from evs.hp(0) → 60 + 0 + 75 = 135.
    expect(rows.hp.value).toBe(135);
    // SpA (boosted): SP from evs.spa(252) clamps to 32 → floor((95+32+20)*1.1)
    //   = floor(147*1.1) = floor(161.7) = 161.
    expect(rows.spa.value).toBe(161);
    // Speed (neutral): SP clamps to 32 → floor((65+32+20)*1.0) = 117.
    expect(rows.spe.value).toBe(117);
  });
});
