/**
 * championsbattledata.com network client + in-memory cache (the single
 * integration point for live Pokémon Champions competitive usage — T15
 * `get_usage_stats`).
 *
 * This is the ONLY request-time network call in Oak; every other tool reads the
 * offline `@pkmn` index. championsbattledata.com is a public, keyless,
 * community-maintained API. This module:
 *   - fetches with a short timeout (chained to the request's `AbortSignal`) and a
 *     single retry (no retry on caller-abort or a real 404),
 *   - caches the `/api` index (~24 h) and per-Pokémon usage (~6 h) in process
 *     memory — the cache resets on deploy and a miss simply re-fetches, which is
 *     acceptable for live data and avoids a schema migration,
 *   - resolves an Oak species/display name to the API's form-specific
 *     `saved_name` (index match → `/api/metadata` form fallback → miss), and
 *   - normalizes the API's `rows[]` into typed, rank-sorted usage entries.
 *
 * Plain module (no `server-only` import) so node unit tests can load and mock it.
 * It THROWS only on a transport/parse fault; the tool maps that to the in-domain
 * `upstream_unavailable` shape. A genuine "no such Pokémon" returns `{ found:false }`.
 */

import { env } from "@/env";
import type { UsageEntry, UsageFormat } from "@/agent/schemas";

// --- Tunables --------------------------------------------------------------

/** Index (`/api`) cache lifetime — season + name list change rarely. */
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-Pokémon usage cache lifetime — the site refreshes roughly daily. */
const USAGE_TTL_MS = 6 * 60 * 60 * 1000;
/** Per-request network timeout (Oak is request-time; keep it tight). */
const REQUEST_TIMEOUT_MS = 3500;
/** Max suggestions returned on a name miss. */
const MAX_SUGGESTIONS = 6;
/** Community-data attribution surfaced alongside every answer that uses it. */
export const USAGE_ATTRIBUTION =
  "championsbattledata.com — a community-maintained Pokémon Champions project " +
  "(not affiliated with Nintendo / Game Freak / The Pokémon Company).";

// --- Public result types ---------------------------------------------------

/** Fully-normalized usage for one Pokémon in one format/season. */
export interface UsageData {
  saved_name: string;
  format: UsageFormat;
  /** The season label this snapshot is from (e.g. "Season M-3" or "current"). */
  season: string;
  /** Epoch-ms Oak fetched this snapshot (the API itself carries no timestamp). */
  fetched_at: number;
  moves: UsageEntry[];
  items: UsageEntry[];
  abilities: UsageEntry[];
  natures: UsageEntry[];
  spreads: UsageEntry[];
  teammates: UsageEntry[];
  /** The battle endpoint this came from (for the answer citation). */
  source_url: string;
}

export type UsageLookup =
  | { found: true; data: UsageData }
  | { found: false; suggestions: string[] };

// --- Low-level fetch (timeout + single retry) ------------------------------

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

function baseUrl(): string {
  return env.CHAMPIONSBATTLEDATA_BASE_URL.replace(/\/+$/, "");
}

async function fetchOnce(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** One retry, except when the caller aborted (user Stop) or the resource 404s. */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await fetchOnce(url, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof HttpError && err.status === 404) throw err;
    return await fetchOnce(url, signal);
  }
}

