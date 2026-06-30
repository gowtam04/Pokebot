import { describe, expect, it } from "vitest";

import {
  pokeApiArtwork,
  pokeApiSprite,
  showdownAniSprite,
  showdownSpriteId,
  toID,
} from "./sprites";

describe("sprites — PokeAPI base URLs (national dex number)", () => {
  it("builds the front-sprite + official-artwork URLs", () => {
    expect(pokeApiSprite(445)).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/445.png",
    );
    expect(pokeApiArtwork(445)).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/445.png",
    );
  });
});

describe("sprites — toID (Showdown's strip-everything id)", () => {
  it("strips internal hyphens and punctuation", () => {
    expect(toID("Mega-X")).toBe("megax");
    expect(toID("Rapid-Strike")).toBe("rapidstrike");
    expect(toID("Farfetch'd")).toBe("farfetchd");
  });

  it("folds diacritics to the ASCII id the CDN uses", () => {
    expect(toID("Flabébé")).toBe("flabebe");
  });
});

describe("sprites — showdownSpriteId", () => {
  it("single-token formes keep exactly one hyphen", () => {
    expect(showdownSpriteId("Venusaur", "Mega")).toBe("venusaur-mega");
    expect(showdownSpriteId("Dragonite", "Mega")).toBe("dragonite-mega");
    expect(showdownSpriteId("Rotom", "Wash")).toBe("rotom-wash");
    expect(showdownSpriteId("Ninetales", "Alola")).toBe("ninetales-alola");
  });

  it("multi-token formes collapse internal hyphens (the slugify divergence)", () => {
    expect(showdownSpriteId("Charizard", "Mega-X")).toBe("charizard-megax");
    expect(showdownSpriteId("Charizard", "Mega-Y")).toBe("charizard-megay");
    expect(showdownSpriteId("Tauros", "Paldea-Aqua")).toBe("tauros-paldeaaqua");
    expect(showdownSpriteId("Urshifu", "Rapid-Strike")).toBe(
      "urshifu-rapidstrike",
    );
    expect(showdownSpriteId("Ogerpon", "Wellspring-Tera")).toBe(
      "ogerpon-wellspringtera",
    );
  });

  it("base form (no forme) has no trailing hyphen", () => {
    expect(showdownSpriteId("Dragonite", null)).toBe("dragonite");
  });
});

describe("sprites — showdownAniSprite", () => {
  it("builds the animated Showdown URL", () => {
    expect(showdownAniSprite("dragonite-mega")).toBe(
      "https://play.pokemonshowdown.com/sprites/ani/dragonite-mega.gif",
    );
  });
});
