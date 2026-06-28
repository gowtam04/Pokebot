/**
 * Focused tests for the team-builder wiring added to `POST /api/chat` (Phase 7;
 * design.md § `POST /api/chat` (modified); TEAM-US-8, TEAM-US-9, BR-T3, BR-T9,
 * AC-8.1, AC-8.3). The broad SSE framing / guardrails / history contract is
 * already covered by `test/api-chat.integration.test.ts`; this file asserts ONLY
 * the active-team seam:
 *
 *   - an account-owned, format-matching team binds onto `ctx.activeTeam` and is
 *     persisted onto the conversation (last-selected-wins),
 *   - a format mismatch / not-owned id / guest binds `null` (AC-8.3, BR-T3),
 *   - an aborted turn persists nothing (existing guard, unchanged).
 *
 * Real migrated+seeded Postgres (Testcontainers) so `resolveActiveTeam`
 * (team-repo) and `appendTurnPair` (conversation-repo) run for real against the
 * `@/data/db` singleton; only `getCurrentAccount`, `runOak`, and
 * `createAgentContext` are mocked (no model / network) — `createAgentContext` is
 * mocked so we can CAPTURE the `activeTeam` it was bound with.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OakAnswer } from "@/agent/schemas";

vi.mock("server-only", () => ({}));

const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/server/auth/current-user", () => cu);

const { mockRunOak } = vi.hoisted(() => ({ mockRunOak: vi.fn() }));
vi.mock("@/agent/runtime", () => ({ runOak: mockRunOak }));

// createAgentContext is mocked so we can capture the options it was called with
// (the route binds the resolved active team there). It returns a minimal ctx the
// mocked runOak ignores.
const { mockCreateCtx, captured } = vi.hoisted(() => ({
  mockCreateCtx: vi.fn(),
  captured: { options: null as Record<string, unknown> | null },
}));
vi.mock("@/agent/context", () => ({
  createAgentContext: mockCreateCtx,
}));

import { createPgSchema, installAsSingleton, type PgFixture } from "../../../../test/support/pg";
import { _resetStoreForTests } from "@/server/rate-limit";
import { clearSession } from "@/server/session-store";

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
const SV = "scarlet-violet";
const CHAMP = "champions";

let fix: PgFixture;
let route: typeof import("./route");
let teamRepo: typeof import("@/data/repos/team-repo");
let convRepo: typeof import("@/data/repos/conversation-repo");

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
  teamRepo = await import("@/data/repos/team-repo");
  convRepo = await import("@/data/repos/conversation-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE team, conversation, conversation_message RESTART IDENTITY`,
  );
  cu.getCurrentAccount.mockReset();
  mockRunOak.mockReset();
  mockRunOak.mockResolvedValue(ANSWER);
  mockCreateCtx.mockReset();
  mockCreateCtx.mockImplementation(async (options: Record<string, unknown>) => {
    captured.options = options;
    return {
      db: {},
      requestId: "test-req",
      mode: options.mode,
      activeTeam: options.activeTeam,
      logger: { info() {}, warn() {}, error() {}, child: () => ({}) },
    };
  });
  captured.options = null;
  _resetStoreForTests();
});

// --- Helpers ---------------------------------------------------------------

function signedIn(id: string): void {
  cu.getCurrentAccount.mockResolvedValue({ id, email: `${id}@x.test`, createdAt: 0 });
}
function guest(): void {
  cu.getCurrentAccount.mockResolvedValue(null);
}

function post(body: unknown, signal?: AbortSignal): Promise<Response> {
  return route.POST(
    new Request("http://t/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );
}

/** Drain the SSE body so the detached task (incl. persistence) settles. */
async function drain(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function mkTeam(accountId: string, format: string, name = "Team") {
  return teamRepo.createTeam({ accountId, format, name, members: [], now: Date.now() });
}

const boundTeam = () =>
  captured.options?.activeTeam as { id: string; name: string; format: string } | undefined;

// --- Bind + persist (happy path) -------------------------------------------

describe("POST /api/chat — active team binding", () => {
  it("binds an account-owned, format-matching team and persists it (TEAM-US-8/9)", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV, "SV squad");

    const res = await post({ session_id: "c1", message: "hi", active_team_id: team.id });
    expect(res.status).toBe(200);
    await drain(res);

    // Bound onto ctx.activeTeam (server-controlled analogue of `mode`).
    expect(boundTeam()?.id).toBe(team.id);
    expect(boundTeam()?.name).toBe("SV squad");
    expect(boundTeam()?.format).toBe(SV);

    // Persisted last-selected-wins onto the conversation.
    const conv = await convRepo.getConversation(ACCT_A, "c1");
    expect(conv?.activeTeamId).toBe(team.id);
  });

  it("a format mismatch binds null and persists null (AC-8.3 / BR-T3)", async () => {
    signedIn(ACCT_A);
    const champTeam = await mkTeam(ACCT_A, CHAMP, "Champ squad");

    // champions_mode omitted ⇒ standard mode; a champions team must NOT bind.
    const res = await post({ session_id: "c2", message: "hi", active_team_id: champTeam.id });
    await drain(res);

    expect(boundTeam()).toBeUndefined();
    const conv = await convRepo.getConversation(ACCT_A, "c2");
    expect(conv?.activeTeamId).toBeNull();
  });

  it("a not-owned team binds null (BR-T2 — indistinguishable from missing)", async () => {
    const otherTeam = await mkTeam(ACCT_B, SV, "B's team");
    signedIn(ACCT_A);

    const res = await post({ session_id: "c3", message: "hi", active_team_id: otherTeam.id });
    await drain(res);

    expect(boundTeam()).toBeUndefined();
    const conv = await convRepo.getConversation(ACCT_A, "c3");
    expect(conv?.activeTeamId).toBeNull();
  });

  it("a guest never resolves a team (gated on account) and persists no conversation", async () => {
    guest();
    const res = await post({ session_id: "g1", message: "hi", active_team_id: "anything" });
    await drain(res);

    expect(boundTeam()).toBeUndefined();
    // Guests use the in-memory session store — nothing lands in the DB.
    const conv = await convRepo.getConversation(ACCT_A, "g1");
    expect(conv).toBeNull();
    clearSession("g1");
  });

  it("an aborted turn persists nothing (existing guard)", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV);

    const res = await post(
      { session_id: "c4", message: "hi", active_team_id: team.id },
      AbortSignal.abort(),
    );
    await drain(res);

    const conv = await convRepo.getConversation(ACCT_A, "c4");
    expect(conv).toBeNull();
  });

  it("last-selected-wins: a later turn that clears the team persists null", async () => {
    signedIn(ACCT_A);
    const team = await mkTeam(ACCT_A, SV);

    await drain(await post({ session_id: "c5", message: "turn1", active_team_id: team.id }));
    expect((await convRepo.getConversation(ACCT_A, "c5"))?.activeTeamId).toBe(team.id);

    // Turn 2 deselects (active_team_id null) → clears the stored selection.
    await drain(await post({ session_id: "c5", message: "turn2", active_team_id: null }));
    expect((await convRepo.getConversation(ACCT_A, "c5"))?.activeTeamId).toBeNull();
  });
});
