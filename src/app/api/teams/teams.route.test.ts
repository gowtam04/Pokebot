/**
 * Integration tests for the `/api/teams/*` route surface (Phase 5;
 * docs/features/team-builder § API Design). Exercises the real route handlers
 * against a real migrated + seeded Postgres schema (Testcontainers) with the
 * repos/services reaching the installed `@/data/db` singleton — only
 * `getCurrentAccount` is mocked (cookie/session is out of scope here).
 *
 * Like team-repo.test.ts, the harness installs the fixture as the singleton
 * BEFORE the first dynamic import of the route handlers and neutralises
 * `server-only` under the vitest node env.
 *
 * Focus (design.md Phase 5 test focus): CRUD happy paths; create/update/import
 * return `validation`; import returns `notes` + EV>255 is a SAFE 200 (carry-over,
 * not a 500); export round-trips; **isolation** (another account → 404); **guest
 * → 401** everywhere; partial team saves (BR-T4).
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/server/auth/current-user", () => cu);

import { createPgSchema, installAsSingleton, type PgFixture } from "../../../../test/support/pg";

import type { TeamMember } from "@/data/teams/team-schema";

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
const SV = "scarlet-violet";

type ListRoute = typeof import("./route");
type IdRoute = typeof import("./[id]/route");
type DupRoute = typeof import("./[id]/duplicate/route");
type ExportRoute = typeof import("./[id]/export/route");
type ImportRoute = typeof import("./import/route");

let fix: PgFixture;
let list: ListRoute;
let byId: IdRoute;
let dup: DupRoute;
let exp: ExportRoute;
let imp: ImportRoute;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);
  list = await import("./route");
  byId = await import("./[id]/route");
  dup = await import("./[id]/duplicate/route");
  exp = await import("./[id]/export/route");
  imp = await import("./import/route");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE team, conversation, conversation_message RESTART IDENTITY`,
  );
  cu.getCurrentAccount.mockReset();
});

// --- Helpers ---------------------------------------------------------------

function signedIn(id: string): void {
  cu.getCurrentAccount.mockResolvedValue({ id, email: `${id}@x.test`, createdAt: 0 });
}
function guest(): void {
  cu.getCurrentAccount.mockResolvedValue(null);
}

const spread = (v = 0) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });

function mkMember(over: Partial<TeamMember> = {}): TeamMember {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: null,
    moves: ["earthquake", "dragon-claw"],
    nature: "adamant",
    evs: spread(4),
    ivs: spread(31),
    tera_type: null,
    level: 50,
    ...over,
  };
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request("http://t/api/teams", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

async function createTeam(over: { name?: string; members?: TeamMember[] } = {}) {
  signedIn(ACCT_A);
  const res = await list.POST(post({ format: SV, ...over }));
  expect(res.status).toBe(200);
  return (await res.json()) as { team: { id: string; name: string; members: TeamMember[] }; validation: unknown[] };
}

// --- Guest → 401 everywhere ------------------------------------------------

describe("guest → 401 on every /api/teams route", () => {
  it("rejects all verbs without a session", async () => {
    guest();
    expect((await list.GET(new Request("http://t/api/teams"))).status).toBe(401);
    expect((await list.POST(post({ format: SV }))).status).toBe(401);
    expect((await byId.GET(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect(
      (await byId.PUT(new Request("http://t/x", { method: "PUT", body: "{}" }), idCtx("x"))).status,
    ).toBe(401);
    expect((await byId.DELETE(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await dup.POST(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await exp.GET(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await imp.POST(post({ format: SV, paste: "" }))).status).toBe(401);
  });
});

// --- Create / list ---------------------------------------------------------

describe("POST /api/teams (create)", () => {
  it("creates a team with default name + returns validation (warn-but-allow)", async () => {
    const { team, validation } = await createTeam();
    expect(team.name).toBe("Untitled team");
    expect(team.members).toEqual([]);
    expect(Array.isArray(validation)).toBe(true);
  });

  it("accepts a partial team (BR-T4) and computes warnings", async () => {
    const { team, validation } = await createTeam({
      name: "Partial",
      members: [mkMember()], // 1 member, 2 moves → incomplete
    });
    expect(team.members).toHaveLength(1);
    const codes = (validation as { code: string }[]).map((w) => w.code);
    expect(codes).toContain("incomplete");
  });

  it("400s a missing/unknown format", async () => {
    signedIn(ACCT_A);
    expect((await list.POST(post({}))).status).toBe(400);
    expect((await list.POST(post({ format: "nope" }))).status).toBe(400);
  });
});

describe("GET /api/teams (list)", () => {
  it("lists this account's teams, format filter honoured", async () => {
    await createTeam({ name: "T1" });
    signedIn(ACCT_A);
    const all = (await (await list.GET(new Request("http://t/api/teams"))).json()) as {
      teams: { name: string }[];
    };
    expect(all.teams.map((t) => t.name)).toContain("T1");

    const champ = (await (
      await list.GET(new Request("http://t/api/teams?format=champions"))
    ).json()) as { teams: unknown[] };
    expect(champ.teams).toHaveLength(0);
  });
});

// --- Detail / update / delete + isolation ----------------------------------

describe("GET/PUT/DELETE /api/teams/[id]", () => {
  it("GET returns full team + validation; other account → 404", async () => {
    const { team } = await createTeam({ members: [mkMember()] });

    signedIn(ACCT_A);
    const okRes = await byId.GET(new Request("http://t"), idCtx(team.id));
    expect(okRes.status).toBe(200);
    const ok = (await okRes.json()) as { team: { id: string }; validation: unknown[] };
    expect(ok.team.id).toBe(team.id);
    expect(Array.isArray(ok.validation)).toBe(true);

    signedIn(ACCT_B);
    expect((await byId.GET(new Request("http://t"), idCtx(team.id))).status).toBe(404);
  });

  it("PUT replaces name + members; other account → 404", async () => {
    const { team } = await createTeam();
    signedIn(ACCT_A);
    const putRes = await byId.PUT(
      new Request("http://t", { method: "PUT", body: JSON.stringify({ name: "Renamed", members: [mkMember()] }) }),
      idCtx(team.id),
    );
    expect(putRes.status).toBe(200);
    const put = (await putRes.json()) as { team: { name: string; members: unknown[] } };
    expect(put.team.name).toBe("Renamed");
    expect(put.team.members).toHaveLength(1);

    signedIn(ACCT_B);
    const denied = await byId.PUT(
      new Request("http://t", { method: "PUT", body: JSON.stringify({ name: "Hijack" }) }),
      idCtx(team.id),
    );
    expect(denied.status).toBe(404);
  });

  it("DELETE is permanent + idempotent; other account → 404", async () => {
    const { team } = await createTeam();

    signedIn(ACCT_B);
    expect((await byId.DELETE(new Request("http://t"), idCtx(team.id))).status).toBe(404);

    signedIn(ACCT_A);
    expect((await byId.DELETE(new Request("http://t"), idCtx(team.id))).status).toBe(200);
    // gone now → 404 (client treats as success)
    expect((await byId.DELETE(new Request("http://t"), idCtx(team.id))).status).toBe(404);
    expect((await byId.GET(new Request("http://t"), idCtx(team.id))).status).toBe(404);
  });
});

// --- Duplicate -------------------------------------------------------------

describe("POST /api/teams/[id]/duplicate", () => {
  it("clones into '<name> copy'; other account → 404", async () => {
    const { team } = await createTeam({ name: "Original", members: [mkMember()] });

    signedIn(ACCT_A);
    const res = await dup.POST(new Request("http://t"), idCtx(team.id));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { team: { id: string; name: string; members: unknown[] } };
    expect(out.team.name).toBe("Original copy");
    expect(out.team.id).not.toBe(team.id);
    expect(out.team.members).toHaveLength(1);

    signedIn(ACCT_B);
    expect((await dup.POST(new Request("http://t"), idCtx(team.id))).status).toBe(404);
  });
});

// --- Export ----------------------------------------------------------------

describe("GET /api/teams/[id]/export", () => {
  it("round-trips to Showdown paste (display names); other account → 404", async () => {
    const { team } = await createTeam({ members: [mkMember()] });

    signedIn(ACCT_A);
    const res = await exp.GET(new Request("http://t"), idCtx(team.id));
    expect(res.status).toBe(200);
    const { paste } = (await res.json()) as { paste: string };
    expect(paste).toContain("Garchomp");
    expect(paste).toContain("Earthquake");

    signedIn(ACCT_B);
    expect((await exp.GET(new Request("http://t"), idCtx(team.id))).status).toBe(404);
  });
});

// --- Import ----------------------------------------------------------------

describe("POST /api/teams/import", () => {
  it("imports resolvable members + surfaces notes for what doesn't resolve", async () => {
    signedIn(ACCT_A);
    const paste = [
      "Garchomp @ Leftovers",
      "Ability: Rough Skin",
      "Adamant Nature",
      "- Earthquake",
      "",
      "Notarealmon",
      "- Splash",
    ].join("\n");

    const res = await imp.POST(post({ format: SV, paste }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      team: { members: TeamMember[] };
      validation: unknown[];
      notes: { kind: string; raw: string }[];
    };
    // First slot resolved to garchomp; the bogus species produced a note.
    expect(out.team.members[0]?.species).toBe("garchomp");
    expect(out.notes.some((n) => n.kind === "pokemon")).toBe(true);
    expect(Array.isArray(out.validation)).toBe(true);
  });

  it("EV > 255 from @pkmn is a SAFE 200 (clamped, not a 500); cap is a warning", async () => {
    signedIn(ACCT_A);
    const paste = [
      "Garchomp",
      "Ability: Rough Skin",
      "EVs: 300 Atk", // @pkmn does NOT clamp — would fail teamMembersSchema (max 255)
      "Adamant Nature",
      "- Earthquake",
    ].join("\n");

    const res = await imp.POST(post({ format: SV, paste }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      team: { members: TeamMember[] };
      validation: { code: string }[];
    };
    // Clamped into schema range so persistence never threw...
    expect(out.team.members[0]?.evs.atk).toBeLessThanOrEqual(255);
    // ...and validateTeam owns the competitive cap warning.
    expect(out.validation.map((w) => w.code)).toContain("ev_stat_exceeded");
  });

  it("400s a missing paste / bad format", async () => {
    signedIn(ACCT_A);
    expect((await imp.POST(post({ format: SV }))).status).toBe(400);
    expect((await imp.POST(post({ format: "nope", paste: "x" }))).status).toBe(400);
  });
});
