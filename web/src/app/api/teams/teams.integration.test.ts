/**
 * TEAMS-BACKEND-E2E — the cross-cutting `/api/teams/*` lifecycle exercised
 * end-to-end through the REAL route handlers against a REAL migrated + seeded
 * Postgres schema (Testcontainers). This is the integration checkpoint the
 * design mandates after Phase 5 and folds into Phase 11
 * (docs/features/team-builder § Integration checkpoints — `teams-backend-e2e`,
 * § Phase 11 test focus):
 *
 *   create/import a team → validation warnings computed → export round-trips →
 *   another account gets 404 → guests get 401.
 *
 * Where the per-route oracle (`teams.route.test.ts`) asserts each verb in
 * isolation, this drives ONE continuous account lifecycle (create → edit →
 * duplicate → export → re-import → delete) plus the cross-cutting invariants
 * (per-account isolation 404, guest 401 everywhere, import/export round-trip,
 * EV>255 → a SAFE 200). Only `getCurrentAccount` is mocked; the repos/services/
 * validation/paste all run for real against the installed `@/data/db` singleton.
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
import type { TeamWarning } from "@/server/teams/validate-team";

const ACCT_A = "acct-lifecycle-a";
const ACCT_B = "acct-lifecycle-b";
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

/** A partial Garchomp set (2 moves) — `incomplete` fires (<4 moves, BR-T5). */
function partialMember(over: Partial<TeamMember> = {}): TeamMember {
  return fullMember({ moves: ["earthquake", "dragon-claw"], ...over });
}

