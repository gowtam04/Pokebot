/**
 * Unit test for buildEncounterRows — exercises the OFFLINE builder against the
 * REAL committed snapshot (src/ingest/data/encounters.json). No DB / no network.
 */

import { describe, expect, it } from "vitest";

import {
  buildEncounterRows,
  ENCOUNTER_COVERAGE_NOTE,
  ENCOUNTER_SOURCE_URL,
} from "@/ingest/build-encounters";
import { STANDARD_FORMAT } from "@/data/formats";

type RosterEntry = { name: string; baseSpecies: string };

// buildEncounterRows only reads `format` + each roster entry's name/baseSpecies.
function fakeSource(
  roster: RosterEntry[],
): Parameters<typeof buildEncounterRows>[0] {
  return {
    format: STANDARD_FORMAT,
    roster,
  } as unknown as Parameters<typeof buildEncounterRows>[0];
}

describe("buildEncounterRows", () => {
  it("emits a grouped, cited payload for a covered species (Togepi)", () => {
    const rows = buildEncounterRows(
      fakeSource([{ name: "Togepi", baseSpecies: "" }]),
      123,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.resource_kind).toBe("encounters");
    expect(r.resource_key).toBe("encounters/togepi");
    expect(r.endpoint_url).toBe(ENCOUNTER_SOURCE_URL);
    expect(r.fetched_at).toBe(123);

    const payload = JSON.parse(r.payload) as {
      found: boolean;
      name: string;
      encounters: { version_group: string; generation: number }[];
      coverage_note: string | null;
    };
    expect(payload.found).toBe(true);
    expect(payload.name).toBe("Togepi");
    expect(payload.encounters.length).toBeGreaterThan(0);
    expect(payload.coverage_note).toBeNull();
    // Snapshot is Gen 1–8 only: no Gen 9 group should ever appear.
    expect(payload.encounters.every((g) => g.generation <= 8)).toBe(true);
  });

  it("emits empty + coverage_note for a Gen-9-only species (Lechonk)", () => {
    const rows = buildEncounterRows(
      fakeSource([{ name: "Lechonk", baseSpecies: "" }]),
      123,
    );
    const payload = JSON.parse(rows[0]!.payload) as {
      encounters: unknown[];
      coverage_note: string | null;
    };
    expect(payload.encounters).toEqual([]);
    expect(payload.coverage_note).toBe(ENCOUNTER_COVERAGE_NOTE);
  });

  it("dedupes formes to one row keyed by base species_name", () => {
    const rows = buildEncounterRows(
      fakeSource([
        { name: "Tauros", baseSpecies: "" },
        { name: "Tauros-Paldea-Aqua", baseSpecies: "Tauros" },
      ]),
      123,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_key).toBe("encounters/tauros");
  });
});
