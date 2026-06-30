/**
 * Nature → stat-effect table (pure; no I/O, client-importable).
 *
 * `computeStat` / `computeStatChampions` take an abstract `nature_effect`
 * ("boosted" | "neutral" | "hindered") per stat and leave the nature→stat
 * mapping to the caller. This module supplies that mapping for all 25 natures so
 * UI / formula callers don't re-encode standard Pokémon knowledge.
 *
 * Each nature boosts one stat by ×1.1 and hinders another by ×0.9; the five
 * "neutral" natures (Hardy/Docile/Bashful/Quirky/Serious) do neither. HP is
 * never affected by nature.
 */

/** The five stats a nature can modify (HP is never affected). */
export type NatureStat = "atk" | "def" | "spa" | "spd" | "spe";

export type NatureEffect = "boosted" | "neutral" | "hindered";

/** `{ plus, minus }` for each nature slug; both `null` for neutral natures. */
export const NATURE_EFFECTS: Record<
  string,
  { plus: NatureStat | null; minus: NatureStat | null }
> = {
  // Neutral (no net change).
  hardy: { plus: null, minus: null },
  docile: { plus: null, minus: null },
  bashful: { plus: null, minus: null },
  quirky: { plus: null, minus: null },
  serious: { plus: null, minus: null },
  // +Atk
  lonely: { plus: "atk", minus: "def" },
  brave: { plus: "atk", minus: "spe" },
  adamant: { plus: "atk", minus: "spa" },
  naughty: { plus: "atk", minus: "spd" },
  // +Def
  bold: { plus: "def", minus: "atk" },
  relaxed: { plus: "def", minus: "spe" },
  impish: { plus: "def", minus: "spa" },
  lax: { plus: "def", minus: "spd" },
  // +Spe
  timid: { plus: "spe", minus: "atk" },
  hasty: { plus: "spe", minus: "def" },
  jolly: { plus: "spe", minus: "spa" },
  naive: { plus: "spe", minus: "spd" },
  // +SpA
  modest: { plus: "spa", minus: "atk" },
  mild: { plus: "spa", minus: "def" },
  quiet: { plus: "spa", minus: "spe" },
  rash: { plus: "spa", minus: "spd" },
  // +SpD
  calm: { plus: "spd", minus: "atk" },
  gentle: { plus: "spd", minus: "def" },
  sassy: { plus: "spd", minus: "spe" },
  careful: { plus: "spd", minus: "spa" },
};

/**
 * The nature's effect on one stat. Unknown / null natures and HP always resolve
 * to "neutral".
 */
export function natureEffectFor(
  nature: string | null | undefined,
  stat: NatureStat | "hp",
): NatureEffect {
  if (!nature || stat === "hp") return "neutral";
  const effect = NATURE_EFFECTS[nature.toLowerCase()];
  if (!effect) return "neutral";
  if (effect.plus === stat) return "boosted";
  if (effect.minus === stat) return "hindered";
  return "neutral";
}
