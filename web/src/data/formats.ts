/**
 * Data-scope formats — the discriminator that scopes the index to a game.
 *
 * After the @pkmn migration the SQLite index stores one row-set PER FORMAT
 * (a `format` column on pokemon/learnset/reference_cache/searchable_names and a
 * per-format ingest_meta row). Repos filter by the active format, which is
 * derived from the turn's {@link AgentMode} (server-controlled — see
 * `@/agent/types`). This module holds ONLY pure constants/mappings (no @pkmn or
 * SQLite imports) so it is safe to import from repos, tools, ingest, and tests.
 */

import type { AgentMode } from "@/agent/types";

/**
 * A data scope stored in the index.
 *   "scarlet-violet" — Gen 9 / Scarlet-Violet (standard mode; today's behavior).
 *   "champions"      — Pokémon Champions (current regulation), from the @pkmn
 *                      `champions` mod.
 */
export type Format = "scarlet-violet" | "champions";

/** All formats the ingest builds, in stable order. */
export const FORMATS = ["scarlet-violet", "champions"] as const;

/** Default set of formats `runIngest` builds when none are specified. */
export const DEFAULT_FORMATS: readonly Format[] = FORMATS;

/** The standard (non-Champions) format — today's Gen 9 scope. */
export const STANDARD_FORMAT: Format = "scarlet-violet";

/** The Champions format. */
export const CHAMPIONS_FORMAT: Format = "champions";

/**
 * The regulation the base `champions` @pkmn mod currently tracks (it always
 * tracks the LATEST regulation; bumping `@pkmn/mods` + re-ingesting advances it).
 * Surfaced to users via `generation_basis.note` in Champions answers. Update
 * this one line when the regulation rotates.
 */
export const CHAMPIONS_REGULATION = "Regulation M-B";

/** Map the turn's agent mode to the data format the repos should query. */
export function formatForMode(mode: AgentMode): Format {
  return mode === "champions" ? CHAMPIONS_FORMAT : STANDARD_FORMAT;
}

/**
 * Inverse of {@link formatForMode}: map a stored conversation `format` back to
 * the agent mode. Used when resuming a saved conversation, whose mode is derived
 * from its stored format — never from the request body (BR-H6).
 */
export function modeForFormat(format: Format): AgentMode {
  return format === CHAMPIONS_FORMAT ? "champions" : "standard";
}

/** Type guard for a known format string (e.g. when reading CLI args). */
export function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}
