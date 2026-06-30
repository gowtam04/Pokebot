/**
 * DS-2 Pokédex index builder — @pkmn-backed.
 *
 * Exports:
 *   PokemonRow      — interface mirroring the `pokemon` table columns exactly.
 *   buildPokemonRow — pure transform from an @pkmn Specie + format → PokemonRow.
 *   buildPokedex    — applies the D8 forms rule over a FormatSource roster.
 *
 * Rules enforced:
 *   D8  — each battle-relevant form is a distinct row; purely cosmetic forms
 *         (identical type/stats/abilities to the base form) are collapsed.
 *   BR-1 — is_gen9_native / source_generation reflect whether the species is
 *         native to the format's game. In Champions every indexed species is
 *         legal ⇒ is_gen9_native = 1, source_generation = null.
 */

import type { Format } from "@/data/formats";
import { CHAMPIONS_FORMAT } from "@/data/formats";
import {
  slugFor,
  slugify,
  type FormatSource,
  type PkmnSpecies,
} from "@/data/pkmn/gen-provider";

// ---------------------------------------------------------------------------
// PokemonRow — mirrors the `pokemon` table columns in src/data/schema.ts
// ---------------------------------------------------------------------------

export interface PokemonRow {
  /** Data scope ("scarlet-violet" | "champions"). */
  format: Format;
  /** PokeAPI-style pokemon slug, e.g. "tauros-paldea-aqua". */
  id: string;
  /** Species slug, e.g. "tauros". */
  species_name: string;
  /** Form suffix, e.g. "paldea-aqua"; null for the base form. */
  form_name: string | null;
  /** Human-readable label, e.g. "Tauros (Paldea-Aqua)". */
  display_name: string;
  national_dex_number: number;
  type1: string;
  type2: string | null;
  ability_slot1: string;
  ability_slot2: string | null;
  ability_hidden: string | null;
  stat_hp: number;
  stat_attack: number;
  stat_defense: number;
  stat_special_attack: number;
  stat_special_defense: number;
  stat_speed: number;
  base_stat_total: number;
  sprite_url: string;
  artwork_url: string;
  /** "gen-9" (standard) / "champions". */
  generation: string;
  /** 1 if native to the format's game; 0 if an earlier-gen fallback (BR-1). */
  is_gen9_native: 0 | 1;
  /** Set when is_gen9_native = 0, e.g. "gen-8" (BR-1); null otherwise. */
  source_generation: string | null;
}

// ---------------------------------------------------------------------------
// Display-name helpers (preserve the legacy "Base (Forme)" style)
// ---------------------------------------------------------------------------

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join("-");
}

function makeDisplayName(speciesSlug: string, formSlug: string | null): string {
  if (formSlug === null) return titleCase(speciesSlug);
  return `${titleCase(speciesSlug)} (${titleCase(formSlug)})`;
}

// ---------------------------------------------------------------------------
// Sprite URLs — derived from the national dex number (PokeAPI sprite CDN).
// Per-forme art is not available from @pkmn; forms show base-species art (v1).
// ---------------------------------------------------------------------------

const SPRITE_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

function spriteUrl(num: number): string {
  return `${SPRITE_BASE}/${num}.png`;
}
function artworkUrl(num: number): string {
  return `${SPRITE_BASE}/other/official-artwork/${num}.png`;
}

// ---------------------------------------------------------------------------
// buildPokemonRow — pure transform from an @pkmn Specie
// ---------------------------------------------------------------------------

export function buildPokemonRow(s: PkmnSpecies, format: Format): PokemonRow {
  const id = slugFor(s.id, s.name);
  const species_name = slugify(s.baseSpecies || s.name);
  const form_name = s.forme ? slugify(s.forme) : null;

  const types = s.types ?? [];
  const type1 = types[0] ? slugify(types[0]) : "normal";
  const type2 = types[1] ? slugify(types[1]) : null;

  const abilities = (s.abilities ?? {}) as unknown as Record<string, string>;
  const ability_slot1 = abilities["0"] ? slugify(abilities["0"]) : "none";
  const ability_slot2 = abilities["1"] ? slugify(abilities["1"]) : null;
  const ability_hidden = abilities["H"] ? slugify(abilities["H"]) : null;

  const bs = s.baseStats;
  const stat_hp = bs.hp;
  const stat_attack = bs.atk;
  const stat_defense = bs.def;
  const stat_special_attack = bs.spa;
  const stat_special_defense = bs.spd;
  const stat_speed = bs.spe;
  const base_stat_total =
    stat_hp +
    stat_attack +
    stat_defense +
    stat_special_attack +
    stat_special_defense +
    stat_speed;

  const champions = format === CHAMPIONS_FORMAT;
  const native = champions ? true : !s.isNonstandard;

  return {
    format,
    id,
    species_name,
    form_name,
    display_name: makeDisplayName(species_name, form_name),
    national_dex_number: s.num,
    type1,
    type2,
    ability_slot1,
    ability_slot2,
    ability_hidden,
    stat_hp,
    stat_attack,
    stat_defense,
    stat_special_attack,
    stat_special_defense,
    stat_speed,
    base_stat_total,
    sprite_url: spriteUrl(s.num),
    artwork_url: artworkUrl(s.num),
    generation: champions ? "champions" : "gen-9",
    is_gen9_native: native ? 1 : 0,
    source_generation: native ? null : `gen-${s.gen}`,
  };
}

// ---------------------------------------------------------------------------
// D8 forms rule
// ---------------------------------------------------------------------------

/** True when a non-base form differs from its base in type/stats/abilities. */
function isBattleRelevant(form: PokemonRow, base: PokemonRow): boolean {
  if (form.type1 !== base.type1 || form.type2 !== base.type2) return true;
  if (
    form.stat_hp !== base.stat_hp ||
    form.stat_attack !== base.stat_attack ||
    form.stat_defense !== base.stat_defense ||
    form.stat_special_attack !== base.stat_special_attack ||
    form.stat_special_defense !== base.stat_special_defense ||
    form.stat_speed !== base.stat_speed
  )
    return true;
  if (
    form.ability_slot1 !== base.ability_slot1 ||
    form.ability_slot2 !== base.ability_slot2 ||
    form.ability_hidden !== base.ability_hidden
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// buildPokedex — map a FormatSource roster → PokemonRow[], applying D8
// ---------------------------------------------------------------------------

/**
 * Build the DS-2 rows for one format. Synchronous + pure over the (already
 * resolved) FormatSource roster — no I/O.
 *
 * Groups species by national dex number; within each group the base form
 * (forme === null) is always kept and non-base forms only when battle-relevant.
 * Species without an obvious base in the group (a stray forme) are kept as-is.
 */
export function buildPokedex(
  source: Pick<FormatSource, "format" | "roster">,
): PokemonRow[] {
  const rows = source.roster.map((s) => buildPokemonRow(s, source.format));

  // Group by national dex number to find each species' base form.
  const byDex = new Map<number, PokemonRow[]>();
  for (const row of rows) {
    const list = byDex.get(row.national_dex_number) ?? [];
    list.push(row);
    byDex.set(row.national_dex_number, list);
  }

  const out: PokemonRow[] = [];
  const seen = new Set<string>(); // dedupe by (format,id)
  for (const list of byDex.values()) {
    const base = list.find((r) => r.form_name === null) ?? null;
    for (const row of list) {
      if (seen.has(row.id)) continue;
      const keep =
        row.form_name === null ||
        base === null ||
        isBattleRelevant(row, base);
      if (keep) {
        out.push(row);
        seen.add(row.id);
      }
    }
  }

  return out;
}
