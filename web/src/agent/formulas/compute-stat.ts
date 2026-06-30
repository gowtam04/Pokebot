/**
 * T9 — `compute_stat` pure formula (design.md § Formula functions, D5).
 *
 * Computes a Pokémon's final stat at a given level using the EXACT in-game
 * formulas with per-step flooring. No I/O; deterministic; idempotent.
 *
 *   non-HP: floor((floor((2*Base + IV + floor(EV/4)) * Level/100) + 5) * NatureMod)
 *   HP:     floor((2*Base + IV + floor(EV/4)) * Level/100) + Level + 10
 *
 * where NatureMod ∈ { boosted: 1.1, neutral: 1.0, hindered: 0.9 } (ignored for HP).
 * Shedinja (the only Pokémon with base HP 1) always has 1 HP — handled as an edge case.
 *
 * The tool wrapper (compute-stat.tool.ts) is responsible for applying the Zod
 * input defaults / SDK schema; this function accepts the already-typed params
 * and defends against out-of-range values by returning `invalid_input`.
 */

export interface ComputeStatParams {
  base_stat: number;
  is_hp?: boolean;
  iv?: number;
  ev?: number;
  level?: number;
  nature_effect?: "boosted" | "neutral" | "hindered";
}

export interface ComputeStatSuccess {
  value: number;
  breakdown: string;
  inputs_echo: Record<string, unknown>;
}

export interface ComputeStatError {
  error: "invalid_input";
  detail: string;
}

export type ComputeStatResult = ComputeStatSuccess | ComputeStatError;

const NATURE_MOD: Record<
  NonNullable<ComputeStatParams["nature_effect"]>,
  number
> = {
  boosted: 1.1,
  neutral: 1.0,
  hindered: 0.9,
};

const NATURE_MOD_LABEL: Record<
  NonNullable<ComputeStatParams["nature_effect"]>,
  string
> = {
  boosted: "1.1",
  neutral: "1.0",
  hindered: "0.9",
};

function isInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/**
 * Compute a final stat with exact per-step flooring.
 *
 * @returns the value + worked breakdown + an echo of the resolved inputs, or
 *          `{ error: "invalid_input", detail }` when an argument is out of range.
 */
export function computeStat(p: ComputeStatParams): ComputeStatResult {
  const is_hp = p.is_hp ?? false;
  const iv = p.iv ?? 31;
  const ev = p.ev ?? 0;
  const level = p.level ?? 50;
  const nature_effect = p.nature_effect ?? "neutral";
  const base_stat = p.base_stat;

  // --- validation (returns the structured invalid_input shape, not a throw) ---
  if (!isInteger(base_stat) || base_stat < 1) {
    return {
      error: "invalid_input",
      detail: "base_stat must be an integer >= 1",
    };
  }
  if (!isInteger(iv) || iv < 0 || iv > 31) {
    return { error: "invalid_input", detail: "iv must be 0..31" };
  }
  if (!isInteger(ev) || ev < 0 || ev > 252) {
    return { error: "invalid_input", detail: "ev must be 0..252" };
  }
  if (!isInteger(level) || level < 1 || level > 100) {
    return { error: "invalid_input", detail: "level must be 1..100" };
  }
  if (
    nature_effect !== "boosted" &&
    nature_effect !== "neutral" &&
    nature_effect !== "hindered"
  ) {
    return {
      error: "invalid_input",
      detail: "nature_effect must be one of: boosted, neutral, hindered",
    };
  }

  const inputs_echo: Record<string, unknown> = {
    base_stat,
    iv,
    ev,
    level,
    nature_effect,
    is_hp,
  };

  // Shared inner term: floor((2*Base + IV + floor(EV/4)) * Level / 100)
  const evTerm = Math.floor(ev / 4);
  const core = 2 * base_stat + iv + evTerm;
  const inner = Math.floor((core * level) / 100);

  if (is_hp) {
    // Shedinja edge case: the only base-HP-1 Pokémon, always 1 HP.
    if (base_stat === 1) {
      return {
        value: 1,
        breakdown: "Shedinja: HP is always 1 (special case)",
        inputs_echo,
      };
    }

    const value = inner + level + 10;
    const breakdown =
      `floor((2*${base_stat} + ${iv} + floor(${ev}/4)) * ${level} / 100) = ${inner}; ` +
      `${inner} + ${level} + 10 = ${value}`;
    return { value, breakdown, inputs_echo };
  }

  // non-HP
  const beforeNature = inner + 5;
  const mod = NATURE_MOD[nature_effect];
  const scaled = beforeNature * mod;
  const value = Math.floor(scaled);
  const breakdown =
    `floor((2*${base_stat} + ${iv} + floor(${ev}/4)) * ${level} / 100) = ${inner}; ` +
    `(${inner} + 5) * ${NATURE_MOD_LABEL[nature_effect]} = ${scaled} -> floor ${value}`;
  return { value, breakdown, inputs_echo };
}

// Champions per-stat Stat-Point cap (32). Stat Points arrive in the `ev` field.
const CHAMPIONS_SP_MAX = 32;

/**
 * Champions Level-50 Stat-Point stat (mirrors the @pkmn `champions` mod
 * `statModify`): with IV fixed at 31 and Level 50 folded into the constants,
 *   HP     = base + SP + 75
 *   non-HP = floor((base + SP + 20) × natureMod)   (natureMod ∈ {1.1, 1.0, 0.9})
 * where SP is the Stat Points value the caller passes in `ev`, clamped to 0..32.
 * `iv` and `level` are deliberately ignored. The breakdown echoes the Stat-Points
 * / IV=31 / Lv50 framing so the answer card is unambiguous.
 *
 * The single source of truth for Champions stat math: the `compute_stat` tool
 * (Champions mode) and the team artifact's client-side stat readout both call it.
 */
export function computeStatChampions(p: ComputeStatParams): ComputeStatResult {
  const is_hp = p.is_hp ?? false;
  const ev = p.ev ?? 0;
  const nature_effect = p.nature_effect ?? "neutral";
  const base_stat = p.base_stat;

  if (!isInteger(base_stat) || base_stat < 1) {
    return { error: "invalid_input", detail: "base_stat must be an integer >= 1" };
  }

  // Stat Points ride in on the `ev` field; clamp to the Champions 0..32 cap.
  const sp = Math.min(CHAMPIONS_SP_MAX, Math.max(0, ev));
  const inputs_echo: Record<string, unknown> = {
    base_stat,
    stat_points: sp,
    iv: 31,
    level: 50,
    nature_effect,
    is_hp,
    model: "champions",
  };

  if (is_hp) {
    // Shedinja is always 1 HP in every game (base HP 1) — preserve that edge.
    if (base_stat === 1) {
      return {
        value: 1,
        breakdown: "Shedinja: HP is always 1 (special case)",
        inputs_echo,
      };
    }
    const value = base_stat + sp + 75;
    return {
      value,
      breakdown: `Champions Lv50 (IV 31, Stat Points): ${base_stat} + ${sp} + 75 = ${value}`,
      inputs_echo,
    };
  }

  const mod = NATURE_MOD[nature_effect];
  const value = Math.floor((base_stat + sp + 20) * mod);
  return {
    value,
    breakdown: `Champions Lv50 (IV 31, Stat Points): floor((${base_stat} + ${sp} + 20) * ${NATURE_MOD_LABEL[nature_effect]}) = ${value}`,
    inputs_echo,
  };
}