/** A fully-built Garchomp set (4 valid moves) — counts as "complete". */
function fullMember(over: Partial<TeamMember> = {}): TeamMember {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: "leftovers",
    moves: ["earthquake", "dragon-claw", "fire-fang", "earthquake"],
    nature: "adamant",
    evs: { ...spread(), atk: 252, spe: 252, hp: 4 },
    ivs: spread(31),
    tera_type: "ground",
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
const put = (body: unknown) =>
  new Request("http://t/api/teams", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

interface TeamBody {
  team: { id: string; name: string; format: string; members: TeamMember[] };
  validation: TeamWarning[];
}

// ---------------------------------------------------------------------------
// One continuous account lifecycle (create → edit → duplicate → export →
// re-import → delete) through the real route surface (TEAM-US-1..4, 10, 11).
// ---------------------------------------------------------------------------

describe("teams-backend-e2e — full CRUD lifecycle", () => {
  it("creates, edits, duplicates, exports, re-imports, and deletes a team", async () => {
    signedIn(ACCT_A);

    // 1. CREATE — a partial team (one slot) → validation flags it incomplete.
    const createRes = await list.POST(
      post({ format: SV, name: "Ladder Core", members: [partialMember()] }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as TeamBody;
    expect(created.team.name).toBe("Ladder Core");
    expect(created.team.members).toHaveLength(1);
    // A 1-member team is incomplete (BR-T5) — warnings are COMPUTED, never blocking.
    expect(created.validation.map((w) => w.code)).toContain("incomplete");
    const id = created.team.id;

    // 2. LIST — the new team shows up for this account, format-scoped.
    const listRes = await list.GET(new Request("http://t/api/teams?format=scarlet-violet"));
    const listed = (await listRes.json()) as {
      teams: { id: string; name: string; incomplete: boolean }[];
    };
    expect(listed.teams.find((t) => t.id === id)).toMatchObject({
      name: "Ladder Core",
      incomplete: true,
    });

    // 3. EDIT — rename + replace members (the manual-builder save path).
    const editRes = await byId.PUT(
      put({ name: "Ladder Core v2", members: [fullMember(), fullMember()] }),
      idCtx(id),
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as TeamBody;
    expect(edited.team.name).toBe("Ladder Core v2");
    expect(edited.team.members).toHaveLength(2);
    // Two Garchomp slots → species + item clause warnings now fire.
    expect(edited.validation.map((w) => w.code)).toEqual(
      expect.arrayContaining(["duplicate_species"]),
    );

    // 4. DUPLICATE — an independent clone named "<name> copy".
    const dupRes = await dup.POST(new Request("http://t"), idCtx(id));
    expect(dupRes.status).toBe(200);
    const duplicated = (await dupRes.json()) as TeamBody;
    expect(duplicated.team.id).not.toBe(id);
    expect(duplicated.team.name).toBe("Ladder Core v2 copy");
    expect(duplicated.team.members).toHaveLength(2);

    // 5. EXPORT — the original round-trips to a Showdown paste (display names).
    const exportRes = await exp.GET(new Request("http://t"), idCtx(id));
    expect(exportRes.status).toBe(200);
    const { paste } = (await exportRes.json()) as { paste: string };
    expect(paste).toContain("Garchomp");
    expect(paste).toContain("Earthquake");

    // 6. RE-IMPORT — feed that exported paste back; it resolves to a new saved
    //    team with the same species (round-trip fidelity, BR-T7/BR-T11).
    const importRes = await imp.POST(post({ format: SV, paste }));
    expect(importRes.status).toBe(200);
    const imported = (await importRes.json()) as TeamBody & {
      notes: { kind: string }[];
    };
    expect(imported.team.members[0]?.species).toBe("garchomp");
    expect(Array.isArray(imported.notes)).toBe(true);

    // 7. DELETE — permanent + idempotent; the team is gone afterwards.
    expect((await byId.DELETE(new Request("http://t"), idCtx(id))).status).toBe(200);
    expect((await byId.GET(new Request("http://t"), idCtx(id))).status).toBe(404);
    // The duplicate is untouched by deleting its source (independence).
    expect(
      (await byId.GET(new Request("http://t"), idCtx(duplicated.team.id))).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-account isolation — a row owned by another account is 404, never 403
// (BR-T2 / BR-A9).
// ---------------------------------------------------------------------------

describe("teams-backend-e2e — cross-account isolation is 404", () => {
  it("hides A's team from B across every detail verb", async () => {
    signedIn(ACCT_A);
    const created = (await (
      await list.POST(post({ format: SV, name: "A only", members: [fullMember()] }))
    ).json()) as TeamBody;
    const id = created.team.id;

    // B cannot read, edit, duplicate, export, or delete A's team — all 404.
    signedIn(ACCT_B);
    expect((await byId.GET(new Request("http://t"), idCtx(id))).status).toBe(404);
    expect((await byId.PUT(put({ name: "hijack" }), idCtx(id))).status).toBe(404);
    expect((await dup.POST(new Request("http://t"), idCtx(id))).status).toBe(404);
    expect((await exp.GET(new Request("http://t"), idCtx(id))).status).toBe(404);
    expect((await byId.DELETE(new Request("http://t"), idCtx(id))).status).toBe(404);

    // ...and A still owns an untouched team.
    signedIn(ACCT_A);
    const stillThere = await byId.GET(new Request("http://t"), idCtx(id));
    expect(stillThere.status).toBe(200);
    expect(((await stillThere.json()) as TeamBody).team.name).toBe("A only");
  });
});

// ---------------------------------------------------------------------------
// Guests get 401 on every /api/teams route (BR-T2).
// ---------------------------------------------------------------------------

describe("teams-backend-e2e — guest 401 everywhere", () => {
  it("rejects every verb without a session", async () => {
    guest();
    expect((await list.GET(new Request("http://t/api/teams"))).status).toBe(401);
    expect((await list.POST(post({ format: SV }))).status).toBe(401);
    expect((await byId.GET(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await byId.PUT(put({}), idCtx("x"))).status).toBe(401);
    expect((await byId.DELETE(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await dup.POST(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await exp.GET(new Request("http://t/x"), idCtx("x"))).status).toBe(401);
    expect((await imp.POST(post({ format: SV, paste: "x" }))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Import/export round-trip + the EV>255 SAFE-200 carry-over invariant
// (@pkmn does not clamp; persistence must never 500 — the cap is a warning).
// ---------------------------------------------------------------------------

describe("teams-backend-e2e — import/export round-trip + EV>255 safe-200", () => {
  it("round-trips a built team through export → import preserving the species", async () => {
    signedIn(ACCT_A);
    const created = (await (
      await list.POST(post({ format: SV, members: [fullMember()] }))
    ).json()) as TeamBody;

    const { paste } = (await (
      await exp.GET(new Request("http://t"), idCtx(created.team.id))
    ).json()) as { paste: string };

    const reimported = (await (
      await imp.POST(post({ format: SV, paste }))
    ).json()) as TeamBody;
    expect(reimported.team.members[0]?.species).toBe("garchomp");
    expect(reimported.team.id).not.toBe(created.team.id);
  });

  it("treats an EV > 255 paste as a SAFE 200 (clamped into range, cap is a warning)", async () => {
    signedIn(ACCT_A);
    const paste = [
      "Garchomp",
      "Ability: Rough Skin",
      "EVs: 300 Atk", // @pkmn does NOT clamp — would otherwise fail the schema (max 255)
      "Adamant Nature",
      "- Earthquake",
    ].join("\n");

    const res = await imp.POST(post({ format: SV, paste }));
    expect(res.status).toBe(200); // never a 500
    const out = (await res.json()) as TeamBody;
    // Clamped into the schema range so the JSON write never threw...
    expect(out.team.members[0]?.evs.atk).toBeLessThanOrEqual(255);
    // ...and validateTeam owns the competitive-cap warning.
    expect(out.validation.map((w) => w.code)).toContain("ev_stat_exceeded");
  });
});
