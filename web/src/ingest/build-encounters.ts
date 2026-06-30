/**
 * build-encounters.ts — build reference_cache "encounters" rows from the
 * committed PokeAPI snapshot (src/ingest/data/encounters.json).
 *
 * This is the OFFLINE half of the catch-location feature: the network crawl
 * lives in scripts/fetch-pokeapi-encounters.ts (run manually) and writes the
 * snapshot; ingest reads that local file via `fs` so the ingest pipeline stays
 * 100% offline + deterministic. STANDARD MODE ONLY — run.ts calls this builder
 * for the "scarlet-violet" format exclusively (Champions ships no encounter data).
 *
 * One row per distinct standard-roster `species_name` (keyed exactly like the
 * evolution chains in build-reference.ts), so every species resolves: a species
 * the snapshot covers gets its grouped encounters; one it doesn't (Gen-9-only,
 * evolution/trade/event-only) gets an empty list + a coverage_note that the tool
 * and prompt surface transparently. The snapshot's `species` values already ARE
 * the EncounterGroup[] payload shape, so this builder just wraps them.
 *
 * IMPORTANT: imported ONLY by src/ingest/run.ts (the tsx CLI). The request-path
 * encounter-repo.ts reads Postgres, never this module / the JSON — so the
 * multi-MB snapshot never enters the Next bundle.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EncounterDetail, EncounterGroup } from "@/agent/schemas";
import { slugify, type FormatSource } from "@/data/pkmn/gen-provider";

import type { ReferenceRow } from "./build-reference";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(MODULE_DIR, "data", "encounters.json");

/** Citation source for encounter rows (PokeAPI, the only non-@pkmn source). */
export const ENCOUNTER_SOURCE_URL = "https://pokeapi.co";

/** Shown (only) when a species has no recorded encounters in the snapshot. */
export const ENCOUNTER_COVERAGE_NOTE =
  "PokeAPI records no catch/encounter data for this Pokémon. Its encounter " +
  "dataset covers Gen 1 through Sword/Shield (and Let's Go); it has none for " +
  "Scarlet/Violet, Legends: Arceus, or BDSP. This species may instead be " +
  "obtained by evolving a pre-evolution (use get_evolution_chain), breeding, " +
  "in-game trade, or special events.";

interface EncounterSnapshot {
  snapshot_version: number;
  generated_at: string;
  source: string;
  game_scope: string;
  species: Record<string, EncounterGroup[]>;
}

/**
 * Read the committed snapshot. Returns `null` (with a warning) if it's absent —
 * a missing snapshot degrades to "no encounter data" rather than aborting the
 * whole index build. The file is committed, so this is a guard, not a path.
 */
function loadSnapshot(): EncounterSnapshot | null {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.warn(
      `[build-encounters] snapshot missing at ${SNAPSHOT_PATH} — ` +
        `run \`npm run fetch:encounters\`. Building with no encounter data.`,
    );
    return null;
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as EncounterSnapshot;
}

/**
 * Build one "encounters" reference_cache row per distinct roster species_name.
 *
 * @param source the STANDARD FormatSource (run.ts gates this to scarlet-violet).
 * @param now    epoch ms stamped onto each row's `fetched_at`.
 */
export function buildEncounterRows(
  source: Pick<FormatSource, "format" | "roster">,
  now: number,
): ReferenceRow[] {
  const snapshot = loadSnapshot();
  const speciesData = snapshot?.species ?? {};

  const rows: ReferenceRow[] = [];
  const seen = new Set<string>();
  for (const s of source.roster) {
    const species_name = slugify(s.baseSpecies || s.name);
    if (seen.has(species_name)) continue;
    seen.add(species_name);

    const encounters = speciesData[species_name] ?? [];
    const payload: EncounterDetail = {
      found: true,
      name: s.baseSpecies || s.name,
      encounters,
      coverage_note: encounters.length === 0 ? ENCOUNTER_COVERAGE_NOTE : null,
    };
    rows.push({
      format: source.format,
      resource_key: `encounters/${species_name}`,
      resource_kind: "encounters",
      payload: JSON.stringify(payload),
      endpoint_url: ENCOUNTER_SOURCE_URL,
      fetched_at: now,
    });
  }
  return rows;
}
