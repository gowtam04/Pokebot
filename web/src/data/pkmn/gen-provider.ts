/**
 * gen-provider.ts — the SINGLE @pkmn integration point for the ingest pipeline.
 *
 * After the migration, all index data comes from the @pkmn ecosystem (local npm
 * packages — no network, no throttle, no read-through cache):
 *   - standard (`scarlet-violet`) ← `Dex.forGen(9)`
 *   - champions                   ← `Dex.mod('champions', @pkmn/mods/champions)`
 *
 * The ingest builders consume the `FormatSource` returned by {@link loadFormat}
 * and never import @pkmn directly, so every @pkmn-specific quirk lives here.
 *
 * Verified facts (probed against @pkmn/{dex,mods} 0.10.11):
 *   - The Champions legal roster is NOT `dex.species.all()` (that is the full
 *     ~876 gen-9 set). It lives in the mod's FormatsData: a species is legal iff
 *     its FormatsData entry has a falsy `isNonstandard`. That yields ~314 legal
 *     species including ~76 Megas (restricted legendaries excluded for Reg M-B).
 *   - `Dex.mod` applies the mod's ~259 move + 13 ability overrides, and Mega
 *     species resolve via `modDex.species.get('venusaurmega')`.
 *   - Champions learnsets via `modDex.learnsets.get(id)` are genuinely scoped.
 *   - Move source strings encode gen+method at indexes 0/1 ('9M','9L42','9E'…).
 */

import { Dex, type ModData, type ID } from "@pkmn/dex";

import { type Format, CHAMPIONS_FORMAT } from "@/data/formats";

/** The @pkmn dex flavor we use (gen-scoped or modded — same shape). */
export type PkmnDex = ReturnType<typeof Dex.forGen>;
export type PkmnSpecies = ReturnType<PkmnDex["species"]["get"]>;
export type PkmnMove = ReturnType<PkmnDex["moves"]["get"]>;
export type PkmnAbility = ReturnType<PkmnDex["abilities"]["get"]>;
export type PkmnItem = ReturnType<PkmnDex["items"]["get"]>;
export type PkmnType = ReturnType<PkmnDex["types"]["get"]>;
export type PkmnNature = ReturnType<PkmnDex["natures"]["get"]>;

/**
 * Everything an ingest builder needs for one format, with all @pkmn specifics
 * already resolved.
 */
export interface FormatSource {
  format: Format;
  /** The resolved (gen-scoped or modded) dex. */
  dex: PkmnDex;
  /**
   * Legal, real (existing) roster species for this format — base forms + battle
   * formes (incl. Megas). Cosmetic-forme collapsing (D8) is applied by the
   * caller; this is the pre-collapse legal set.
   */
  roster: PkmnSpecies[];
  /** Champions-legal-or-standard moves (existing, non-CAP). */
  moves: PkmnMove[];
  abilities: PkmnAbility[];
  items: PkmnItem[];
  /** The 18 classic battle types (excludes Stellar / pseudo-types). */
  types: PkmnType[];
  natures: PkmnNature[];
  /** Per-species learnset: `{ moveid: sourceString[] }` (may be empty). */
  getLearnset(speciesId: string): Promise<Record<string, string[]>>;
}

// ---------------------------------------------------------------------------
// slugify — @pkmn display name → PokeAPI-style hyphenated slug
// ---------------------------------------------------------------------------

/**
 * Override map for the handful of names whose generic slugify differs from the
 * legacy PokeAPI slug. Keyed by @pkmn id (lowercased alnum). Extend as the
 * parity check surfaces divergences.
 */
const SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  // (id from @pkmn) : (legacy PokeAPI slug)
  // none needed yet — slugify handles farfetch'd, mr. mime, flabébé, etc.
};

/**
 * Convert an @pkmn display name (e.g. "Will-O-Wisp", "Tauros-Paldea-Aqua",
 * "Farfetch'd", "Flabébé") to the project's legacy PokeAPI-style slug
 * ("will-o-wisp", "tauros-paldea-aqua", "farfetchd", "flabebe").
 *
 * Strips diacritics, drops apostrophes/periods, and collapses any other run of
 * non-alphanumerics to a single hyphen. Keeps PKs / searchable_names / reference
 * keys / citations stable across the PokeAPI→@pkmn migration.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/['.]/g, "") // farfetch'd → farfetchd, mr. → mr
    .replace(/[^a-z0-9]+/g, "-") // any other run → single hyphen
    .replace(/^-+|-+$/g, "");
}

/** Slug for a species/move/etc, applying overrides keyed by @pkmn id. */
export function slugFor(id: string, name: string): string {
  return SLUG_OVERRIDES[id] ?? slugify(name);
}

