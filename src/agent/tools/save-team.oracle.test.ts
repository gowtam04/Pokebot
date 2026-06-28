/**
 * INDEPENDENT ORACLE — T13 `save_team` (conversational save; TEAM-AD-7),
 * exercised against a small migrated Postgres schema (seed "tools").
 *
 * Behaviour derived from the design — NOT the impl:
 *   - on approval it persists the SERVER-BOUND proposed team (ctx.proposedTeam)
 *     verbatim and reports { saved:true, team_id, name, format }, also setting
 *     ctx.savedTeam (the route's stamp source);
 *   - `name` renames; an explicit `team` is the build-and-save fallback;
 *   - a guest (no accountId) → { saved:false, reason:"not_signed_in" } and NO
 *     write; nothing to save → { saved:false, reason:"no_team" };
 *   - it never throws in-domain.
 *
 * Wiring mirrors get-active-team.oracle: migrate + seed an isolated schema and
 * install it as the @/data/db singleton BEFORE importing the server-only tool —
 * `save_team` writes via team-repo.createTeam, which reads the SINGLETON.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AgentContext } from "@/agent/types";
import type { OakDb } from "@/data/db";
import type { TeamMember } from "@/data/teams/team-schema";
import type { ProposedTeam, SaveTeamOutput } from "@/agent/schemas";

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
let getTeam: typeof import("@/data/repos/team-repo").getTeam;

const MEMBER: TeamMember = {
  species: "pelipper",
  ability: "drizzle",
  item: "damp-rock",
  moves: ["hurricane", "hydro-pump", "tailwind", "protect"],
  nature: "modest",
  evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "water",
  level: 50,
};

const PROPOSED: ProposedTeam = {
  name: "Rain Offense",
  format: "champions",
  members: [MEMBER],
};

beforeAll(async () => {
  try {
    fix = await createPgSchema({ seed: "tools" });
    await installAsSingleton(fix);

    ({ dispatch } = await import("@/agent/tools"));
    ({ createAgentContext } = await import("@/agent/context"));
    ({ getTeam } = await import("@/data/repos/team-repo"));
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

async function ctxWith(
  over: Partial<{
    accountId: string;
    sessionId: string;
    proposedTeam: ProposedTeam;
  }>,
): Promise<AgentContext> {
  return createAgentContext({
    db: fix.db as unknown as OakDb,
    requestId: "oracle",
    ...over,
  });
}

describe("save_team tool (T13)", () => {
  it("persists the server-bound proposed team verbatim and reports it", async () => {
    ensureLoaded();
    const ctx = await ctxWith({
      accountId: "acct-1",
      sessionId: "conv-1",
      proposedTeam: PROPOSED,
    });

    const out = (await dispatch("save_team", {}, ctx)) as SaveTeamOutput;
    expect(out.saved).toBe(true);
    if (!out.saved) throw new Error("expected saved");
    expect(out.name).toBe("Rain Offense");
    expect(out.format).toBe("champions");

    // The route's stamp source is set to the authoritative server-owned id.
    expect(ctx.savedTeam).toEqual({
      id: out.team_id,
      name: "Rain Offense",
      format: "champions",
    });

    // The row exists, account-scoped, with the EXACT members the user saw.
    const saved = await getTeam("acct-1", out.team_id);
    expect(saved).not.toBeNull();
    expect(saved!.members).toEqual([MEMBER]);
  });

  it("renames the saved team via the optional `name` arg", async () => {
    ensureLoaded();
    const ctx = await ctxWith({
      accountId: "acct-1",
      sessionId: "conv-2",
      proposedTeam: PROPOSED,
    });
    const out = (await dispatch(
      "save_team",
      { name: "Sun Team" },
      ctx,
    )) as SaveTeamOutput;
    expect(out.saved).toBe(true);
    if (!out.saved) throw new Error("expected saved");
    expect(out.name).toBe("Sun Team");
  });

  it("returns not_signed_in for a guest (no accountId), without writing", async () => {
    ensureLoaded();
    const ctx = await ctxWith({ sessionId: "conv-3", proposedTeam: PROPOSED });
    const out = (await dispatch("save_team", {}, ctx)) as SaveTeamOutput;
    expect(out).toEqual({ saved: false, reason: "not_signed_in" });
    expect(ctx.savedTeam).toBeUndefined();
  });

  it("returns no_team when nothing is proposed and none is passed", async () => {
    ensureLoaded();
    const ctx = await ctxWith({ accountId: "acct-1", sessionId: "conv-4" });
    const out = (await dispatch("save_team", {}, ctx)) as SaveTeamOutput;
    expect(out).toEqual({ saved: false, reason: "no_team" });
  });

  it("saves an explicitly-passed team when there's no prior proposal", async () => {
    ensureLoaded();
    const ctx = await ctxWith({ accountId: "acct-2", sessionId: "conv-5" });
    const out = (await dispatch(
      "save_team",
      { team: PROPOSED },
      ctx,
    )) as SaveTeamOutput;
    expect(out.saved).toBe(true);
    if (!out.saved) throw new Error("expected saved");
    const saved = await getTeam("acct-2", out.team_id);
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("Rain Offense");
  });
});
