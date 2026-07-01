/**
 * Unit tests for src/ingest/build-names.ts (@pkmn-backed).
 *
 * After the migration `buildNames(source, pokemonRows)` is synchronous and reads
 * a resolved `FormatSource` (its moves / abilities / items / types collections,
 * already battle-relevant + filtered by the gen-provider) plus the DS-2 Pokémon
 * rows. We pass a minimal hand-built source so the mapping rules are asserted in
 * isolation — no @pkmn, no network.
 *
 * Coverage:
 *   buildNames — five entity kinds, display_name pass-through from the real
 *                @pkmn name (not re-derived from the slug), slug derivation,
 *                format stamping, dedupe
 */

import { describe, expect, it } from "vitest";

import type { Format } from "@/data/formats";
import type { FormatSource } from "@/data/pkmn/gen-provider";
import { buildNames, type NameRow, type PokemonNameSource } from "./build-names";

const SV: Format = "scarlet-violet";

// ---------------------------------------------------------------------------
// Test helpers — a minimal FormatSource (only the fields buildNames reads)
// ---------------------------------------------------------------------------

type NamedEntity = { id: string; name: string };

function fakeSource(p: {
  format: Format;
  moves: NamedEntity[];
  abilities: NamedEntity[];
  items: NamedEntity[];
  types: { name: string }[];
}): FormatSource {
  return {
    format: p.format,
    moves: p.moves,
    abilities: p.abilities,
    items: p.items,
    types: p.types,
    // Unused by buildNames; present so the cast is honest about the shape.
    dex: {},
    roster: [],
    natures: [],
    getLearnset: async () => ({}),
  } as unknown as FormatSource;
}

const SOURCE = fakeSource({
  format: SV,
  moves: [
    { id: "willowisp", name: "Will-O-Wisp" },
    { id: "fakeout", name: "Fake Out" },
    { id: "earthquake", name: "Earthquake" },
  ],
  abilities: [
    { id: "flashfire", name: "Flash Fire" },
    { id: "armortail", name: "Armor Tail" },
    { id: "sapsipper", name: "Sap Sipper" },
  ],
  items: [
    { id: "leftovers", name: "Leftovers" },
    { id: "choiceband", name: "Choice Band" },
  ],
  // The gen-provider already restricts these to the 18 battle types.
  types: [{ name: "Fire" }, { name: "Water" }, { name: "Dragon" }],
});

const POKEMON: PokemonNameSource[] = [
  { id: "garchomp", display_name: "Garchomp" },
  { id: "tauros-paldea-aqua", display_name: "Tauros (Paldean Aqua)" },
  { id: "farigiraf", display_name: "Farigiraf" },
];

// ---------------------------------------------------------------------------
// buildNames
// ---------------------------------------------------------------------------

describe("buildNames — pokemon rows (DS-2 pass-through)", () => {
  const rows = buildNames(SOURCE, POKEMON);
  const pokemonRows = rows.filter((r) => r.kind === "pokemon");

  it("emits one pokemon row per input PokemonRow", () => {
    expect(pokemonRows).toHaveLength(POKEMON.length);
  });

  it("passes display_name through unchanged (not re-derived from the slug)", () => {
    expect(
      pokemonRows.find((r) => r.slug === "tauros-paldea-aqua")?.display_name,
    ).toBe("Tauros (Paldean Aqua)");
    expect(pokemonRows.find((r) => r.slug === "garchomp")?.display_name).toBe(
      "Garchomp",
    );
  });

  it("uses the pokemon id as the slug", () => {
    const slugs = pokemonRows.map((r) => r.slug);
    expect(slugs).toContain("garchomp");
    expect(slugs).toContain("tauros-paldea-aqua");
    expect(slugs).toContain("farigiraf");
  });
});