// ---------------------------------------------------------------------------
// Type filtering
// ---------------------------------------------------------------------------

/**
 * The 18 classic battle types. Excludes "Stellar" (a Gen-9 Tera-only type with
 * no normal defensive chart; absent from the legacy 18-type index and irrelevant
 * to Champions, where Tera is disabled) and any pseudo-types.
 */
const BATTLE_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison",
  "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark",
  "Steel", "Fairy",
]);

// ---------------------------------------------------------------------------
// Roster enumeration
// ---------------------------------------------------------------------------

function isRealSpecies(s: PkmnSpecies): boolean {
  return (
    s.exists &&
    typeof s.num === "number" &&
    s.num > 0 &&
    s.isNonstandard !== "CAP" &&
    s.isNonstandard !== "Custom"
  );
}

/**
 * Standard (Gen 9) roster: the full national-dex view as @pkmn knows it in
 * Gen 9 — real species + battle formes, INCLUDING species not native to SV
 * (`isNonstandard === "Past"`), so standard mode keeps answering about the whole
 * dex with a native/fallback flag (BR-1), matching today's behavior. Native ⟺
 * `isNonstandard` is falsy; otherwise the species is a fallback from `gen-{n}`.
 */
function standardRoster(dex: PkmnDex): PkmnSpecies[] {
  return dex.species.all().filter(isRealSpecies);
}

/**
 * Champions roster: species whose FormatsData entry is legal (falsy
 * `isNonstandard`), resolved against the modded dex. Includes Megas as distinct
 * species. (FormatsData is the legality gate — `dex.species.all()` is NOT.)
 */
function championsRoster(dex: PkmnDex, champData: ModData): PkmnSpecies[] {
  const fd = (champData as { FormatsData?: Record<string, { isNonstandard?: unknown }> })
    .FormatsData;
  if (!fd) return [];
  const out: PkmnSpecies[] = [];
  for (const id of Object.keys(fd)) {
    if (fd[id]?.isNonstandard) continue; // not legal in Champions
    const sp = dex.species.get(id);
    if (sp && sp.exists && sp.baseStats && typeof sp.num === "number" && sp.num > 0) {
      out.push(sp);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// loadFormat
// ---------------------------------------------------------------------------

/**
 * Resolve the @pkmn data source for a format. Async because the Champions mod is
 * dynamically imported (keeps @pkmn/mods out of the standard-mode path).
 */
export async function loadFormat(format: Format): Promise<FormatSource> {
  let dex: PkmnDex;
  let roster: PkmnSpecies[];

  if (format === CHAMPIONS_FORMAT) {
    const champData = (await import("@pkmn/mods/champions")) as unknown as ModData;
    dex = Dex.mod("champions" as ID, champData);
    roster = championsRoster(dex, champData);
  } else {
    dex = Dex.forGen(9);
    roster = standardRoster(dex);
  }

  const types = dex.types.all().filter((t) => BATTLE_TYPE_NAMES.has(t.name));
  const moves = dex.moves.all().filter((m) => m.exists && m.isNonstandard !== "CAP");
  const abilities = dex.abilities
    .all()
    .filter((a) => a.exists && a.isNonstandard !== "CAP" && a.id !== "noability");
  const items = dex.items.all().filter((i) => i.exists && i.isNonstandard !== "CAP");
  const natures = dex.natures.all().filter((n) => n.exists);

  return {
    format,
    dex,
    roster,
    moves,
    abilities,
    items,
    types,
    natures,
    async getLearnset(speciesId: string): Promise<Record<string, string[]>> {
      const ls = await dex.learnsets.get(speciesId);
      const learnset = (ls as { learnset?: Record<string, string[]> } | null)?.learnset;
      return learnset ?? {};
    },
  };
}
