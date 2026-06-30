/**
 * team-stats — client-side final-stat readout for the team artifact (TEAM-AD-7).
 *
 * Maps a team member's EVs/nature + the species' base stats to the six computed
 * final stats, picking the format's formula:
 *   - Champions  → `computeStatChampions` (Stat Points; IV 31, Lv50 baked in)
 *   - otherwise  → `computeStat` (standard Gen-9; IV assumed 31, member level)
 *
 * Pure: imports only the pure formula + nature table (no I/O, no server code), so
 * it's safe in client components and isolation tests.
 */

import {
  computeStat,
  computeStatChampions,
  type ComputeStatParams,
} from "@/agent/formulas/compute-stat";
import { natureEffectFor, type NatureStat } from "@/agent/formulas/natures";
import type { TeamMember, StatSpread } from "@/data/teams/team-schema";
import type { SpriteRef } from "@/data/repos/pokedex-repo";

/** The six stat keys in display order (HP first), matching `StatSpread`. */
export const MEMBER_STAT_KEYS = [
  "hp",
  "atk",
  "def",
  "spa",
  "spd",
  "spe",
] as const;

export type MemberStatKey = (typeof MEMBER_STAT_KEYS)[number];

/** Short display labels for each stat key. */
export const STAT_LABELS: Record<MemberStatKey, string> = {
  hp: "HP",
  atk: "Atk",
  def: "Def",
  spa: "SpA",
  spd: "SpD",
  spe: "Spe",
};

/** EV-key → base-stat-key (the repo's base_stats use long names). */
const BASE_STAT_KEY: Record<MemberStatKey, keyof SpriteRef["base_stats"]> = {
  hp: "hp",
  atk: "attack",
  def: "defense",
  spa: "special_attack",
  spd: "special_defense",
  spe: "speed",
};

const EMPTY_EVS: StatSpread = {
  hp: 0,
  atk: 0,
  def: 0,
  spa: 0,
  spd: 0,
  spe: 0,
};

export interface MemberStat {
  key: MemberStatKey;
  /** Computed final stat, or null if it couldn't be computed. */
  value: number | null;
  /** EV (standard) or Stat-Point (Champions) investment in this stat. */
  ev: number;
  /** Nature's effect on this stat (drives +/- coloring). */
  nature: "boosted" | "neutral" | "hindered";
}

/**
 * Compute the six final stats for `member` given its species `baseStats`. Returns
 * a row per stat (value, EV/SP, nature effect). EVs are clamped to the standard
 * 0..252 range before the formula (the Champions path further clamps to its SP
 * cap internally).
 */
export function computeMemberStats(
  member: Pick<TeamMember, "evs" | "nature" | "level">,
  baseStats: SpriteRef["base_stats"],
  format: string,
): MemberStat[] {
  const isChampions = format === "champions";
  const evs = member.evs ?? EMPTY_EVS;

  return MEMBER_STAT_KEYS.map((key) => {
    const ev = Math.min(252, Math.max(0, evs[key] ?? 0));
    const nature = natureEffectFor(member.nature, key as NatureStat | "hp");
    const params: ComputeStatParams = {
      base_stat: baseStats[BASE_STAT_KEY[key]],
      is_hp: key === "hp",
      iv: 31,
      ev,
      level: member.level,
      nature_effect: nature,
    };
    const result = isChampions
      ? computeStatChampions(params)
      : computeStat(params);
    return {
      key,
      value: "value" in result ? result.value : null,
      ev,
      nature,
    };
  });
}