// --- Normalization helpers -------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "90.3%" | 90.3 | "n/a" -> 90.3 | null. */
function parsePct(p: unknown): number | null {
  if (typeof p === "number") return Number.isFinite(p) ? p : null;
  if (typeof p === "string") {
    const m = p.match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

const CATEGORY_TO_KEY: Record<string, keyof CategoryBuckets> = {
  move: "moves",
  item: "items",
  ability: "abilities",
  nature: "natures",
  spread: "spreads",
  teammate: "teammates",
};

interface CategoryBuckets {
  moves: UsageEntry[];
  items: UsageEntry[];
  abilities: UsageEntry[];
  natures: UsageEntry[];
  spreads: UsageEntry[];
  teammates: UsageEntry[];
}

function emptyBuckets(): CategoryBuckets {
  return {
    moves: [],
    items: [],
    abilities: [],
    natures: [],
    spreads: [],
    teammates: [],
  };
}

// --- /api index (cached) ---------------------------------------------------

interface IndexData {
  defaultSeason: string;
  names: string[];
  fetchedAt: number;
}

let indexCache: IndexData | null = null;

function extractNames(pokemon: unknown): string[] {
  if (!Array.isArray(pokemon)) return [];
  const out: string[] = [];
  for (const p of pokemon) {
    if (typeof p === "string") {
      out.push(p);
    } else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const n = o.saved_name ?? o.name ?? o.base_name;
      if (typeof n === "string") out.push(n);
    }
  }
  return out;
}

async function getIndex(now: number, signal?: AbortSignal): Promise<IndexData> {
  if (indexCache && now - indexCache.fetchedAt < INDEX_TTL_MS) return indexCache;
  const raw = (await fetchJson(`${baseUrl()}/api`, signal)) as {
    defaultSeason?: unknown;
    pokemon?: unknown;
  };
  const defaultSeason =
    typeof raw.defaultSeason === "string" ? raw.defaultSeason : "";
  indexCache = {
    defaultSeason,
    names: extractNames(raw.pokemon),
    fetchedAt: now,
  };
  return indexCache;
}

// --- Name resolution (Oak name -> API saved_name) --------------------------

type Resolved =
  | { ok: true; savedName: string }
  | { ok: false; suggestions: string[] };

function suggestFrom(index: IndexData, name: string): string[] {
  const wanted = new Set(normalize(name).split(" ").filter(Boolean));
  if (wanted.size === 0) return [];
  return index.names
    .map((n) => {
      const tokens = new Set(normalize(n).split(" "));
      let score = 0;
      for (const t of wanted) if (tokens.has(t)) score += 1;
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.n);
}

function pickSavedNameFromMetadata(
  meta: unknown,
  requested: string,
): string | null {
  const rows = (meta as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const target = normalize(requested);
  const savedOf = (r: unknown): string | null =>
    r && typeof r === "object" && typeof (r as Record<string, unknown>).saved_name === "string"
      ? ((r as Record<string, unknown>).saved_name as string)
      : null;
  // 1. exact saved_name match
  for (const r of rows) {
    const sn = savedOf(r);
    if (sn && normalize(sn) === target) return sn;
  }
  // 2. base form (empty `form`) when the request is just the base species
  for (const r of rows) {
    const sn = savedOf(r);
    const form = (r as Record<string, unknown>)?.form;
    if (sn && (!form || (typeof form === "string" && form.trim() === ""))) {
      return sn;
    }
  }
  // 3. fall back to the first row that has a saved_name
  for (const r of rows) {
    const sn = savedOf(r);
    if (sn) return sn;
  }
  return null;
}

async function resolveSavedName(
  name: string,
  index: IndexData,
  signal?: AbortSignal,
): Promise<Resolved> {
  const target = normalize(name);
  const wanted = target.split(" ").filter(Boolean);

  // 1. exact normalized match against the index names
  const exact = index.names.find((n) => normalize(n) === target);
  if (exact) return { ok: true, savedName: exact };

  // 1b. token-subset match (handles forms whose saved_name is in the index,
  //     e.g. "paldean tauros aqua breed" ⊆ "Paldean Tauros Aqua Breed").
  if (wanted.length > 0) {
    const subset = index.names.find((n) => {
      const tokens = new Set(normalize(n).split(" "));
      return wanted.every((t) => tokens.has(t));
    });
    if (subset) return { ok: true, savedName: subset };
  }

  // 2. metadata fallback — the endpoint is keyed by base name and lists this
  //    species' forms with their saved_names; pick the matching one.
  try {
    const meta = await fetchJson(
      `${baseUrl()}/api/metadata/${encodeURIComponent(name)}`,
      signal,
    );
    const saved = pickSavedNameFromMetadata(meta, name);
    if (saved) return { ok: true, savedName: saved };
  } catch {
    // ignore — fall through to a miss with suggestions
  }

  return { ok: false, suggestions: suggestFrom(index, name) };
}

// --- Battle data (usage rows) ----------------------------------------------

function apiFormatLabel(format: UsageFormat): string {
  return format === "singles" ? "Singles" : "Doubles";
}

function groupRows(
  raw: unknown,
  savedName: string,
  format: UsageFormat,
  requestedSeason: string,
  sourceUrl: string,
  now: number,
): UsageData {
  const obj = raw as { rows?: unknown; season?: unknown };
  const buckets = emptyBuckets();
  if (Array.isArray(obj.rows)) {
    for (const row of obj.rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const key = typeof r.category === "string" ? CATEGORY_TO_KEY[r.category] : undefined;
      if (!key) continue;
      const name = typeof r.name === "string" ? r.name : null;
      if (!name) continue;
      const rank = typeof r.rank === "number" ? r.rank : Number.MAX_SAFE_INTEGER;
      buckets[key].push({ name, pct: parsePct(r.percentage), rank });
    }
  }
  for (const key of Object.keys(buckets) as (keyof CategoryBuckets)[]) {
    buckets[key].sort((a, b) => a.rank - b.rank);
  }
  const season =
    typeof obj.season === "string" && obj.season
      ? obj.season
      : requestedSeason || "current";
  return { saved_name: savedName, format, season, fetched_at: now, source_url: sourceUrl, ...buckets };
}

// --- Usage cache + public entry point --------------------------------------

interface UsageCacheEntry {
  data: UsageData;
  fetchedAt: number;
}

const usageCache = new Map<string, UsageCacheEntry>();

function usageKey(format: UsageFormat, savedName: string, season: string): string {
  return `${format}:${savedName}:${season}`;
}

export interface GetUsageOpts {
  signal?: AbortSignal;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Fetch live competitive usage for one Pokémon in one format. Resolves the name
 * to the API's `saved_name`, returns cached data when fresh, else fetches and
 * caches. Throws ONLY on a transport/parse fault (the tool maps it to
 * `upstream_unavailable`); an unresolved name or a 404 returns `{ found:false }`.
 */
export async function getUsage(
  name: string,
  format: UsageFormat,
  opts: GetUsageOpts = {},
): Promise<UsageLookup> {
  const now = opts.now ?? Date.now();
  const { signal } = opts;

  const index = await getIndex(now, signal);
  const season = index.defaultSeason; // "" => omit the query, API uses its default

  const resolved = await resolveSavedName(name, index, signal);
  if (!resolved.ok) return { found: false, suggestions: resolved.suggestions };
  const savedName = resolved.savedName;

  const cacheSeason = season || "current";
  const key = usageKey(format, savedName, cacheSeason);
  const cached = usageCache.get(key);
  if (cached && now - cached.fetchedAt < USAGE_TTL_MS) {
    return { found: true, data: cached.data };
  }

  const qs = season ? `?season=${encodeURIComponent(season)}` : "";
  const url = `${baseUrl()}/api/battle/${apiFormatLabel(format)}/${encodeURIComponent(savedName)}${qs}`;

  let data: UsageData;
  try {
    const raw = await fetchJson(url, signal);
    data = groupRows(raw, savedName, format, season, url, now);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { found: false, suggestions: suggestFrom(index, name) };
    }
    throw err; // transport fault -> upstream_unavailable at the tool
  }

  usageCache.set(key, { data, fetchedAt: now });
  return { found: true, data };
}

/** Clear the module-level caches — for tests only. */
export function __resetUsageCachesForTests(): void {
  indexCache = null;
  usageCache.clear();
}
