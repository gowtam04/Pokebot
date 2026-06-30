/**
 * Focused tests for the team-builder wiring added to `GET/PATCH
 * /api/conversations/[id]` (Phase 7; design.md § `GET/PATCH
 * /api/conversations/[id]` (modified); TEAM-US-8, AC-8.1, AC-8.2, BR-T3).
 *
 *   - GET returns `active_team_id` (null when none, the bound id otherwise),
 *   - PATCH may set it WITHOUT chatting — but only an account-owned,
 *     format-matching team binds; a mismatch / not-owned id is silently IGNORED
 *     (warn-but-allow, never an error), and `null` always clears (AC-8.2).
 *
 * Real migrated Postgres (Testcontainers) so the route's repo + team-repo run for
 * real against the `@/data/db` singleton; only `getCurrentAccount` is mocked.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OakAnswer } from "@/agent/schemas";

vi.mock("server-only", () => ({}));

const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/server/auth/current-user", () => cu);

import { createPgSchema, installAsSingleton, type PgFixture } from "../../../../../test/support/pg";

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
const SV = "scarlet-violet";
const CHAMP = "champions";

let fix: PgFixture;
let route: typeof import("./route");
let convRepo: typeof import("@/data/repos/conversation-repo");
let teamRepo: typeof import("@/data/repos/team-repo");

const ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "ok",
  reasoning_markdown: "—",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

beforeAll(async () => {
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);
  route = await import("./route");
  convRepo = await import("@/data/repos/conversation-repo");
  teamRepo = await import("@/data/repos/team-repo");
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

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

function patch(id: string, body: unknown): Promise<Response> {
  return route.PATCH(
    new Request("http://t", { method: "PATCH", body: JSON.stringify(body) }),
    idCtx(id),
  );
}

async function seedConv(
  accountId: string,
  id: string,
  format: string,
  activeTeamId: string | null = null,
): Promise<void> {
  await convRepo.appendTurnPair({
    accountId,
    conversationId: id,
    format,
    userTurnId: convRepo.newTurnId(),
    userMessage: "q",
    assistantTurnId: convRepo.newTurnId(),
    answer: ANSWER,
    now: Date.now(),
    activeTeamId,
  });
}

async function mkTeam(accountId: string, format: string) {
  return teamRepo.createTeam({ accountId, format, name: "T", members: [], now: Date.now() });
}

const activeOf = (id: string) =>
  convRepo.getConversation(ACCT_A, id).then((c) => c?.activeTeamId);

// --- GET returns active_team_id --------------------------------------------

describe("GET /api/conversations/[id] — active_team_id", () => {
  it("returns null when none is bound and the id when one is", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV);
    await seedConv(ACCT_A, "none", SV, null);
    await seedConv(ACCT_A, "set", SV, team.id);

    const none = await (await route.GET(new Request("http://t"), idCtx("none"))).json();
    expect((none as { active_team_id: string | null }).active_team_id).toBeNull();

    const set = await (await route.GET(new Request("http://t"), idCtx("set"))).json();
    expect((set as { active_team_id: string | null }).active_team_id).toBe(team.id);
  });
});

// --- PATCH set / clear -----------------------------------------------------

describe("PATCH /api/conversations/[id] — set/clear active_team_id", () => {
  it("binds an account-owned, format-matching team (AC-8.2)", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV);
    await seedConv(ACCT_A, "c", SV);

    const res = await patch("c", { active_team_id: team.id });
    expect(res.status).toBe(200);
    expect(await activeOf("c")).toBe(team.id);
  });

  it("clears with null", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV);
    await seedConv(ACCT_A, "c", SV, team.id);

    expect((await patch("c", { active_team_id: null })).status).toBe(200);
    expect(await activeOf("c")).toBeNull();
  });

  it("IGNORES a format-mismatching team (BR-T3) — 200, selection untouched", async () => {
    signedIn(ACCT_A);
    const champTeam = await mkTeam(ACCT_A, CHAMP);
    await seedConv(ACCT_A, "c", SV); // conversation is SV

    const res = await patch("c", { active_team_id: champTeam.id });
    expect(res.status).toBe(200);
    expect(await activeOf("c")).toBeNull();
  });

  it("IGNORES a not-owned team — 200, selection untouched", async () => {
    const otherTeam = await mkTeam(ACCT_B, SV);
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);

    const res = await patch("c", { active_team_id: otherTeam.id });
    expect(res.status).toBe(200);
    expect(await activeOf("c")).toBeNull();
  });

  it("400s a non-string, non-null active_team_id", async () => {
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);
    expect((await patch("c", { active_team_id: 42 })).status).toBe(400);
    expect((await patch("c", { active_team_id: "" })).status).toBe(400);
  });

  it("still accepts a title/pinned-only PATCH (unchanged contract)", async () => {
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);
    expect((await patch("c", { pinned: true })).status).toBe(200);
    // empty body still rejected
    expect((await patch("c", {})).status).toBe(400);
  });

  it("guest → 401, other account → 404 (isolation preserved)", async () => {
    const team = await mkTeam(ACCT_A, SV);
    await seedConv(ACCT_A, "c", SV);

    guest();
    expect((await patch("c", { active_team_id: team.id })).status).toBe(401);

    signedIn(ACCT_B);
    expect((await patch("c", { active_team_id: team.id })).status).toBe(404);
  });
});
