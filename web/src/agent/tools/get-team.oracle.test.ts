/**
 * INDEPENDENT ORACLE — T12 `get_team` + T16 `list_teams` and the active-team
 * service they wrap (src/server/teams/active-team.ts), exercised against a small
 * deterministic fixture DB (seed "tools").
 *
 * Behaviour derived from the design (§ Agent seam, TEAM-AD-1) — NOT the impl:
 *   - get_team({ team_id }) returns { found: true, team } (display names from
 *     searchable_names + computed validateTeam `warnings`) for an account-owned,
 *     format-matching team, and { found: false } for a guest, an unknown id, a
 *     not-owned team, or a format mismatch (BR-T2, BR-T3, AC-8.3). Never throws.
 *   - list_teams({}) returns { signed_in: false } for a guest, else
 *     { signed_in: true, teams } scoped to the account AND the turn's format,
 *     each team carrying its species DISPLAY names.
 *
 * Wiring (per the RISK DIRECTIVES):
 *   - migrate + seed an isolated Postgres schema (createPgSchema) and install it
 *     as the @/data/db singleton (installAsSingleton) BEFORE importing the
 *     server-only modules — team-repo (createTeam/listTeams) reads the SINGLETON,
 *     while the tool's enrich path reads the bound ctx.db.
 *   - `import "server-only"` is neutralized so the repos/services load under the
 *     vitest node environment.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AgentContext } from "@/agent/types";
import type { OakDb } from "@/data/db";
import type { TeamMember } from "@/data/teams/team-schema";
import type { GetTeamOutput, ListTeamsOutput } from "@/agent/schemas";

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

type Dispatch = (
  name: string,
  args: unknown,
  ctx: AgentContext,
) => Promise<unknown>;

let fix: PgFixture;
let loadError: unknown = null;

let dispatch: Dispatch;
let createAgentContext: typeof import("@/agent/context").createAgentContext;
let createTeam: typeof import("@/data/repos/team-repo").createTeam;

/** A Garchomp set: legal item/ability, but a partial moveset with one move
 *  (will-o-wisp) Garchomp can't learn in the fixture — so the warnings are
 *  deterministic (incomplete + move_not_in_learnset). */
const MEMBER: TeamMember = {
  species: "garchomp",
  ability: "rough-skin",
  item: "leftovers",
  moves: ["earthquake", "will-o-wisp"],
  nature: "jolly",
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "fire",
  level: 50,
};

const ACCOUNT = "acct-1";

beforeAll(async () => {
  try {
    fix = await createPgSchema({ seed: "tools" });
    await installAsSingleton(fix);

    ({ dispatch } = await import("@/agent/tools"));
    ({ createAgentContext } = await import("@/agent/context"));
    ({ createTeam } = await import("@/data/repos/team-repo"));
  } catch (e) {
    loadError = e;
  }
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

function ensureLoaded(): void {
  if (loadError) {
    throw new Error(`Agent/team layer not loadable: ${String(loadError)}`);
  }
}

async function ctxFor(opts: {
  accountId?: string;
  mode?: "standard" | "champions";
}): Promise<AgentContext> {
  return createAgentContext({
    db: fix.db as unknown as OakDb,
    requestId: "oracle",
    accountId: opts.accountId,
    mode: opts.mode ?? "standard",
  });
}

describe("get_team tool (T12)", () => {
  it("returns { found: false } for a guest and for an unknown id, never throwing", async () => {
    ensureLoaded();
    const guest = await ctxFor({});
    expect(await dispatch("get_team", { team_id: "anything" }, guest)).toEqual({
      found: false,
    });

    const signedIn = await ctxFor({ accountId: ACCOUNT });
    expect(
      await dispatch("get_team", { team_id: "does-not-exist" }, signedIn),
    ).toEqual({ found: false });
  });

  it("returns { found: true, team } enriched with display names + warnings", async () => {
    ensureLoaded();
    const created = await createTeam({
      accountId: ACCOUNT,
      format: "scarlet-violet",
      name: "Test Team",
      members: [MEMBER],
      now: Date.now(),
    });

    const ctx = await ctxFor({ accountId: ACCOUNT });
    const out = (await dispatch(
      "get_team",
      { team_id: created.id },
      ctx,
    )) as GetTeamOutput;

    expect(out.found).toBe(true);
    if (!out.found) throw new Error("expected found team");

    expect(out.team.name).toBe("Test Team");
    expect(out.team.format).toBe("scarlet-violet");

    const m = out.team.members[0]!;
    expect(m.species).toBe("garchomp");
    expect(m.species_display).toBe("Garchomp");
    expect(m.ability_display).toBe("Rough Skin");
    expect(m.item_display).toBe("Leftovers");
    expect(m.moves_display).toEqual(["Earthquake", "Will-O-Wisp"]);

    const codes = out.team.warnings.map((w) => w.code);
    expect(codes).toContain("incomplete");
    expect(codes).toContain("move_not_in_learnset");
  });

  it("rejects a not-owned team and a format mismatch (BR-T2 / AC-8.3)", async () => {
    ensureLoaded();
    const created = await createTeam({
      accountId: ACCOUNT,
      format: "scarlet-violet",
      name: "Owned",
      members: [MEMBER],
      now: Date.now(),
    });

    // Another account's id is indistinguishable from missing → not found.
    const other = await ctxFor({ accountId: "other-acct" });
    expect(await dispatch("get_team", { team_id: created.id }, other)).toEqual({
      found: false,
    });

    // Champions mode vs a scarlet-violet team → format-gated out (AC-8.3).
    const champions = await ctxFor({ accountId: ACCOUNT, mode: "champions" });
    expect(
      await dispatch("get_team", { team_id: created.id }, champions),
    ).toEqual({ found: false });
  });
});

describe("list_teams tool (T16)", () => {
  it("returns { signed_in: false } for a guest", async () => {
    ensureLoaded();
    const guest = await ctxFor({});
    expect(await dispatch("list_teams", {}, guest)).toEqual({
      signed_in: false,
    });
  });

  it("lists the account's teams for the format, with species display names", async () => {
    ensureLoaded();
    const account = "acct-list";
    await createTeam({
      accountId: account,
      format: "scarlet-violet",
      name: "Rain Offense",
      members: [MEMBER],
      now: Date.now(),
    });
    // A Champions team for the SAME account must NOT appear in standard mode.
    await createTeam({
      accountId: account,
      format: "champions",
      name: "Champs Squad",
      members: [MEMBER],
      now: Date.now(),
    });

    const ctx = await ctxFor({ accountId: account });
    const out = (await dispatch("list_teams", {}, ctx)) as ListTeamsOutput;

    expect(out.signed_in).toBe(true);
    if (!out.signed_in) throw new Error("expected signed_in");

    expect(out.teams).toHaveLength(1);
    const team = out.teams[0]!;
    expect(team.name).toBe("Rain Offense");
    expect(team.member_count).toBe(1);
    expect(team.incomplete).toBe(true); // < 6 members
    // Species slug resolved to its display name.
    expect(team.species).toEqual(["Garchomp"]);
    expect(typeof team.team_id).toBe("string");
  });
});
