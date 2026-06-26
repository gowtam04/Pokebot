/**
 * Unit tests for the LearnsetRepo intersection (BR-7) and learner-count reads.
 *
 * Runs in the Vitest **node** project against a fresh, migrated Postgres schema
 * (Testcontainers, no live PokeAPI, no LLM). The repo is driven through a real
 * node-postgres Drizzle handle — the same handle type the runtime threads in.
 * Reads are non-mutating, so the schema is migrated + seeded once per file.
 *
 * Since the @pkmn migration the learnset table is scoped by a `format`
 * discriminator (replacing the old per-version-group rows); both repo functions
 * take the active format and must never read across formats.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PokebotDb } from "@/data/db";
import { learnset } from "@/data/schema";

import { createPgSchema, type PgFixture } from "../../../test/support/pg";
import { gen9LearnerCount, pokemonLearningAll } from "./learnset-repo";

const SV = "scarlet-violet";
const CH = "champions";

type Row = {
  pokemon_id: string;
  move_slug: string;
  format: string;
  method: string | null;
};

const SEED: Row[] = [
  // garchomp learns earthquake + dragon-claw + fire-blast (SV)
  { pokemon_id: "garchomp", move_slug: "earthquake", format: SV, method: "machine" },
  { pokemon_id: "garchomp", move_slug: "dragon-claw", format: SV, method: "level-up" },
  { pokemon_id: "garchomp", move_slug: "fire-blast", format: SV, method: "machine" },
  // tyranitar learns earthquake + dragon-claw (SV)
  { pokemon_id: "tyranitar", move_slug: "earthquake", format: SV, method: "machine" },
  { pokemon_id: "tyranitar", move_slug: "dragon-claw", format: SV, method: "tutor" },
  // gible learns earthquake only (SV)
  { pokemon_id: "gible", move_slug: "earthquake", format: SV, method: "level-up" },
  // champions-only mon learns earthquake ONLY in the champions format
  { pokemon_id: "champonly", move_slug: "earthquake", format: CH, method: "machine" },
  // will-o-wisp learners (SV)
  { pokemon_id: "rotom", move_slug: "will-o-wisp", format: SV, method: "machine" },
  { pokemon_id: "ninetales", move_slug: "will-o-wisp", format: SV, method: "level-up" },
];

let fix: PgFixture;
let db: PokebotDb;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  db = fix.db;
  await db.insert(learnset).values(SEED);
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

describe("pokemonLearningAll (BR-7 intersection)", () => {
  it("returns only Pokémon that learn ALL requested moves", async () => {
    expect(
      await pokemonLearningAll(["earthquake", "dragon-claw"], SV, db),
    ).toEqual(["garchomp", "tyranitar"]);
  });

  it("returns all learners for a single move", async () => {
    expect(await pokemonLearningAll(["earthquake"], SV, db)).toEqual([
      "garchomp",
      "gible",
      "tyranitar",
    ]);
  });

  it("requires the FULL set — a mon missing one move is excluded", async () => {
    // gible learns earthquake but not fire-blast, so the 3-move set yields only garchomp
    expect(
      await pokemonLearningAll(
        ["earthquake", "dragon-claw", "fire-blast"],
        SV,
        db,
      ),
    ).toEqual(["garchomp"]);
  });

  it("returns a sorted, deterministic list", async () => {
    const result = await pokemonLearningAll(["earthquake"], SV, db);
    expect(result).toEqual([...result].sort());
  });

  it("scopes by format — a champions-only learner is excluded for SV", async () => {
    expect(await pokemonLearningAll(["earthquake"], SV, db)).not.toContain(
      "champonly",
    );
  });

  it("returns only the requested format's learners", async () => {
    // earthquake is learned by champonly (champions) and by three SV mons; the
    // champions query must see ONLY champonly.
    expect(await pokemonLearningAll(["earthquake"], CH, db)).toEqual([
      "champonly",
    ]);
  });

  it("de-duplicates requested moves so duplicates do not inflate N", async () => {
    expect(await pokemonLearningAll(["earthquake", "earthquake"], SV, db)).toEqual(
      await pokemonLearningAll(["earthquake"], SV, db),
    );
  });

  it("returns [] for an empty move set (empty intersection)", async () => {
    expect(await pokemonLearningAll([], SV, db)).toEqual([]);
  });

  it("returns [] when no Pokémon learns the move", async () => {
    expect(await pokemonLearningAll(["does-not-exist"], SV, db)).toEqual([]);
  });

  it("returns [] when no Pokémon learns the full combination", async () => {
    // gible only knows earthquake; pairing with will-o-wisp matches nobody
    expect(
      await pokemonLearningAll(["earthquake", "will-o-wisp"], SV, db),
    ).toEqual([]);
  });
});

describe("gen9LearnerCount", () => {
  it("counts distinct learners of a move within the format", async () => {
    // rotom + ninetales (SV) => 2 distinct Pokémon
    expect(await gen9LearnerCount("will-o-wisp", SV, db)).toBe(2);
  });

  it("counts every distinct learner of a move in the requested format", async () => {
    // garchomp, tyranitar, gible (SV) => 3 (champonly is champions, excluded)
    expect(await gen9LearnerCount("earthquake", SV, db)).toBe(3);
  });

  it("is scoped by format (champions earthquake learners = 1)", async () => {
    expect(await gen9LearnerCount("earthquake", CH, db)).toBe(1);
  });

  it("returns 0 for a move nobody learns", async () => {
    expect(await gen9LearnerCount("does-not-exist", SV, db)).toBe(0);
  });
});
