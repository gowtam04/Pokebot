/**
 * INDEPENDENT ORACLE — T12 `get_active_team` + the active-team service it wraps
 * (src/server/teams/active-team.ts), exercised against a small deterministic
 * fixture DB (seed "tools").
 *
 * Behaviour derived from the design (§ Agent seam, TEAM-AD-1) — NOT the impl:
 *   - the tool returns { active: false } when no team is bound (ctx.activeTeam
 *     undefined), and NEVER throws;
 *   - when a team IS bound, it returns { active: true, team } with display names
 *     resolved from searchable_names and computed validateTeam `warnings`;
 *   - resolveActiveTeam binds an owned, format-matched team and returns null for
 *     a missing id / not-owned team / format mismatch (BR-T2, BR-T3, AC-8.3).
 *
 * Wiring (per the RISK DIRECTIVES):
 *   - migrate + seed an isolated Postgres schema (createPgSchema) and install it
 *     as the @/data/db singleton (installAsSingleton) BEFORE importing the
 *     server-only modules — team-repo (createTeam) and resolve-index both read
 *     the SINGLETON, while the tool/enrich path reads the bound ctx.db.
 *   - `import "server-only"` is neutralized so the repos/services load under the
 *     vitest node environment.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AgentContext } from "@/agent/types";
import type { PokebotDb } from "@/data/db";
import type { TeamMember } from "@/data/teams/team-schema";
import type {
  ActiveTeam,
  EnrichedActiveTeam,
} from "@/server/teams/active-team";
import type { GetActiveTeamOutput } from "@/agent/schemas";

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
let resolveActiveTeam: typeof import("@/server/teams/active-team").resolveActiveTeam;
let enrichActiveTeam: typeof import("@/server/teams/active-team").enrichActiveTeam;
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

const ACTIVE_TEAM: ActiveTeam = {
  id: "team-1",
  name: "Test Team",
  format: "scarlet-violet",
  members: [MEMBER],
};

beforeAll(async () => {
  try {
    fix = await createPgSchema({ seed: "tools" });
    await installAsSingleton(fix);

    ({ dispatch } = await import("@/agent/tools"));
    ({ createAgentContext } = await import("@/agent/context"));
    ({ resolveActiveTeam, enrichActiveTeam } = await import(
      "@/server/teams/active-team"
    ));
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

async function ctxWith(activeTeam?: ActiveTeam): Promise<AgentContext> {
  return createAgentContext({
    db: fix.db as unknown as PokebotDb,
    requestId: "oracle",
    activeTeam,
  });
}

describe("get_active_team tool (T12)", () => {
  it("returns { active: false } when no team is bound, and never throws", async () => {
    ensureLoaded();
    const ctx = await ctxWith(undefined);
    let out: unknown;
    await expect(
      (async () => {
        out = await dispatch("get_active_team", {}, ctx);
      })(),
    ).resolves.toBeUndefined();
    expect(out).toEqual({ active: false });
  });

  it("returns { active: true, team } enriched with display names + warnings", async () => {
    ensureLoaded();
    const ctx = await ctxWith(ACTIVE_TEAM);
    const out = (await dispatch(
      "get_active_team",
      {},
      ctx,
    )) as GetActiveTeamOutput;

    expect(out.active).toBe(true);
    if (!out.active) throw new Error("expected active team");

    const team: EnrichedActiveTeam = out.team;
    expect(team.name).toBe("Test Team");
    expect(team.format).toBe("scarlet-violet");

    const m = team.members[0]!;
    // Display names resolved from searchable_names (slug kept alongside).
    expect(m.species).toBe("garchomp");
    expect(m.species_display).toBe("Garchomp");
    expect(m.ability_display).toBe("Rough Skin");
    expect(m.item_display).toBe("Leftovers");
    expect(m.moves_display).toEqual(["Earthquake", "Will-O-Wisp"]);
    expect(m.tera_type).toBe("fire");
    expect(m.level).toBe(50);

    // Computed warnings: a partial moveset (incomplete) and an unlearnable move.
    const codes = team.warnings.map((w) => w.code);
    expect(codes).toContain("incomplete");
    expect(codes).toContain("move_not_in_learnset");
  });

  it("a slug with no searchable_names row falls back to itself (never throws)", async () => {
    ensureLoaded();
    const enriched = await enrichActiveTeam(
      {
        id: "t2",
        name: "Fallbacks",
        format: "scarlet-violet",
        members: [{ ...MEMBER, item: "made-up-item" }],
      },
      fix.db as unknown as PokebotDb,
    );
    expect(enriched.members[0]!.item).toBe("made-up-item");
    expect(enriched.members[0]!.item_display).toBe("made-up-item");
  });
});

describe("resolveActiveTeam (bind guard)", () => {
  it("binds an owned, format-matched team and rejects mismatch / not-owned / missing id", async () => {
    ensureLoaded();
    const accountId = "acct-1";
    const created = await createTeam({
      accountId,
      format: "scarlet-violet",
      name: "Saved",
      members: [MEMBER],
      now: Date.now(),
    });

    const db = fix.db as unknown as PokebotDb;

    // Owned + format matches "standard" → scarlet-violet → bound.
    const bound = await resolveActiveTeam(accountId, created.id, "standard", db);
    expect(bound).not.toBeNull();
    expect(bound!.id).toBe(created.id);
    expect(bound!.format).toBe("scarlet-violet");

    // Format mismatch (champions mode vs a scarlet-violet team) → null (AC-8.3).
    expect(
      await resolveActiveTeam(accountId, created.id, "champions", db),
    ).toBeNull();

    // Another account's id is indistinguishable from missing → null (BR-T2).
    expect(
      await resolveActiveTeam("other-acct", created.id, "standard", db),
    ).toBeNull();

    // No selection → null.
    expect(await resolveActiveTeam(accountId, null, "standard", db)).toBeNull();
    expect(
      await resolveActiveTeam(accountId, undefined, "standard", db),
    ).toBeNull();
  });
});