describe("buildNames — move rows", () => {
  const rows = buildNames(SOURCE, POKEMON);
  const moveRows = rows.filter((r) => r.kind === "move");

  it("emits one move row per source move", () => {
    expect(moveRows).toHaveLength(3);
  });

  it("derives the slug from the id/name and takes the display verbatim from @pkmn's name", () => {
    expect(moveRows.find((r) => r.slug === "will-o-wisp")?.display_name).toBe(
      "Will-O-Wisp",
    );
    expect(moveRows.find((r) => r.slug === "fake-out")?.display_name).toBe(
      "Fake Out",
    );
    expect(moveRows.find((r) => r.slug === "earthquake")?.display_name).toBe(
      "Earthquake",
    );
  });
});

describe("buildNames — ability rows", () => {
  const rows = buildNames(SOURCE, POKEMON);
  const abilityRows = rows.filter((r) => r.kind === "ability");

  it("emits one ability row per source ability with the real @pkmn display name", () => {
    expect(abilityRows).toHaveLength(3);
    expect(abilityRows.find((r) => r.slug === "armor-tail")?.display_name).toBe(
      "Armor Tail",
    );
    expect(abilityRows.find((r) => r.slug === "flash-fire")?.display_name).toBe(
      "Flash Fire",
    );
  });
});

describe("buildNames — type rows", () => {
  const rows = buildNames(SOURCE, POKEMON);
  const typeRows = rows.filter((r) => r.kind === "type");

  it("maps each provided battle type (gen-provider already excludes pseudo-types)", () => {
    expect(typeRows).toHaveLength(3);
    expect(typeRows.find((r) => r.slug === "fire")?.display_name).toBe("Fire");
    expect(typeRows.find((r) => r.slug === "water")?.display_name).toBe("Water");
    expect(typeRows.find((r) => r.slug === "dragon")?.display_name).toBe(
      "Dragon",
    );
  });
});

describe("buildNames — item rows", () => {
  const rows = buildNames(SOURCE, POKEMON);
  const itemRows = rows.filter((r) => r.kind === "item");

  it("emits one item row per source item with the real @pkmn display name", () => {
    expect(itemRows).toHaveLength(2);
    expect(itemRows.find((r) => r.slug === "leftovers")?.display_name).toBe(
      "Leftovers",
    );
    expect(itemRows.find((r) => r.slug === "choice-band")?.display_name).toBe(
      "Choice Band",
    );
  });
});

describe("buildNames — overall structure", () => {
  const rows = buildNames(SOURCE, POKEMON);

  it("covers all five entity kinds", () => {
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds).toEqual(
      new Set(["pokemon", "move", "ability", "type", "item"]),
    );
  });

  it("stamps the source format on every row", () => {
    expect(rows.every((r) => r.format === SV)).toBe(true);
  });

  it("returns the correct total row count across all kinds", () => {
    const expected = POKEMON.length + 3 + 3 + 3 + 2; // pokemon + move + ability + type + item
    expect(rows).toHaveLength(expected);
  });

  it("every row satisfies the searchable_names shape", () => {
    const validKinds: NameRow["kind"][] = [
      "pokemon",
      "move",
      "ability",
      "type",
      "item",
    ];
    for (const row of rows) {
      expect(validKinds).toContain(row.kind);
      expect(row.slug.length).toBeGreaterThan(0);
      expect(row.display_name.length).toBeGreaterThan(0);
    }
  });

  it("dedupes by (kind, slug) — a duplicate move id collapses to one row", () => {
    const dupeSource = fakeSource({
      format: SV,
      moves: [
        { id: "tackle", name: "Tackle" },
        { id: "tackle2", name: "Tackle" }, // same slugged name → same slug
      ],
      abilities: [],
      items: [],
      types: [],
    });
    const rows = buildNames(dupeSource, []);
    expect(rows.filter((r) => r.kind === "move")).toHaveLength(1);
  });

  it("handles an empty pokemon list without error", () => {
    const rows = buildNames(SOURCE, []);
    expect(rows.filter((r) => r.kind === "pokemon")).toHaveLength(0);
    expect(rows.filter((r) => r.kind === "move").length).toBeGreaterThan(0);
  });
});
