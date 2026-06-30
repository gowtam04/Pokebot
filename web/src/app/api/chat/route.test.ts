/**
 * Back-compat guard for `POST /api/chat` after the server-bound active-team seam
 * was removed: saved teams are now referenced by NAME in chat (resolved live via
 * the `list_teams` / `get_team` tools), so the request body no longer carries an
 * `active_team_id` and the route never binds one onto the agent context. The
 * broad SSE framing / guardrails / history contract is covered by
 * `test/api-chat.integration.test.ts`; this file asserts ONLY that:
 *
 *   - a legacy `active_team_id` field in the body is harmlessly IGNORED (no 400,
 *     never bound onto the context),
 *   - the signed-in account id IS bound (the team tools need it), and
 *   - an aborted turn persists nothing (existing guard, unchanged).
 *
 * Real migrated+seeded Postgres (Testcontainers) so `appendTurnPair`
 * (conversation-repo) runs for real against the `@/data/db` singleton; only
 * `getCurrentAccount`, `runOak`, and `createAgentContext` are mocked (no model /
 * network) — `createAgentContext` is mocked so we can CAPTURE the options it was
 * bound with.
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
// (so we can assert the route no longer binds an active team). It returns a
// minimal ctx the mocked runOak ignores.
const { mockCreateCtx, captured } = vi.hoisted(() => ({
  mockCreateCtx: vi.fn(),
  captured: { options: null as Record<string, unknown> | null },
}));
vi.mock("@/agent/context", () => ({
  createAgentContext: mockCreateCtx,
}));

import { createPgSchema, installAsSingleton, type PgFixture } from "../../../../test/support/pg";
import { _resetStoreForTests } from "@/server/rate-limit";

const ACCT_A = "acct-a";

let fix: PgFixture;
let route: typeof import("./route");
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
      accountId: options.accountId,
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

describe("POST /api/chat — no active-team seam", () => {
  it("ignores a legacy active_team_id field and never binds an active team", async () => {
    signedIn(ACCT_A);

    const res = await post({
      session_id: "c1",
      message: "hi",
      active_team_id: "legacy-id",
    });
    expect(res.status).toBe(200);
    await drain(res);

    // The route no longer reads/binds an active team.
    expect(captured.options).not.toBeNull();
    expect(captured.options).not.toHaveProperty("activeTeam");

    // The turn still persisted normally.
    const conv = await convRepo.getConversation(ACCT_A, "c1");
    expect(conv).not.toBeNull();
  });

  it("binds the signed-in account id (the team tools read it)", async () => {
    signedIn(ACCT_A);
    await drain(await post({ session_id: "c2", message: "hi" }));
    expect((captured.options as Record<string, unknown>).accountId).toBe(ACCT_A);
  });

  it("an aborted turn persists nothing (existing guard)", async () => {
    signedIn(ACCT_A);
    const res = await post({ session_id: "c3", message: "hi" }, AbortSignal.abort());
    await drain(res);
    expect(await convRepo.getConversation(ACCT_A, "c3")).toBeNull();
  });
});
