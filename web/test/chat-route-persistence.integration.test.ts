/**
 * Integration test for the SIGNED-IN chat persistence + resume seam of
 * `POST /api/chat` (docs/features/chat-history Phase 4; HIST-US-1, HIST-US-5,
 * AC-1.1, AC-1.2, AC-5.1, AC-5.3, AC-5.4, BR-H2, BR-H5, BR-H6).
 *
 * Like api-chat.integration.test.ts the runtime + context are mocked (no model),
 * but here `getCurrentAccount` resolves a real account and the conversation-repo
 * writes/reads a real migrated Postgres schema (Testcontainers). Asserts:
 *   - a signed-in turn creates the conversation (title from message) + stores the
 *     full OakAnswer,
 *   - a follow-up feeds the DB-derived history to the model and continues the
 *     SAME conversation (seq advances),
 *   - a resumed conversation's mode follows its stored format (BR-H6),
 *   - an aborted turn persists nothing,
 *   - the guest path persists nothing to the DB.
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

import type { ChatMessage } from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";
import type { Account } from "@/data/repos/accounts-repo";

vi.mock("server-only", () => ({}));

const { meMock } = vi.hoisted(() => ({ meMock: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ getCurrentAccount: meMock }));

const { mockRunOak, capturedHistories, capturedModes } = vi.hoisted(() => ({
  mockRunOak: vi.fn(),
  capturedHistories: [] as ChatMessage[][],
  capturedModes: [] as string[],
}));
vi.mock("@/agent/runtime", () => ({ runOak: mockRunOak }));
vi.mock("@/agent/context", () => ({
  createAgentContext: vi.fn(async (opts: { mode: string }) => {
    capturedModes.push(opts.mode);
    return {
      db: {},
      requestId: "test-req",
      mode: opts.mode,
      logger: { info: () => {}, error: () => {}, bindings: () => ({}) },
    };
  }),
}));

import { POST } from "@/app/api/chat/route";
import { _resetStoreForTests } from "@/server/rate-limit";
import { createPgSchema, installAsSingleton, type PgFixture } from "./support/pg";

let fix: PgFixture;
type Repo = typeof import("@/data/repos/conversation-repo");
let repo: Repo;

const ACCT: Account = { id: "acct-persist", email: "p@x.com", createdAt: 1 };

let nextAnswer: OakAnswer;

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

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  repo = await import("@/data/repos/conversation-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  vi.clearAllMocks();
  _resetStoreForTests();
  capturedHistories.length = 0;
  capturedModes.length = 0;
  nextAnswer = makeAnswer("default answer");
  meMock.mockResolvedValue(ACCT);
  mockRunOak.mockImplementation(async (_message: string, history: ChatMessage[]) => {
    capturedHistories.push(history);
    return nextAnswer;
  });
  await fix.db.execute(
    sql`TRUNCATE TABLE conversation, conversation_message RESTART IDENTITY`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(
  body: { session_id: string; message: string; champions_mode?: boolean },
  init?: { signal?: AbortSignal },
): Promise<Response> {
  const res = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: init?.signal,
    }),
  );
  // Drain the stream so the detached async task (persistence) completes.
  await res.text();
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signed-in persistence", () => {
  it("creates the conversation + stores the full answer on the first turn (AC-1.1)", async () => {
    const sid = randomUUID();
    nextAnswer = makeAnswer("Ice and Fairy types beat it.");
    await post({ session_id: sid, message: "What beats Garchomp?" });

    const conv = await repo.getConversation(ACCT.id, sid);
    expect(conv).toMatchObject({
      id: sid,
      title: "What beats Garchomp?",
      format: "scarlet-violet",
      pinned: false,
    });
    const stored = await repo.getMessages(ACCT.id, sid);
    expect(stored.map((t) => [t.seq, t.role, t.textContent])).toEqual([
      [0, "user", "What beats Garchomp?"],
      [1, "assistant", "Ice and Fairy types beat it."],
    ]);
    expect(JSON.parse(stored[1].answerJson!).answer_markdown).toBe(
      "Ice and Fairy types beat it.",
    );
  });

  it("feeds DB-derived history and continues the SAME conversation on a follow-up (AC-5.1)", async () => {
    const sid = randomUUID();
    nextAnswer = makeAnswer("first answer");
    await post({ session_id: sid, message: "first question" });

    nextAnswer = makeAnswer("second answer");
    await post({ session_id: sid, message: "second question" });

    // The follow-up's history (2nd call) is the DB-stored prior turns.
    const followUpHistory = capturedHistories[1];
    expect(followUpHistory).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);

    // Same conversation, four ordered turns.
    const stored = await repo.getMessages(ACCT.id, sid);
    expect(stored.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
  });

  it("overrides mode from the stored format when resuming (BR-H6)", async () => {
    const sid = randomUUID();
    // Seed a champions conversation directly.
    await repo.appendTurnPair({
      accountId: ACCT.id,
      conversationId: sid,
      format: "champions",
      userTurnId: repo.newTurnId(),
      userMessage: "champ q",
      assistantTurnId: repo.newTurnId(),
      answer: makeAnswer("champ a"),
      now: 1000,
    });

    // Continue WITHOUT champions_mode in the body — mode must follow the stored
    // format, not the body.
    await post({ session_id: sid, message: "follow up", champions_mode: false });
    expect(capturedModes[0]).toBe("champions");
  });

  it("still delivers the answer event to the client (persist is off the critical path)", async () => {
    const sid = randomUUID();
    nextAnswer = makeAnswer("delivered");
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid, message: "q" }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("event: answer");
    expect(text).toContain("delivered");
  });

  it("persists nothing when the turn is aborted (AC-1.2)", async () => {
    const sid = randomUUID();
    await post({ session_id: sid, message: "q" }, { signal: AbortSignal.abort() });
    expect(await repo.getConversation(ACCT.id, sid)).toBeNull();
  });
});

describe("guest path", () => {
  it("persists nothing to the DB for a guest", async () => {
    meMock.mockResolvedValue(null);
    const sid = randomUUID();
    await post({ session_id: sid, message: "guest question" });
    // No account → no DB write. (Listing under the seeded account stays empty.)
    expect(await repo.listConversations(ACCT.id)).toEqual([]);
  });
});
