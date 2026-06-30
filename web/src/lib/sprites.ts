/**
 * sprites — pure, client-safe sprite-URL helpers (no Node / `server-only` /
 * `@pkmn` / React imports). Shared by the ingest builder
 * (`@/ingest/build-pokedex`) and the client `<SpriteImg>` fallback, so the URL
 * patterns live in exactly one place. One of the portable modules in CLAUDE.md.
 *
 * Two sprite sources:
 *   - BASE forms      → PokeAPI sprite CDN, keyed by NATIONAL DEX NUMBER. A base
 *     species' dex number uniquely identifies its art.
 *   - ALTERNATE forms → Pokémon Showdown's animated CDN, keyed by the
 *     form-distinguishing "spriteid". Every alternate form (Mega, regional,
 *     Rotom, …) shares its base species' national dex number, so the dex-number
 *     CDN can't tell a form from its base; the spriteid can. `@pkmn` does NOT
 *     expose `spriteid`, so we recompute it with Showdown's own formula.
 */

const POKEAPI_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

/** PokeAPI front sprite for a national dex number, e.g. 445 → ".../445.png". */
export function pokeApiSprite(num: number): string {
  return `${POKEAPI_BASE}/${num}.png`;
}

/** PokeAPI official artwork for a national dex number. */
export function pokeApiArtwork(num: number): string {
  return `${POKEAPI_BASE}/other/official-artwork/${num}.png`;
}

/**
 * Pokémon Showdown's `toID`: lowercase and strip every non-alphanumeric
 * character. Showdown's data is ASCII, so we fold diacritics first (a no-op for
 * ASCII) — that way names like "Flabébé" / "Farfetch'd" map to the ASCII id the
 * CDN actually uses.
 */
export function toID(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Showdown sprite id for a species/form: `toID(baseSpecies)`, plus `-` +
 * `toID(forme)` for a non-base form.
 *
 * NB this is NOT Oak's `slugify`: `toID` strips a forme's INTERNAL hyphens, so
 * "Charizard" + "Mega-X" → "charizard-megax" (slugify would give
 * "charizard-mega-x", which the CDN 404s). Single-token formes coincide
 * ("Venusaur" + "Mega" → "venusaur-mega"); multi-token ones diverge.
 */
export function showdownSpriteId(
  baseSpecies: string,
  forme: string | null,
): string {
  const base = toID(baseSpecies);
  return forme ? `${base}-${toID(forme)}` : base;
}

/**
 * Animated Showdown sprite URL for a spriteid. The `ani/` directory is the one
 * source that covers every form including the Pokémon Champions Megas (the
 * static `dex/` directory lacks them).
 */
export function showdownAniSprite(spriteId: string): string {
  return `https://play.pokemonshowdown.com/sprites/ani/${spriteId}.gif`;
}
