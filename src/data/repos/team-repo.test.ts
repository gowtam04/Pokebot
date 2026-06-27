/**
 * Oracle tests for src/data/repos/team-repo.ts — the sole Postgres reader/writer
 * for saved teams (docs/features/team-builder § Phase 2). Asserts behaviour
 * against a real migrated Postgres schema (Testcontainers).
 *
 * Like conversation-repo.test.ts the repo reads the `@/data/db` SINGLETON, so the
 * harness installs the fixture as the singleton BEFORE the first dynamic import
 * of the repo, and `server-only` is neutralised under the vitest node env.
 *
 * Account isolation (BR-T2) is asserted explicitly: every read/write is
 * account-scoped and a different account sees null/[] / a no-op (never a 403).
 */

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

import { conversation } from "@/data/schema";
import type { TeamMember } from "@/data/teams/team-schema";

type Repo = typeof import("./team-repo");

let fix: PgFixture;
let repo: Repo;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  repo = await import("./team-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE team, conversation, conversation_message RESTART IDENTITY`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCT_A = "account-a";
const ACCT_B = "account-b";
const SV = "scarlet-violet";
const CH = "champions";

const ZERO_SPREAD = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

/** A fully-built member (species + 4 moves) — counts as "complete". */
function fullMember(species: string): TeamMember {
  return {
    species,
    ability: "intimidate",
    item: "leftovers",
    moves: ["earthquake", "rock-slide", "protect", "stealth-rock"],
    nature: "adamant",
    evs: { ...ZERO_SPREAD, atk: 252, spe: 252, hp: 4 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: "ground",
    level: 50,
  };
}

/** An empty slot (no species, no moves) — partial. */
function emptyMember(): TeamMember {
  return {
    species: null,
    ability: null,
    item: null,
    moves: [],
    nature: null,
    evs: { ...ZERO_SPREAD },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: null,
    level: 50,
  };
}

function sixComplete(): TeamMember[] {
  return [
    "garchomp",
    "rotom-wash",
    "amoonguss",
    "great-tusk",
    "iron-hands",
    "flutter-mane",
  ].map(fullMember);
}

// ---------------------------------------------------------------------------
// createTeam + getTeam — JSON round-trip, camelCase mapping (TEAM-US-1, TEAM-US-3)
// ---------------------------------------------------------------------------

describe("createTeam + getTeam", () => {
  it("round-trips the members JSON and maps snake_case → camelCase", async () => {
    const members = [fullMember("garchomp"), emptyMember()];
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "My Team",
      members,
      now: 1000,
    });

    expect(created).toMatchObject({
      accountId: ACCT_A,
      format: SV,
      name: "My Team",
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(created.id).toBeTruthy();

    const fetched = await repo.getTeam(ACCT_A, created.id);
    expect(fetched).toEqual(created);
    // Deep round-trip of a member (nested EV/IV spreads + moves array).
    expect(fetched?.members[0]).toEqual(members[0]);
    expect(fetched?.members[1].species).toBeNull();
  });

  it("accepts an empty (0-member) team (BR-T4)", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: CH,
      name: "Untitled team",
      members: [],
      now: 1000,
    });
    const fetched = await repo.getTeam(ACCT_A, created.id);
    expect(fetched?.members).toEqual([]);
  });

  it("getTeam returns null for a missing id", async () => {
    expect(await repo.getTeam(ACCT_A, "no-such-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTeams — ordering, format filter, completeness summary (TEAM-US-4)
// ---------------------------------------------------------------------------

describe("listTeams", () => {
  it("orders most-recently-edited first and projects a cheap summary", async () => {
    const older = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "older",
      members: sixComplete(),
      now: 1000,
    });
    const newer = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "newer",
      members: [fullMember("garchomp"), emptyMember()],
      now: 2000,
    });

    const list = await repo.listTeams(ACCT_A);
    expect(list.map((t) => t.name)).toEqual(["newer", "older"]);

    const newerSummary = list.find((t) => t.id === newer.id)!;
    expect(newerSummary).toMatchObject({
      memberCount: 2,
      incomplete: true, // <6 members
      updatedAt: 2000,
    });
    const olderSummary = list.find((t) => t.id === older.id)!;
    expect(olderSummary).toMatchObject({ memberCount: 6, incomplete: false });
  });

  it("flags incomplete when a member is missing species or a 4th move", async () => {
    // Six members but one has only 3 moves → incomplete.
    const members = sixComplete();
    members[3] = { ...members[3], moves: ["earthquake", "protect", "rock-slide"] };
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "three-move-mon",
      members,
      now: 1000,
    });
    const summary = (await repo.listTeams(ACCT_A)).find((t) => t.id === created.id)!;
    expect(summary).toMatchObject({ memberCount: 6, incomplete: true });
  });

  it("filters by format", async () => {
    await repo.createTeam({ accountId: ACCT_A, format: SV, name: "sv", members: [], now: 1000 });
    await repo.createTeam({ accountId: ACCT_A, format: CH, name: "ch", members: [], now: 2000 });

    expect((await repo.listTeams(ACCT_A, { format: SV })).map((t) => t.name)).toEqual(["sv"]);
    expect((await repo.listTeams(ACCT_A, { format: CH })).map((t) => t.name)).toEqual(["ch"]);
  });
});

