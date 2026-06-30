/**
 * src/data/repos/team-repo.ts — the SOLE Postgres reader/writer for saved teams
 * (docs/features/team-builder § Component Design, § Interface Definitions). One
 * table: `team` (one row per saved team; `members` is a whole JSON TEXT column).
 *
 * Boundary rules (CLAUDE.md "repos are the sole Postgres readers"; mirrors
 * conversation-repo.ts):
 *   - `import "server-only"` — never bundled to the client.
 *   - Reads the memoized `@/data/db` singleton directly (not a per-request ctx).
 *   - DB columns are snake_case (Drizzle); returned objects are camelCase. The
 *     `members` array is stored whole as JSON TEXT (JSON.stringify on write;
 *     JSON.parse + validate against `teamMembersSchema` on read — the
 *     reference_cache.payload / conversation_message.answer_json convention).
 *     Epoch-ms timestamps are `bigint` mode "number".
 *
 * Isolation (BR-T2 / BR-A9): EVERY method takes `accountId` and filters by it. A
 * team owned by another account is indistinguishable from a missing one
 * (`null` / `[]` / a no-op write) — never a 403.
 *
 * Error style: not in-domain Result unions — return `null`/`[]`/no-op for a clean
 * miss and let GENUINE faults propagate (a DB error, or a corrupted `members`
 * payload that fails Zod, surfaces as a rejected promise at the route seam).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/data/db";
import { team } from "@/data/schema";
import { teamMembersSchema, type TeamMember } from "@/data/teams/team-schema";

// ---------------------------------------------------------------------------
// Row shapes (camelCase — § Interface Definitions)
// ---------------------------------------------------------------------------

/** A saved team (full members), the unit read/written everywhere. */
export interface Team {
  id: string;
  accountId: string;
  format: string; // "scarlet-violet" | "champions"
  name: string;
  members: TeamMember[];
  createdAt: number;
  updatedAt: number;
}

/** List-view projection — no full members, just a cheap completeness summary. */
export interface TeamSummary {
  id: string;
  name: string;
  format: string;
  memberCount: number;
  /**
   * `members.length < 6` OR any member missing a species / its 4th move. Cheap,
   * computed without index reads (full warnings come from `validateTeam` on the
   * detail path).
   */
  incomplete: boolean;
  /**
   * Species slugs of the team's filled slots (empty slots omitted). Lets a
   * caller match a team by its Pokémon without loading full members — the
   * `list_teams` tool maps these to display names. Order follows the slots.
   */
  species: string[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + validate a stored `members` JSON payload (carry-over invariant). */
function parseMembers(raw: string): TeamMember[] {
  return teamMembersSchema.parse(JSON.parse(raw));
}

/** A partial team is "incomplete": <6 members, or any missing species/4 moves. */
function isIncomplete(members: TeamMember[]): boolean {
  return (
    members.length < 6 ||
    members.some((m) => m.species === null || m.moves.length < 4)
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List an account's teams, most-recently-edited first (ORDER BY updated_at DESC,
 * AC-1.1). `format` filters by exact format (optional). Scoped to `accountId`
 * (BR-T2). Reads the `members` JSON to compute the completeness summary; no
 * index reads.
 */
export async function listTeams(
  accountId: string,
  opts?: { format?: string },
): Promise<TeamSummary[]> {
  const conditions = [eq(team.account_id, accountId)];
  const format = opts?.format?.trim();
  if (format) conditions.push(eq(team.format, format));

  const rows = await db
    .select({
      id: team.id,
      name: team.name,
      format: team.format,
      members: team.members,
      updatedAt: team.updated_at,
    })
    .from(team)
    .where(and(...conditions))
    .orderBy(desc(team.updated_at));

  return rows.map((r) => {
    const members = parseMembers(r.members);
    return {
      id: r.id,
      name: r.name,
      format: r.format,
      memberCount: members.length,
      incomplete: isIncomplete(members),
      species: members
        .map((m) => m.species)
        .filter((s): s is string => s !== null),
      updatedAt: r.updatedAt,
    };
  });
}

/** Get a team (full members), or `null` if missing / not this account's. */
export async function getTeam(
  accountId: string,
  id: string,
): Promise<Team | null> {
  const rows = await db
    .select({
      id: team.id,
      accountId: team.account_id,
      format: team.format,
      name: team.name,
      members: team.members,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
    })
    .from(team)
    .where(and(eq(team.account_id, accountId), eq(team.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, members: parseMembers(row.members) } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a team (TEAM-US-1). The caller supplies `accountId`, `format`, a name
 * (defaulted to "Untitled team" upstream, AC-1.2), the members array (empty /
 * partial allowed, BR-T4), and `now`. Mints a fresh UUID. Returns the new Team.
 */
export async function createTeam(args: {
  accountId: string;
  format: string;
  name: string;
  members: TeamMember[];
  now: number;
}): Promise<Team> {
  const id = randomUUID();
  await db.insert(team).values({
    id,
    account_id: args.accountId,
    format: args.format,
    name: args.name,
    members: JSON.stringify(args.members),
    created_at: args.now,
    updated_at: args.now,
  });
  return {
    id,
    accountId: args.accountId,
    format: args.format,
    name: args.name,
    members: args.members,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * Replace a team's name and/or members (TEAM-US-2; the "apply proposed team onto
 * an existing team" path too). Account-scoped — returns `null` if the team is
 * missing / not owned (no-op). Always bumps `updated_at`. `format` is fixed for
 * the team's life (BR-T3) and is never changed here.
 */
export async function updateTeam(args: {
  accountId: string;
  id: string;
  name?: string;
  members?: TeamMember[];
  now: number;
}): Promise<Team | null> {
  const set: {
    updated_at: number;
    name?: string;
    members?: string;
  } = { updated_at: args.now };
  if (args.name !== undefined) set.name = args.name;
  if (args.members !== undefined) set.members = JSON.stringify(args.members);

  const rows = await db
    .update(team)
    .set(set)
    .where(and(eq(team.account_id, args.accountId), eq(team.id, args.id)))
    .returning({
      id: team.id,
      accountId: team.account_id,
      format: team.format,
      name: team.name,
      members: team.members,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
    });
  const row = rows[0];
  return row ? { ...row, members: parseMembers(row.members) } : null;
}

/**
 * Clone a team's members into a new, independent team named `"<name> copy"`
 * (AC-4.2). Account-scoped — returns `null` if the source is missing / not owned.
 * The copy gets its own id and is fully independent thereafter.
 */
export async function duplicateTeam(
  accountId: string,
  id: string,
  now: number,
): Promise<Team | null> {
  const source = await getTeam(accountId, id);
  if (!source) return null;
  return createTeam({
    accountId,
    format: source.format,
    name: `${source.name} copy`,
    members: source.members,
    now,
  });
}

/**
 * Permanently delete a team (TEAM-US-4), account-scoped. Idempotent: deleting an
 * absent / not-owned id is a no-op. Teams are referenced only by name in chat
 * (looked up live via `list_teams`/`get_team`), so there are no stored FKs to
 * clear on delete.
 */
export async function deleteTeam(accountId: string, id: string): Promise<void> {
  await db
    .delete(team)
    .where(and(eq(team.account_id, accountId), eq(team.id, id)));
}
