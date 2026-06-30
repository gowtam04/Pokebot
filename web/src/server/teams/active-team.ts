/**
 * active-team — the server-controlled "active team" seam (TEAM-AD-1, BR-T9).
 *
 * Two concerns, both pure compositions of Wave-2 modules:
 *
 *   - `resolveActiveTeam(accountId, teamId, mode, db)` — loads the saved team
 *     (account-scoped, via `team-repo.getTeam`) and returns it ONLY when its
 *     `format` matches the turn's mode (`team.format === formatForMode(mode)`,
 *     BR-T3 / AC-8.3). Guests, a missing id, a not-owned team, or a format
 *     mismatch all yield `null`. The `get_team` tool calls this with a `team_id`
 *     the model got from `list_teams`, so the model can only read a team in the
 *     signed-in account and the turn's format.
 *
 *   - `enrichActiveTeam(team, db)` — the agent-facing VIEW used by the `get_team`
 *     tool. Adds display names (slug → display via the `searchable_names` master
 *     list, the same source `resolve_entity` uses) and computed `validateTeam`
 *     warnings (warn-but-allow, on demand — never stored so they can't go stale,
 *     TEAM-AD-1).
 *
 * Never throws in-domain: a clean miss is `null` (resolve) and a read fault while
 * enriching degrades to "no display name / no warnings" rather than propagating
 * (the tool wraps this and falls back to `{ active: false }` on any fault).
 *
 * Module boundary: this is a server SERVICE (composes server-only repos). Its
 * `EnrichedActiveTeam` type is referenced by `@/agent/schemas` via a type-only
 * import, so importing that shared module never pulls this (or `server-only`)
 * into a client bundle.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { AgentMode } from "@/agent/types";
import type { OakDb } from "@/data/db";
import { formatForMode, type Format } from "@/data/formats";
import { searchable_names } from "@/data/schema";
import type { TeamMember } from "@/data/teams/team-schema";
import { getTeam } from "@/data/repos/team-repo";
import {
  validateTeam,
  type TeamWarning,
} from "@/server/teams/validate-team";

// ---------------------------------------------------------------------------
// resolveActiveTeam — the raw team bound onto AgentContext
// ---------------------------------------------------------------------------

/** The raw active team bound onto {@link AgentContext} (slugs, never display). */
export interface ActiveTeam {
  id: string;
  name: string;
  format: string;
  members: TeamMember[];
}

/**
 * Resolve + authorize a `teamId` (the `team_id` the model passes `get_team`,
 * obtained from `list_teams`) into the loadable team, or `null`.
 *
 * Returns `null` unless ALL hold:
 *   - `teamId` is provided (none → `null`),
 *   - the team exists AND belongs to `accountId` (BR-T2 — not-owned is `null`,
 *     indistinguishable from missing), and
 *   - `team.format === formatForMode(mode)` (BR-T3, AC-8.3 — a team built for the
 *     other scope is NOT loadable when the toggle disagrees).
 */
export async function resolveActiveTeam(
  accountId: string,
  teamId: string | null | undefined,
  mode: AgentMode,
  // Part of the contract (symmetry with enrichActiveTeam), but the read goes
  // through team-repo's @/data/db singleton, so it isn't used here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  db: OakDb,
): Promise<ActiveTeam | null> {
  if (!teamId) return null;

  const team = await getTeam(accountId, teamId);
  if (!team) return null;
  if (team.format !== formatForMode(mode)) return null;

  return {
    id: team.id,
    name: team.name,
    format: team.format,
    members: team.members,
  };
}

// ---------------------------------------------------------------------------
// enrichActiveTeam — the agent-facing view (display names + warnings)
// ---------------------------------------------------------------------------

/**
 * The agent-facing team view (what `get_team` returns). Each slug keeps its raw
 * value AND gains a `*_display` human label; team validity warnings are computed
 * on demand.
 */
export interface EnrichedActiveTeam {
  name: string;
  format: string;
  members: Array<{
    species: string | null;
    species_display: string | null;
    ability: string | null;
    ability_display: string | null;
    item: string | null;
    item_display: string | null;
    moves: string[];
    moves_display: string[];
    nature: string | null;
    evs: Record<string, number>;
    ivs: Record<string, number>;
    tera_type: string | null;
    level: number;
  }>;
  warnings: TeamWarning[];
}

/** searchable_names `kind` for each slug-bearing member field. */
type NameKind = "pokemon" | "ability" | "item" | "move" | "type";

/**
 * Build a `${kind}:${slug}` → display_name map for the given slugs, read once
 * from `searchable_names` (format-scoped). A read fault leaves the map empty →
 * callers fall back to the raw slug (never throws). Shared by `enrichActiveTeam`
 * (one team's member slugs) and the `list_teams` tool (every team's species).
 */
export async function displayNamesFor(
  slugs: Iterable<string>,
  format: string,
  db: OakDb,
): Promise<Map<string, string>> {
  const set = new Set<string>();
  for (const s of slugs) if (s) set.add(s);

  const map = new Map<string, string>();
  if (set.size === 0) return map;

  try {
    const rows = await db
      .select({
        kind: searchable_names.kind,
        slug: searchable_names.slug,
        display_name: searchable_names.display_name,
      })
      .from(searchable_names)
      .where(
        and(
          eq(searchable_names.format, format),
          inArray(searchable_names.slug, [...set]),
        ),
      );
    for (const r of rows) map.set(`${r.kind}:${r.slug}`, r.display_name);
  } catch {
    // Index unavailable — fall back to raw slugs as their own display.
  }
  return map;
}

/**
 * Build a `${kind}:${slug}` → display_name map for every slug referenced by the
 * team (format-scoped). Thin wrapper over {@link displayNamesFor}.
 */
async function loadDisplayNames(
  team: ActiveTeam,
  db: OakDb,
): Promise<Map<string, string>> {
  const slugs = new Set<string>();
  for (const m of team.members) {
    if (m.species) slugs.add(m.species);
    if (m.ability) slugs.add(m.ability);
    if (m.item) slugs.add(m.item);
    if (m.tera_type) slugs.add(m.tera_type);
    for (const move of m.moves) if (move) slugs.add(move);
  }
  return displayNamesFor(slugs, team.format, db);
}

/** Display label for a slug; falls back to the slug, or `null` for an empty field. */
function display(
  names: Map<string, string>,
  kind: NameKind,
  slug: string | null,
): string | null {
  if (slug === null) return null;
  return names.get(`${kind}:${slug}`) ?? slug;
}

/**
 * Enrich a loaded team for the `get_team` tool: add display names (from
 * `searchable_names`) and computed `validateTeam` warnings. Never throws — a
 * validation read fault yields `[]` warnings (validateTeam's own contract), and
 * a names read fault falls back to raw slugs.
 */
export async function enrichActiveTeam(
  team: ActiveTeam,
  db: OakDb,
): Promise<EnrichedActiveTeam> {
  const names = await loadDisplayNames(team, db);

  const members = team.members.map((m) => ({
    species: m.species,
    species_display: display(names, "pokemon", m.species),
    ability: m.ability,
    ability_display: display(names, "ability", m.ability),
    item: m.item,
    item_display: display(names, "item", m.item),
    moves: m.moves,
    moves_display: m.moves.map((mv) => names.get(`move:${mv}`) ?? mv),
    nature: m.nature,
    evs: { ...m.evs },
    ivs: { ...m.ivs },
    tera_type: m.tera_type,
    level: m.level,
  }));

  const warnings = await validateTeam(
    team.members,
    team.format as Format,
    db,
  );

  return { name: team.name, format: team.format, members, warnings };
}
