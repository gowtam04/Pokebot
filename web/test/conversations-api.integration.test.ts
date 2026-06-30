/**
 * Integration tests for the `/api/conversations/*` HTTP surface
 * (docs/features/chat-history Phase 3). Drives the real route handlers against a
 * real migrated Postgres schema (Testcontainers); `getCurrentAccount` is mocked
 * to flip between guest / account A / account B.
 *
 * Asserts: guest gating (empty list / 401), account isolation (404, no leak),
 * list ordering + q/format filters, full-fidelity round-trip, rename/pin via
 * PATCH, permanent delete, and import validation + idempotency.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const { meMock } = vi.hoisted(() => ({ meMock: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ getCurrentAccount: meMock }));

import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";

import type { OakAnswer } from "@/agent/schemas";
import type { Account } from "@/data/repos/accounts-repo";

// Route handlers (their repo + current-user are loaded dynamically at call time,
// so importing the modules does NOT touch @/data/db before installAsSingleton).
import { GET as listGET } from "@/app/api/conversations/route";
import {
  GET as byIdGET,
  PATCH as byIdPATCH,
  DELETE as byIdDELETE,
} from "@/app/api/conversations/[id]/route";
import { POST as importPOST } from "@/app/api/conversations/import/route";

let fix: PgFixture;
type Repo = typeof import("@/data/repos/conversation-repo");
let repo: Repo;

const ACCT_A: Account = { id: "acct-a", email: "a@x.com", createdAt: 1 };
const ACCT_B: Account = { id: "acct-b", email: "b@x.com", createdAt: 1 };

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  repo = await import("@/data/repos/conversation-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  meMock.mockReset();
  await fix.db.execute(
    sql`TRUNCATE TABLE conversation, conversation_message RESTART IDENTITY`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signedInAs(account: Account | null): void {
  meMock.mockResolvedValue(account);
}

function makeAnswer(markdown: string): OakAnswer {
  return {
    status: "answered",
    answer_markdown: markdown,
    reasoning_markdown: "r",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
  };
}

async function seedConversation(
  account: Account,
  opts: { title: string; format?: string; now: number; answerText?: string },
): Promise<string> {
  const id = randomUUID();
  await repo.appendTurnPair({
    accountId: account.id,
    conversationId: id,
    format: opts.format ?? "scarlet-violet",
    userTurnId: repo.newTurnId(),
    userMessage: opts.title,
    assistantTurnId: repo.newTurnId(),
    answer: makeAnswer(opts.answerText ?? "an answer"),
    now: opts.now,
  });
  return id;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, init?: RequestInit) =>
  new Request(`http://localhost${url}`, init);

// ---------------------------------------------------------------------------
// Guest gating (BR-H1)
// ---------------------------------------------------------------------------

describe("guest gating", () => {
  beforeEach(() => signedInAs(null));

  it("GET list → 200 empty for a guest", async () => {
    const res = await listGET(req("/api/conversations"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [] });
  });

  it("GET / PATCH / DELETE [id] → 401 for a guest", async () => {
    expect((await byIdGET(req("/api/conversations/x"), ctx("x"))).status).toBe(401);
    expect(
      (
        await byIdPATCH(
          req("/api/conversations/x", {
            method: "PATCH",
            body: JSON.stringify({ title: "n" }),
          }),
          ctx("x"),
        )
      ).status,
    ).toBe(401);
    expect(
      (await byIdDELETE(req("/api/conversations/x", { method: "DELETE" }), ctx("x")))
        .status,
    ).toBe(401);
  });

  it("POST import → 401 for a guest", async () => {
    const res = await importPOST(
      req("/api/conversations/import", {
        method: "POST",
        body: JSON.stringify({ session_id: "s", champions_mode: false, turns: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// List — ordering + filters
// ---------------------------------------------------------------------------

describe("GET /api/conversations", () => {
  it("orders pinned first then recent, scoped to the account", async () => {
    signedInAs(ACCT_A);
    await seedConversation(ACCT_A, { title: "older", now: 1000 });
    await seedConversation(ACCT_A, { title: "newer", now: 3000 });
    const pinned = await seedConversation(ACCT_A, { title: "pinned", now: 2000 });
    await repo.setPinned(ACCT_A.id, pinned, true);
    // Another account's conversation must not appear (isolation).
    signedInAs(ACCT_B);
    await seedConversation(ACCT_B, { title: "B-only", now: 5000 });

    signedInAs(ACCT_A);
    const res = await listGET(req("/api/conversations"));
    const body = await res.json();
    expect(body.conversations.map((c: { title: string }) => c.title)).toEqual([
      "pinned",
      "newer",
      "older",
    ]);
  });

  it("filters by q (title or message text) and by format", async () => {
    signedInAs(ACCT_A);
    await seedConversation(ACCT_A, {
      title: "hi",
      now: 1000,
      answerText: "Iron Valiant outspeeds it",
    });
    await seedConversation(ACCT_A, { title: "champions thread", format: "champions", now: 2000 });

    const byText = await (await listGET(req("/api/conversations?q=iron%20valiant"))).json();
    expect(byText.conversations).toHaveLength(1);
    expect(byText.conversations[0].title).toBe("hi");

    const byFormat = await (
      await listGET(req("/api/conversations?format=champions"))
    ).json();
    expect(byFormat.conversations.map((c: { title: string }) => c.title)).toEqual([
      "champions thread",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET [id] — round-trip + isolation
// ---------------------------------------------------------------------------

describe("GET /api/conversations/[id]", () => {
  it("returns full-fidelity turns (assistant answer rehydrated)", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, {
      title: "What beats Garchomp?",
      now: 1000,
      answerText: "Ice and Fairy types.",
    });

    const res = await byIdGET(req(`/api/conversations/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, title: "What beats Garchomp?", format: "scarlet-violet", pinned: false });
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]).toEqual({ id: expect.any(String), role: "user", content: "What beats Garchomp?" });
    expect(body.turns[1].role).toBe("assistant");
    expect(body.turns[1].answer.answer_markdown).toBe("Ice and Fairy types.");
    expect(body.turns[1].answer.status).toBe("answered");
  });

  it("returns 404 for another account's conversation (no existence leak)", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "private", now: 1000 });

    signedInAs(ACCT_B);
    const res = await byIdGET(req(`/api/conversations/${id}`), ctx(id));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH — rename + pin
// ---------------------------------------------------------------------------

describe("PATCH /api/conversations/[id]", () => {
  it("renames and pins, reflected on a subsequent GET", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "old", now: 1000 });

    const patch = await byIdPATCH(
      req(`/api/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed", pinned: true }),
      }),
      ctx(id),
    );
    expect(patch.status).toBe(200);

    const body = await (await byIdGET(req(`/api/conversations/${id}`), ctx(id))).json();
    expect(body.title).toBe("Renamed");
    expect(body.pinned).toBe(true);
  });

  it("rejects an empty title with 400", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "t", now: 1000 });
    const res = await byIdPATCH(
      req(`/api/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "   " }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when patching another account's conversation", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "t", now: 1000 });
    signedInAs(ACCT_B);
    const res = await byIdPATCH(
      req(`/api/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "hijack" }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE — permanent + isolation
// ---------------------------------------------------------------------------

describe("DELETE /api/conversations/[id]", () => {
  it("permanently deletes an owned conversation", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "doomed", now: 1000 });

    const del = await byIdDELETE(req(`/api/conversations/${id}`, { method: "DELETE" }), ctx(id));
    expect(del.status).toBe(200);

    const after = await byIdGET(req(`/api/conversations/${id}`), ctx(id));
    expect(after.status).toBe(404);
  });

  it("returns 404 when deleting another account's conversation", async () => {
    signedInAs(ACCT_A);
    const id = await seedConversation(ACCT_A, { title: "t", now: 1000 });
    signedInAs(ACCT_B);
    const res = await byIdDELETE(req(`/api/conversations/${id}`, { method: "DELETE" }), ctx(id));
    expect(res.status).toBe(404);
    // A's conversation survives.
    signedInAs(ACCT_A);
    expect((await byIdGET(req(`/api/conversations/${id}`), ctx(id))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST import — validation + idempotency (HIST-US-12, BR-H10)
// ---------------------------------------------------------------------------

describe("POST /api/conversations/import", () => {
  beforeEach(() => signedInAs(ACCT_A));

  function importBody(sessionId: string, turns: unknown[], championsMode = false) {
    return req("/api/conversations/import", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, champions_mode: championsMode, turns }),
    });
  }

  it("imports a thread and is idempotent", async () => {
    const sid = randomUUID();
    const turns = [
      { id: randomUUID(), role: "user", content: "build a team" },
      { id: randomUUID(), role: "assistant", answer: makeAnswer("here you go") },
    ];

    const first = await importPOST(importBody(sid, turns));
    expect(first.status).toBe(200);
    expect((await first.json()).id).toBe(sid);

    // Re-import → idempotent (still 200, no duplicate rows).
    const second = await importPOST(importBody(sid, turns));
    expect(second.status).toBe(200);

    const stored = await repo.getMessages(ACCT_A.id, sid);
    expect(stored).toHaveLength(2);
  });

  it("empty turns create nothing (200 { id: null })", async () => {
    const res = await importPOST(importBody(randomUUID(), []));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBeNull();
  });

  it("rejects a malformed assistant answer with 400 invalid_turns", async () => {
    const turns = [
      { id: randomUUID(), role: "user", content: "hi" },
      { id: randomUUID(), role: "assistant", answer: { status: "answered" } }, // missing fields
    ];
    const res = await importPOST(importBody(randomUUID(), turns));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_turns");
  });

  it("derives champions format from champions_mode", async () => {
    const sid = randomUUID();
    const turns = [{ id: randomUUID(), role: "user", content: "champ thread" }];
    await importPOST(importBody(sid, turns, true));
    const conv = await repo.getConversation(ACCT_A.id, sid);
    expect(conv?.format).toBe("champions");
  });
});
