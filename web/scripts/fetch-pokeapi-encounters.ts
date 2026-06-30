/**
 * scripts/fetch-pokeapi-encounters.ts — the ONLINE PokeAPI encounter crawler.
 *
 * This is the ONE place Oak touches the network. It is run MANUALLY and RARELY
 * (`npm run fetch:encounters`) — NEVER by `npm run ingest`. It crawls PokeAPI's
 * `/pokemon/{id}/encounters` for every standard-roster species, resolves the
 * human location / region / version-group / generation names (cached + throttled
 * per PokeAPI fair-use), and writes a committed offline snapshot to
 * `src/ingest/data/encounters.json`. A human commits that file; the ingest
 * pipeline then reads it via `fs` (see src/ingest/build-encounters.ts) so ingest
 * stays 100% offline + deterministic.
 *
 * IMPORTANT data reality (verified June 2026): PokeAPI's encounter dataset covers
 * Gen 1 → Sword/Shield + Let's Go only. It has NO encounter records for
 * Scarlet/Violet (Gen 9), Legends: Arceus, or BDSP — every Gen-9-only species
 * returns an empty array. Those species are written with `[]` and the consuming
 * tool/prompt surface that gap transparently. The per-version dimension means a
 * future re-crawl auto-absorbs Gen 9 if PokeAPI ever fills it in.
 *
 * Keys: species are keyed by `slugify(baseSpecies||name)` of the standard roster
 * — byte-identical to how src/ingest/build-encounters.ts keys its rows and how
 * the pokemon table stores `species_name`, so the offline build aligns exactly.
 *
 * CLI flags:
 *   --limit=N         crawl only the first N species (smoke-test the crawler)
 *   --concurrency=N   parallel in-flight requests (default 6)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { STANDARD_FORMAT } from "@/data/formats";
import { loadFormat, slugify } from "@/data/pkmn/gen-provider";

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

const API = "https://pokeapi.co/api/v2";
const USER_AGENT =
  "Oak-PokemonAgent/1.0 (offline encounter snapshot builder; contact: oak app)";
const SNAPSHOT_VERSION = 1;
const GAME_SCOPE = "gen1-8 + lets-go";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const OUT_DIR = path.resolve(PROJECT_ROOT, "src", "ingest", "data");
const OUT_FILE = path.resolve(OUT_DIR, "encounters.json");

/** PokeAPI generation slug → integer (for grouping/sorting). */
const GEN_NUM: Readonly<Record<string, number>> = {
  "generation-i": 1,
  "generation-ii": 2,
  "generation-iii": 3,
  "generation-iv": 4,
  "generation-v": 5,
  "generation-vi": 6,
  "generation-vii": 7,
  "generation-viii": 8,
  "generation-ix": 9,
};

// ---------------------------------------------------------------------------
// Snapshot shape — per species, encounters GROUPED by version-group.
//
// PokeAPI returns one record per (version × location × encounter slot), which is
// hugely redundant (paired games like Red/Blue duplicate everything). We group
// by version-group and dedupe identical location entries here so the committed
// snapshot IS the tool's payload shape (build-encounters just wraps it) and the
// file stays small.
// ---------------------------------------------------------------------------

export interface EncounterLocation {
  location_display: string;
  region: string | null;
  method: string;
  min_level: number | null;
  max_level: number | null;
  chance: number | null;
  conditions: string[];
}

export interface EncounterGroup {
  version_group: string;
  generation: number;
  /** The individual game versions in this group that share these encounters. */
  versions: string[];
  locations: EncounterLocation[];
}

/** Internal flat record, collected before grouping. */
interface FlatRecord extends EncounterLocation {
  version: string;
  version_group: string;
  generation: number;
}

interface Snapshot {
  snapshot_version: number;
  generated_at: string;
  source: string;
  game_scope: string;
  species: Record<string, EncounterGroup[]>;
}

// ---------------------------------------------------------------------------
// Minimal PokeAPI response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface NamedRef {
  name: string;
  url: string;
}

interface LocalizedName {
  name: string;
  language: NamedRef;
}

interface EncounterDetail {
  min_level: number | null;
  max_level: number | null;
  condition_values: NamedRef[];
  chance: number | null;
  method: NamedRef;
}

interface VersionDetail {
  max_chance: number;
  version: NamedRef;
  encounter_details: EncounterDetail[];
}

interface LocationAreaEncounter {
  location_area: NamedRef;
  version_details: VersionDetail[];
}

interface LocationAreaResponse {
  name: string;
  names: LocalizedName[];
  location: NamedRef;
}

interface LocationResponse {
  name: string;
  names: LocalizedName[];
  region: NamedRef | null;
}

