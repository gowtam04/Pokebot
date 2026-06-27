/**
 * Integration tests for the Showdown import/export service (import-export.ts).
 *
 * Run against a REAL throwaway Postgres schema seeded with the `tools` fixture
 * (Testcontainers), so name↔slug resolution exercises the actual
 * `searchable_names` index. Covers:
 *   - clean import: every display name resolves to its slug, defaults filled,
 *     cosmetics preserved (TEAM-US-10),
 *   - resolve-or-clarify: an unresolved species/move/ability/item/nature/tera
 *     becomes an ImportNote with the field left empty / dropped, the rest still
 *     imports — never a wholesale abort (BR-T7, BR-T11, AC-10.2),
 *   - warn-but-allow: an over-cap EV is preserved verbatim, not clamped
 *     (AC-10.3 — legality is validate-team's warn-only concern),
 *   - export round-trips a TeamMember[] back through Showdown text and re-imports
 *     to the same members (AC-11.1/11.2).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PokebotDb } from "@/data/db";
import type { TeamMember } from "@/data/teams/team-schema";

import { exportPaste, importPaste } from "./import-export";
import { createPgSchema, type PgFixture } from "../../../test/support/pg";

const SV = "scarlet-violet" as const;

let fixture: PgFixture;
let db: PokebotDb;

beforeAll(async () => {
  fixture = await createPgSchema({ seed: "tools" });
  db = fixture.db as unknown as PokebotDb;
});

afterAll(async () => {
  await fixture?.cleanup();
});

const evs0 = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const ivs31 = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

describe("importPaste", () => {
  it("resolves every display name to a slug and fills Showdown defaults", async () => {
    const paste = `Chompy (Garchomp) (M) @ Leftovers
Ability: Rough Skin
Shiny: Yes
Level: 50
Tera Type: Dragon
EVs: 252 Atk / 4 Def / 252 Spe
Jolly Nature
IVs: 0 Spe
- Earthquake
- Fake Out`;

    const { members, notes } = await importPaste(paste, SV, db);

    expect(notes).toEqual([]);
    expect(members).toHaveLength(1);
    const m = members[0];
    expect(m.species).toBe("garchomp");
    expect(m.ability).toBe("rough-skin");
    expect(m.item).toBe("leftovers");
    expect(m.nature).toBe("jolly");
    expect(m.tera_type).toBe("dragon");
    expect(m.moves).toEqual(["earthquake", "fake-out"]);
    expect(m.level).toBe(50);
    expect(m.evs).toEqual({ hp: 0, atk: 252, def: 4, spa: 0, spd: 0, spe: 252 });
    expect(m.ivs).toEqual({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 0 });
    // Cosmetics preserved.
    expect(m.nickname).toBe("Chompy");
    expect(m.gender).toBe("M");
    expect(m.shiny).toBe(true);
  });

  it("defaults level/EVs/IVs the Showdown way when omitted", async () => {
    const { members } = await importPaste(
      `Garchomp\nAbility: Rough Skin\n- Earthquake`,
      SV,
      db,
    );
    const m = members[0];
    expect(m.level).toBe(100); // Showdown default when no Level: line
    expect(m.evs).toEqual(evs0);
    expect(m.ivs).toEqual(ivs31);
    expect(m.nature).toBeNull();
    expect(m.item).toBeNull();
    expect(m.tera_type).toBeNull();
  });

  it("leaves an unresolved species empty with a note but imports the rest", async () => {
    const paste = `Notamon @ Leftovers
Ability: Rough Skin
- Earthquake`;
    const { members, notes } = await importPaste(paste, SV, db);

    expect(members).toHaveLength(1);
    expect(members[0].species).toBeNull();
    // The rest of the slot still imports.
    expect(members[0].item).toBe("leftovers");
    expect(members[0].ability).toBe("rough-skin");
    expect(members[0].moves).toEqual(["earthquake"]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ slot: 0, kind: "pokemon", raw: "Notamon" });
    expect(notes[0].resolvedTo).toBeUndefined();
  });

  it("drops an unresolved move with a note but keeps the resolvable ones", async () => {
    const paste = `Garchomp
Ability: Rough Skin
- Earthquake
- Hyper Nonsense
- Fake Out`;
    const { members, notes } = await importPaste(paste, SV, db);

    expect(members[0].moves).toEqual(["earthquake", "fake-out"]);
    const moveNotes = notes.filter((n) => n.kind === "move");
    expect(moveNotes).toHaveLength(1);
    expect(moveNotes[0]).toMatchObject({ slot: 0, raw: "Hyper Nonsense" });
  });

  it("notes an unknown nature and leaves it empty", async () => {
    const { members, notes } = await importPaste(
      `Garchomp\nAbility: Rough Skin\nBogus Nature\n- Earthquake`,
      SV,
      db,
    );
    expect(members[0].nature).toBeNull();
    expect(notes.some((n) => n.kind === "nature" && n.raw === "Bogus")).toBe(true);
  });

  it("preserves over-cap EVs verbatim (warn-but-allow, no clamp)", async () => {
    const { members, notes } = await importPaste(
      `Garchomp\nAbility: Rough Skin\nEVs: 255 Atk\n- Earthquake`,
      SV,
      db,
    );
    expect(members[0].evs.atk).toBe(255); // not clamped to 252
    expect(notes).toEqual([]); // import itself emits no warning — that's validate-team's job
  });

  it("imports multiple members and indexes notes by slot", async () => {
    const paste = `Garchomp\nAbility: Rough Skin\n- Earthquake\n\nNotamon\nAbility: Rough Skin\n- Earthquake`;
    const { members, notes } = await importPaste(paste, SV, db);
    expect(members).toHaveLength(2);
    expect(members[0].species).toBe("garchomp");
    expect(members[1].species).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0].slot).toBe(1);
  });

  it("returns empty members/notes for a blank paste", async () => {
    expect(await importPaste("", SV, db)).toEqual({ members: [], notes: [] });
  });
});

describe("exportPaste", () => {
  it("round-trips members → Showdown text → members", async () => {
    const members: TeamMember[] = [
      {
        species: "garchomp",
        ability: "rough-skin",
        item: "leftovers",
        moves: ["earthquake", "fake-out"],
        nature: "jolly",
        evs: { hp: 0, atk: 252, def: 4, spa: 0, spd: 0, spe: 252 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 0 },
        tera_type: "dragon",
        level: 50,
        nickname: "Chompy",
        gender: "M",
        shiny: true,
      },
    ];

    const text = await exportPaste(members, SV, db);
    expect(text).toContain("Garchomp");
    expect(text).toContain("Rough Skin");
    expect(text).toContain("Leftovers");

    const { members: round, notes } = await importPaste(text, SV, db);
    expect(notes).toEqual([]);
    expect(round).toEqual(members);
  });

  it("exports an empty team to an empty string", async () => {
    expect(await exportPaste([], SV, db)).toBe("");
  });
});
