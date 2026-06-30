/**
 * Extra `reference_cache` rows for the artifact-viewer tests (B-4).
 *
 * The shared "tools" seed (test/fixtures/tools-fixture.ts) carries only
 * type/ground + type/flying reference rows. The entity-profile assembler and the
 * `/api/entity` route also need move / ability / item / type-dragon references to
 * assemble full profiles, so the assembler oracle test and the route integration
 * test both layer these on via the `createPgSchema({ after })` hook.
 *
 * Not a test itself (no `.test.ts` suffix) — a shared seed helper.
 */

import { reference_cache } from "@/data/schema";

import type { PgDb } from "../support/pg";

const SV = "scarlet-violet";

/** Reference payloads keyed by `<kind>/<slug>` (verbatim normalized shapes). */
export const ENTITY_REFERENCE_SEED = [
  {
    resource_key: "type/dragon",
    resource_kind: "type",
    payload: {
      found: true,
      types: ["dragon"],
      offensive: {
        super_effective_against: ["dragon"],
        not_very_effective_against: ["steel"],
        no_effect_against: ["fairy"],
      },
      defensive: {
        weak_to: ["ice", "dragon", "fairy"],
        resists: ["fire", "water", "grass", "electric"],
        immune_to: [],
      },
    },
  },
  {
    resource_key: "move/earthquake",
    resource_kind: "move",
    payload: {
      found: true,
      display_name: "Earthquake",
      type: "ground",
      damage_class: "physical",
      power: 100,
      accuracy: 100,
      pp: 10,
      priority: 0,
      target: "allAdjacent",
      hits_allies: true,
      spread_modifier_doubles: 0.75,
      effect_short: "Hits all adjacent Pokémon.",
      effect_full: "Inflicts regular damage; hits all adjacent Pokémon.",
    },
  },
  {
    resource_key: "move/dragon-claw",
    resource_kind: "move",
    payload: {
      found: true,
      display_name: "Dragon Claw",
      type: "dragon",
      damage_class: "physical",
      power: 80,
      accuracy: 100,
      pp: 15,
      priority: 0,
      target: "selected-pokemon",
      effect_short: "Deals damage.",
      effect_full: "Inflicts regular damage with no additional effect.",
    },
  },
  {
    resource_key: "move/fire-fang",
    resource_kind: "move",
    payload: {
      found: true,
      display_name: "Fire Fang",
      type: "fire",
      damage_class: "physical",
      power: 65,
      accuracy: 95,
      pp: 15,
      priority: 0,
      target: "selected-pokemon",
      effect_short: "May burn or flinch.",
      effect_full: "Has a chance to burn and a chance to flinch the target.",
    },
  },
  {
    resource_key: "ability/rough-skin",
    resource_kind: "ability",
    payload: {
      found: true,
      display_name: "Rough Skin",
      effect_short: "Damages attackers on contact.",
      effect_full: "Damages attacking Pokémon for 1/8 max HP on contact.",
    },
  },
  {
    resource_key: "item/leftovers",
    resource_kind: "item",
    payload: {
      found: true,
      display_name: "Leftovers",
      effect_short: "Restores HP each turn.",
      effect_full: "The holder restores 1/16 max HP at the end of each turn.",
    },
  },
];

/** Insert {@link ENTITY_REFERENCE_SEED} into a freshly-seeded "tools" schema. */
export async function seedEntityRefs(db: PgDb): Promise<void> {
  const now = Date.now();
  await db.insert(reference_cache).values(
    ENTITY_REFERENCE_SEED.map((r) => ({
      format: SV,
      resource_key: r.resource_key,
      resource_kind: r.resource_kind,
      payload: JSON.stringify(r.payload),
      endpoint_url: `https://pokeapi.co/api/v2/${r.resource_key}`,
      fetched_at: now,
    })),
  );
}