interface VersionResponse {
  name: string;
  version_group: NamedRef;
}

interface VersionGroupResponse {
  name: string;
  generation: NamedRef;
}

// ---------------------------------------------------------------------------
// HTTP with retry/backoff (polite, fair-use)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET + parse JSON. Returns `null` on a 404 (the caller treats a missing
 * encounter resource as "no data"). Retries transient failures (429 / 5xx /
 * network) with linear backoff; throws only after exhausting retries.
 */
async function getJson<T>(url: string, retries = 4): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Cached lookups (location + version resolve to many shared targets)
// ---------------------------------------------------------------------------

interface LocationInfo {
  display: string;
  region: string | null;
}
interface VersionInfo {
  version_group: string;
  generation: number;
}

const locationCache = new Map<string, Promise<LocationInfo>>();
const versionCache = new Map<string, Promise<VersionInfo>>();

let nameFallbackCount = 0;

function enName(names: LocalizedName[]): string | null {
  return names.find((n) => n.language?.name === "en")?.name ?? null;
}

/** "kanto-route-2" / "route-32-area" → "Kanto Route 2" / "Route 32 Area". */
function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function resolveLocation(area: NamedRef): Promise<LocationInfo> {
  const cached = locationCache.get(area.url);
  if (cached) return cached;
  const p = (async (): Promise<LocationInfo> => {
    const la = await getJson<LocationAreaResponse>(area.url);
    const laEn = la ? enName(la.names) : null;
    let locEn: string | null = null;
    let region: string | null = null;
    let locSlug: string | null = null;
    if (la?.location?.url) {
      const loc = await getJson<LocationResponse>(la.location.url);
      if (loc) {
        locEn = enName(loc.names);
        region = loc.region ? titleCase(loc.region.name) : null;
        locSlug = loc.name;
      }
    }
    // Prefer the parent LOCATION's English name: it's cleaner than the area name
    // (PokeAPI's area en names have quirks like "Road 1" for Route 1) and it
    // collapses sub-areas to one place (e.g. all Mt. Moon floors → "Mt. Moon"),
    // which is the right granularity for a "where do I catch X" answer and shrinks
    // the snapshot. Fall back to the location slug, then the area en name/slug.
    const display =
      locEn ??
      (locSlug ? titleCase(locSlug) : null) ??
      laEn ??
      titleCase(area.name);
    if (!locEn) nameFallbackCount++;
    return { display, region };
  })();
  locationCache.set(area.url, p);
  return p;
}

function resolveVersion(version: NamedRef): Promise<VersionInfo> {
  const cached = versionCache.get(version.name);
  if (cached) return cached;
  const p = (async (): Promise<VersionInfo> => {
    const v = await getJson<VersionResponse>(`${API}/version/${version.name}`);
    const vgName = v?.version_group?.name ?? "";
    let generation = 0;
    if (vgName) {
      const vg = await getJson<VersionGroupResponse>(
        `${API}/version-group/${vgName}`,
      );
      if (vg?.generation?.name) generation = GEN_NUM[vg.generation.name] ?? 0;
    }
    return { version_group: vgName, generation };
  })();
  versionCache.set(version.name, p);
  return p;
}

// ---------------------------------------------------------------------------
// Per-species crawl
// ---------------------------------------------------------------------------

/**
 * Conditions that are pure time-of-day (morning/day/night). PokeAPI emits a
 * separate encounter slot per time-of-day, which triples the data without adding
 * meaning for a "where do I catch X" answer — so we strip them and aggregate.
 * Meaningful conditions (swarm, season, radar, slot2, story) are kept.
 */
function meaningfulConditions(conds: string[]): string[] {
  return conds.filter((c) => !c.startsWith("time-")).sort();
}

const minOpt = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.min(a, b);
const maxOpt = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);

/**
 * Collapse flat per-version, per-slot records into deduped version-group entries.
 * Within a group, all encounters at the same (location, method, meaningful
 * conditions) collapse to ONE entry with the overall level RANGE and the best
 * (max) encounter rate — compact and answer-ready.
 */
