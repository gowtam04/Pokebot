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

// A team legal in the seeded "tools" roster (garchomp is seeded; standard mode →
// scarlet-violet). The save mechanics under test are format-agnostic; using a
// roster-legal set keeps them clean of the species_illegal save gate (which is
// covered by its own test below).
const MEMBER: TeamMember = {
  species: "garchomp",
  ability: "rough-skin",
  item: "life-orb",
  moves: ["earthquake", "dragon-claw", "fire-fang"],
  nature: "jolly",
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "steel",
  level: 50,
};

const PROPOSED: ProposedTeam = {
  name: "Dragon Offense",
  format: "scarlet-violet",
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
    expect(out.name).toBe("Dragon Offense");
    expect(out.format).toBe("scarlet-violet");

    // The route's stamp source is set to the authoritative server-owned id.
    expect(ctx.savedTeam).toEqual({
      id: out.team_id,
      name: "Dragon Offense",
      format: "scarlet-violet",
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
    expect(saved!.name).toBe("Dragon Offense");
  });

  it("refuses an out-of-roster member with illegal_team, without writing", async () => {
    ensureLoaded();
    const ctx = await ctxWith({ accountId: "acct-3", sessionId: "conv-6" });
    // `heatran` is absent from the seeded scarlet-violet roster → species_illegal.
    const illegal: ProposedTeam = {
      name: "Bad Team",
      format: "scarlet-violet",
      members: [{ ...MEMBER, species: "heatran" }],
    };
    const out = (await dispatch(
      "save_team",
      { team: illegal },
      ctx,
    )) as SaveTeamOutput;

    expect(out.saved).toBe(false);
    if (out.saved) throw new Error("expected refusal");
    expect(out.reason).toBe("illegal_team");
    expect(out.warnings?.some((w) => w.code === "species_illegal")).toBe(true);
    // Refused BEFORE any write — no stamp, nothing persisted.
    expect(ctx.savedTeam).toBeUndefined();
  });
});
