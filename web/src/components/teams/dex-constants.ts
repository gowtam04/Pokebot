/**
 * dex-constants — small, fixed client-side enumerations for the team builder's
 * pickers (natures, tera/types) plus the nature → stat-effect map.
 *
 * Natures (25) and types (18) are closed sets, so the EntityPicker renders them
 * from these static `PickerOption` lists instead of hitting `/api/search`. The
 * nature effect map is shared by {@link TeamMemberPanel} (to colour the live
 * stat bars) and the nature option hints, so it lives in exactly one place.
 */

import type { StatSpread } from "@/data/teams/team-schema";
import type { Format } from "@/data/formats";

export type SpreadKey = keyof StatSpread; // hp | atk | def | spa | spd | spe

/** The effort/stat-point budget the editor enforces for a format. */
export interface EvBudget {
  /** Total budget shown as "X / total" and used for the over-cap warning. */
  total: number;
  /** Per-stat cap: the slider's `max` and the per-stat over-cap warning. */
  perStat: number;
  /** Slider granularity (Champions stat points move by 1; EVs by 4). */
  step: number;
  /** Hard ceiling for the number input + clamp (SV warn-but-allows up to 255). */
  clampMax: number;
  /** Section heading — "EVs" (SV) vs "Stat Points" (Champions). */
  label: string;
}

/**
 * EV / stat-point budget for the active format. Champions uses a much tighter
 * "Stat Point" budget (66 total, 32 per stat, no 4-EV granularity); Scarlet /
 * Violet uses classic EVs (508 total, 252 per stat, step 4, 255 warn ceiling).
 */
export function evBudgetFor(format: Format): EvBudget {
  if (format === "champions") {
    return { total: 66, perStat: 32, step: 1, clampMax: 32, label: "Stat Points" };
  }
  return { total: 508, perStat: 252, step: 4, clampMax: 255, label: "EVs" };
}

/** One option in a static (non-network) picker. */
export interface PickerOption {
  slug: string;
  display_name: string;
  /** Optional secondary line (e.g. a nature's +/- stat summary). */
  hint?: string;
}

/** Short stat label for nature hints (HP never appears in a nature). */
const STAT_SHORT: Record<SpreadKey, string> = {
  hp: "HP",
  atk: "Atk",
  def: "Def",
  spa: "SpA",
  spd: "SpD",
  spe: "Spe",
};

/** Nature → (boosted, hindered) stat. Neutral natures are absent from the map. */
export const NATURE_EFFECTS: Record<
  string,
  { plus?: SpreadKey; minus?: SpreadKey }
> = {
  lonely: { plus: "atk", minus: "def" },
  brave: { plus: "atk", minus: "spe" },
  adamant: { plus: "atk", minus: "spa" },
  naughty: { plus: "atk", minus: "spd" },
  bold: { plus: "def", minus: "atk" },
  relaxed: { plus: "def", minus: "spe" },
  impish: { plus: "def", minus: "spa" },
  lax: { plus: "def", minus: "spd" },
  timid: { plus: "spe", minus: "atk" },
  hasty: { plus: "spe", minus: "def" },
  jolly: { plus: "spe", minus: "spa" },
  naive: { plus: "spe", minus: "spd" },
  modest: { plus: "spa", minus: "atk" },
  mild: { plus: "spa", minus: "def" },
  quiet: { plus: "spa", minus: "spe" },
  rash: { plus: "spa", minus: "spd" },
  calm: { plus: "spd", minus: "atk" },
  gentle: { plus: "spd", minus: "def" },
  sassy: { plus: "spd", minus: "spe" },
  careful: { plus: "spd", minus: "spa" },
  // hardy / docile / serious / bashful / quirky are neutral (no entry).
};

/** All 25 nature slugs, in the in-game alphabetical order. */
const NATURE_SLUGS = [
  "adamant", "bashful", "bold", "brave", "calm",
  "careful", "docile", "gentle", "hardy", "hasty",
  "impish", "jolly", "lax", "lonely", "mild",
  "modest", "naive", "naughty", "quiet", "quirky",
  "rash", "relaxed", "sassy", "serious", "timid",
];

/** Capitalise a single-token slug ("jolly" → "Jolly"). */
function cap(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Picker options for the 25 natures, each with a +/- stat hint. */
export const NATURE_OPTIONS: PickerOption[] = NATURE_SLUGS.map((slug) => {
  const eff = NATURE_EFFECTS[slug];
  const hint =
    eff?.plus && eff?.minus
      ? `+${STAT_SHORT[eff.plus]} −${STAT_SHORT[eff.minus]}`
      : "Neutral";
  return { slug, display_name: cap(slug), hint };
});

/** The 18 type slugs (also the Tera-type options), in canonical chart order. */
export const TYPE_SLUGS = [
  "normal", "fire", "water", "electric", "grass", "ice",
  "fighting", "poison", "ground", "flying", "psychic", "bug",
  "rock", "ghost", "dragon", "dark", "steel", "fairy",
] as const;

/** Picker options for the 18 types (used by the Tera-type picker). */
export const TYPE_OPTIONS: PickerOption[] = TYPE_SLUGS.map((slug) => ({
  slug,
  display_name: cap(slug),
}));