function groupRecords(flat: FlatRecord[]): EncounterGroup[] {
  const byGroup = new Map<
    string,
    {
      version_group: string;
      generation: number;
      versions: Set<string>;
      locations: Map<string, EncounterLocation>;
    }
  >();
  for (const r of flat) {
    let g = byGroup.get(r.version_group);
    if (!g) {
      g = {
        version_group: r.version_group,
        generation: r.generation,
        versions: new Set(),
        locations: new Map(),
      };
      byGroup.set(r.version_group, g);
    }
    g.versions.add(r.version);
    const conditions = meaningfulConditions(r.conditions);
    const key = `${r.location_display}|${r.region ?? ""}|${r.method}|${conditions.join(",")}`;
    const existing = g.locations.get(key);
    if (!existing) {
      g.locations.set(key, {
        location_display: r.location_display,
        region: r.region,
        method: r.method,
        min_level: r.min_level,
        max_level: r.max_level,
        chance: r.chance,
        conditions,
      });
    } else {
      existing.min_level = minOpt(existing.min_level, r.min_level);
      existing.max_level = maxOpt(existing.max_level, r.max_level);
      existing.chance = maxOpt(existing.chance, r.chance);
    }
  }
  return [...byGroup.values()]
    .sort(
      (a, b) =>
        a.generation - b.generation ||
        a.version_group.localeCompare(b.version_group),
    )
    .map((g) => ({
      version_group: g.version_group,
      generation: g.generation,
      versions: [...g.versions].sort(),
      locations: [...g.locations.values()].sort(
        (a, b) =>
          a.location_display.localeCompare(b.location_display) ||
          a.method.localeCompare(b.method),
      ),
    }));
}

async function crawlSpecies(slug: string): Promise<EncounterGroup[]> {
  const raw = await getJson<LocationAreaEncounter[]>(
    `${API}/pokemon/${slug}/encounters`,
  );
  if (!raw || raw.length === 0) return [];

  const flat: FlatRecord[] = [];
  for (const entry of raw) {
    const loc = await resolveLocation(entry.location_area);
    for (const vd of entry.version_details) {
      const vinfo = await resolveVersion(vd.version);
      for (const ed of vd.encounter_details) {
        flat.push({
          version: vd.version.name,
          version_group: vinfo.version_group,
          generation: vinfo.generation,
          location_display: loc.display,
          region: loc.region,
          method: ed.method?.name ?? "unknown",
          min_level: ed.min_level,
          max_level: ed.max_level,
          chance: ed.chance,
          conditions: ed.condition_values.map((c) => c.name),
        });
      }
    }
  }
  return groupRecords(flat);
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseIntFlag(argv: string[], flag: string): number | undefined {
  const a = argv.find((x) => x.startsWith(`${flag}=`));
  if (!a) return undefined;
  const n = Number.parseInt(a.slice(flag.length + 1), 10);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = parseIntFlag(argv, "--limit");
  const concurrency = parseIntFlag(argv, "--concurrency") ?? 6;

  console.log(`[encounters] loading standard roster from @pkmn…`);
  const source = await loadFormat(STANDARD_FORMAT);

  // Distinct base-species slugs, in roster order — the exact keyspace the
  // offline builder iterates.
  const speciesSlugs: string[] = [];
  const seen = new Set<string>();
  for (const s of source.roster) {
    const slug = slugify(s.baseSpecies || s.name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    speciesSlugs.push(slug);
  }
  const targets =
    limit && limit > 0 ? speciesSlugs.slice(0, limit) : speciesSlugs;
  console.log(
    `[encounters] ${speciesSlugs.length} distinct species` +
      (limit ? ` (crawling first ${targets.length})` : "") +
      `; concurrency=${concurrency}`,
  );

  const species: Record<string, EncounterGroup[]> = {};
  let done = 0;
  let withData = 0;
  let notFound = 0;

  await runPool(targets, concurrency, async (slug) => {
    try {
      const records = await crawlSpecies(slug);
      species[slug] = records;
      if (records.length > 0) withData++;
    } catch (e) {
      // A hard failure after retries: record empty and keep going (the crawl is
      // resumable by re-running; one species shouldn't abort the whole snapshot).
      species[slug] = [];
      notFound++;
      console.warn(
        `[encounters] FAILED ${slug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    done++;
    if (done % 50 === 0 || done === targets.length) {
      console.log(
        `[encounters] ${done}/${targets.length} (with-data: ${withData})`,
      );
    }
  });

  const snapshot: Snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    generated_at: new Date().toISOString().slice(0, 10),
    source: "pokeapi.co",
    game_scope: GAME_SCOPE,
    // Stable key order so the committed file diffs cleanly between crawls.
    species: Object.fromEntries(
      targets
        .filter((s) => s in species)
        .sort()
        .map((s) => [s, species[s]!]),
    ),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot), "utf8");

  const sizeMb = (fs.statSync(OUT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log(
    `[encounters] wrote ${OUT_FILE} (${sizeMb} MB) — ` +
      `${Object.keys(snapshot.species).length} species, ` +
      `${withData} with encounters, ${notFound} failed, ` +
      `${nameFallbackCount} location-name fallbacks`,
  );
}

main().catch((e: unknown) => {
  console.error(
    `[encounters] crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
});