// ---------------------------------------------------------------------------
// updateTeam — replace name/members, bump updated_at (TEAM-US-2)
// ---------------------------------------------------------------------------

describe("updateTeam", () => {
  it("replaces name + members and bumps updated_at", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "before",
      members: [emptyMember()],
      now: 1000,
    });

    const newMembers = [fullMember("garchomp")];
    const updated = await repo.updateTeam({
      accountId: ACCT_A,
      id: created.id,
      name: "after",
      members: newMembers,
      now: 2000,
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: "after",
      format: SV, // unchanged (fixed for life, BR-T3)
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(updated?.members).toEqual(newMembers);
  });

  it("supports a partial update (name only — members preserved)", async () => {
    const members = [fullMember("garchomp")];
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "before",
      members,
      now: 1000,
    });
    const updated = await repo.updateTeam({
      accountId: ACCT_A,
      id: created.id,
      name: "renamed",
      now: 2000,
    });
    expect(updated?.name).toBe("renamed");
    expect(updated?.members).toEqual(members); // unchanged
  });

  it("returns null for a missing / not-owned team (no-op)", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "A's",
      members: [],
      now: 1000,
    });
    expect(
      await repo.updateTeam({ accountId: ACCT_B, id: created.id, name: "hijack", now: 2000 }),
    ).toBeNull();
    // A's team untouched.
    expect((await repo.getTeam(ACCT_A, created.id))?.name).toBe("A's");
  });
});

// ---------------------------------------------------------------------------
// duplicateTeam — independent clone (AC-4.2)
// ---------------------------------------------------------------------------

describe("duplicateTeam", () => {
  it('clones members into a new "<name> copy" team that is independent', async () => {
    const original = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "Rain",
      members: [fullMember("garchomp")],
      now: 1000,
    });

    const copy = await repo.duplicateTeam(ACCT_A, original.id, 2000);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(original.id);
    expect(copy!.name).toBe("Rain copy");
    expect(copy!.format).toBe(SV);
    expect(copy!.members).toEqual(original.members);

    // Editing the copy does not touch the original (independent thereafter).
    await repo.updateTeam({
      accountId: ACCT_A,
      id: copy!.id,
      members: [fullMember("dragonite")],
      now: 3000,
    });
    expect((await repo.getTeam(ACCT_A, original.id))?.members[0].species).toBe("garchomp");
    expect((await repo.getTeam(ACCT_A, copy!.id))?.members[0].species).toBe("dragonite");
  });

  it("returns null for a missing / not-owned source", async () => {
    const original = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "A's",
      members: [],
      now: 1000,
    });
    expect(await repo.duplicateTeam(ACCT_B, original.id, 2000)).toBeNull();
    expect(await repo.duplicateTeam(ACCT_A, "no-such-id", 2000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteTeam — permanent, scoped, nulls active refs (TEAM-US-4, BR-T10)
// ---------------------------------------------------------------------------

describe("deleteTeam", () => {
  it("removes the team", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "doomed",
      members: [],
      now: 1000,
    });
    await repo.deleteTeam(ACCT_A, created.id);
    expect(await repo.getTeam(ACCT_A, created.id)).toBeNull();
  });

  it("nulls conversation.active_team_id references in the same tx (BR-T10)", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "active",
      members: [],
      now: 1000,
    });
    // Conversation referencing the team (this account) + one referencing nothing.
    const convId = randomUUID();
    await fix.db.insert(conversation).values({
      id: convId,
      account_id: ACCT_A,
      title: "t",
      format: SV,
      pinned: 0,
      created_at: 1000,
      updated_at: 1000,
      active_team_id: created.id,
    });

    await repo.deleteTeam(ACCT_A, created.id);

    const rows = await fix.db
      .select({ activeTeamId: conversation.active_team_id })
      .from(conversation)
      .where(eq(conversation.id, convId));
    expect(rows[0].activeTeamId).toBeNull();
  });

  it("is idempotent (deleting an absent id is a no-op)", async () => {
    await expect(repo.deleteTeam(ACCT_A, "no-such-id")).resolves.toBeUndefined();
  });

  it("does not delete another account's team", async () => {
    const created = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "A's",
      members: [],
      now: 1000,
    });
    await repo.deleteTeam(ACCT_B, created.id); // wrong account → no-op
    expect(await repo.getTeam(ACCT_A, created.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Account isolation (BR-T2) — cross-account is a miss, never a 403
// ---------------------------------------------------------------------------

describe("account isolation", () => {
  it("getTeam / listTeams only see the asking account's teams", async () => {
    const a = await repo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "A1",
      members: [],
      now: 1000,
    });
    await repo.createTeam({ accountId: ACCT_B, format: SV, name: "B1", members: [], now: 1000 });

    expect(await repo.getTeam(ACCT_B, a.id)).toBeNull();
    expect((await repo.listTeams(ACCT_A)).map((t) => t.name)).toEqual(["A1"]);
    expect((await repo.listTeams(ACCT_B)).map((t) => t.name)).toEqual(["B1"]);
  });
});
