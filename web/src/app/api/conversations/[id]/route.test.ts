/**
 * Tests for `GET/PATCH /api/conversations/[id]` after the active-team seam was
 * removed (saved teams are referenced by NAME in chat, not bound to a
 * conversation). Asserts the surviving contract:
 *
 *   - GET no longer returns an `active_team_id` field,
 *   - PATCH accepts `title` / `pinned` only; an empty body OR a legacy
 *     `active_team_id`-only body is a 400 (the field is no longer recognized),
 *   - isolation is preserved (guest → 401, other account → 404).
 *
 * Real migrated Postgres (Testcontainers) so the route's repo runs for real
 * against the `@/data/db` singleton; only `getCurrentAccount` is mocked.
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

async function seedConv(accountId: string, id: string, format: string): Promise<void> {
  await convRepo.appendTurnPair({
    accountId,
    conversationId: id,
    format,
    userTurnId: convRepo.newTurnId(),
    userMessage: "q",
    assistantTurnId: convRepo.newTurnId(),
    answer: ANSWER,
    now: Date.now(),
  });
}

// --- GET --------------------------------------------------------------------

describe("GET /api/conversations/[id] — no active_team_id field", () => {
  it("returns the conversation without an active_team_id field", async () => {
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);

    const body = await (await route.GET(new Request("http://t"), idCtx("c"))).json();
    expect(body).toMatchObject({ id: "c", format: SV });
    expect(body).not.toHaveProperty("active_team_id");
  });
});

// --- PATCH ------------------------------------------------------------------

describe("PATCH /api/conversations/[id] — title/pinned only", () => {
  it("renames and pins", async () => {
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);

    expect((await patch("c", { title: "New name" })).status).toBe(200);
    expect((await patch("c", { pinned: true })).status).toBe(200);

    const conv = await convRepo.getConversation(ACCT_A, "c");
    expect(conv?.title).toBe("New name");
    expect(conv?.pinned).toBe(true);
  });

  it("400s an empty body and a legacy active_team_id-only body", async () => {
    signedIn(ACCT_A);
    await seedConv(ACCT_A, "c", SV);
    // No recognized field → 400.
    expect((await patch("c", {})).status).toBe(400);
    // active_team_id is no longer a recognized PATCH field.
    expect((await patch("c", { active_team_id: "anything" })).status).toBe(400);
  });

  it("guest → 401, other account → 404 (isolation preserved)", async () => {
    await seedConv(ACCT_A, "c", SV);

    guest();
    expect((await patch("c", { pinned: true })).status).toBe(401);

    signedIn(ACCT_B);
    expect((await patch("c", { pinned: true })).status).toBe(404);
  });
});
