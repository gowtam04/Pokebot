/**
 * T10 — `estimate_damage` pure formula (D5).
 *
 * Implements the standard single-hit Pokémon damage formula with per-step
 * flooring on the base, then applies the STAB / type / other multipliers and the
 * 0.85–1.0 random roll to report the min–max damage range.
 *
 * Pure function: no I/O, no side effects, deterministic. Never throws — invalid
 * inputs are returned as a structured `{ error: "invalid_input", detail }`
 * (tools.md T10 / design.md § Formula functions).
 *
 * Base (per design.md / tools.md):
 *   base = floor(floor(floor((2*Level/5 + 2) * Power * A / D) / 50) + 2)
 * then `× STAB(1.5) × type_effectiveness × other_modifier × roll`,
 * roll ∈ [0.85, 1.0]. min uses 0.85, max uses 1.0.
 */

/** Parameters for {@link estimateDamage} (design.md § Formula functions). */
export interface EstimateDamageParams {
  /** Attacker level. Defaults to 50 (standard competitive level). */
  level?: number;
  /** Move base power. */
  power: number;
  /** Attacker's effective Atk or SpA. */
  attack_stat: number;
  /** Defender's effective Def or SpD. */
  defense_stat: number;
  /** Same-type-attack bonus (×1.5). Defaults to false. */
  stab?: boolean;
  /** Product of type matchups, e.g. 2, 0.5, 0, 4. Defaults to 1. */
  type_effectiveness?: number;
  /** Combined weather/item/ability/etc. multiplier. Defaults to 1. */
  other_modifier?: number;
}

/** Successful estimate (tools.md T10 output shape). */
export interface EstimateDamageResult {
  min_damage: number;
  max_damage: number;
  is_estimate: true;
  breakdown: string;
  inputs_echo: Record<string, unknown>;
}

/** Structured failure — returned, never thrown. */
export interface EstimateDamageError {
  error: "invalid_input";
  detail: string;
}

export type EstimateDamageOutput = EstimateDamageResult | EstimateDamageError;

const STAB_MULTIPLIER = 1.5;
const MIN_ROLL = 0.85;
const MAX_ROLL = 1.0;

function invalid(detail: string): EstimateDamageError {
  return { error: "invalid_input", detail };
}

/**
 * Estimate damage for a single attack, returning the min–max range.
 *
 * @see EstimateDamageParams
 */
export function estimateDamage(p: EstimateDamageParams): EstimateDamageOutput {
  const level = p.level ?? 50;
  const { power, attack_stat, defense_stat } = p;
  const stab = p.stab ?? false;
  const typeEffectiveness = p.type_effectiveness ?? 1;
  const otherModifier = p.other_modifier ?? 1;

  // --- Validation (never throw) -------------------------------------------
  for (const [name, value] of [
    ["level", level],
    ["power", power],
    ["attack_stat", attack_stat],
    ["defense_stat", defense_stat],
    ["type_effectiveness", typeEffectiveness],
    ["other_modifier", otherModifier],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid(`${name} must be a finite number (got ${String(value)}).`);
    }
  }
  if (level < 1) {
    return invalid(`level must be >= 1 (got ${level}).`);
  }
  if (power < 0) {
    return invalid(`power must be >= 0 (got ${power}).`);
  }
  if (attack_stat <= 0) {
    return invalid(`attack_stat must be > 0 (got ${attack_stat}).`);
  }
  if (defense_stat <= 0) {
    // Guards against division by zero.
    return invalid(`defense_stat must be > 0 (got ${defense_stat}).`);
  }
  if (typeEffectiveness < 0 || otherModifier < 0) {
    return invalid(
      `type_effectiveness and other_modifier must be >= 0 (got ${typeEffectiveness}, ${otherModifier}).`,
    );
  }

  // --- Base damage with per-step flooring ---------------------------------
  const levelFactor = (2 * level) / 5 + 2;
  const inner = Math.floor((levelFactor * power * attack_stat) / defense_stat);
  const base = Math.floor(Math.floor(inner / 50) + 2);

  // --- Apply multipliers, then the 0.85–1.0 roll --------------------------
  const stabMultiplier = stab ? STAB_MULTIPLIER : 1;
  const modified = base * stabMultiplier * typeEffectiveness * otherModifier;

  const min_damage = Math.floor(modified * MIN_ROLL);
  const max_damage = Math.floor(modified * MAX_ROLL);

  const breakdown =
    `base = floor(floor(floor((2*${level}/5+2)*${power}*${attack_stat}/${defense_stat})/50)+2) = ${base}; ` +
    `* STAB ${stabMultiplier} * type ${typeEffectiveness} * other ${otherModifier} ` +
    `* roll[${MIN_ROLL}..${MAX_ROLL}] = ${min_damage}..${max_damage}`;

  return {
    min_damage,
    max_damage,
    is_estimate: true,
    breakdown,
    inputs_echo: {
      level,
      power,
      attack_stat,
      defense_stat,
      stab,
      type_effectiveness: typeEffectiveness,
      other_modifier: otherModifier,
    },
  };
}

export default estimateDamage;
