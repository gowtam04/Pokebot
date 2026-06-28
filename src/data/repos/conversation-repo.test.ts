/**
 * Oracle tests for src/data/repos/conversation-repo.ts — the sole Postgres
 * reader/writer for durable chat history (docs/features/chat-history). Asserts
 * behaviour against a real migrated Postgres schema (Testcontainers).
 *
 * Like accounts-repo.test.ts the repo reads the `@/data/db` SINGLETON, so the
 * harness installs the fixture as the singleton BEFORE the first dynamic import
 * of the repo, and `server-only` is neutralised under the vitest node env.
 *
 * Account isolation (BR-H1) is asserted explicitly: every read is account-scoped
 * and a different account sees null/[].
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

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";

import type { OakAnswer } from "@/agent/schemas";
import type { ChatTurn } from "@/components/types";

type Repo = typeof import("./conversation-repo");

let fix: PgFixture;
let repo: Repo;

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);
  repo = await import("./conversation-repo");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  await fix.db.execute(
    sql`TRUNCATE TABLE conversation, conversation_message RESTART IDENTITY`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCT_A = "account-a";
const ACCT_B = "account-b";
const SV = "scarlet-violet";
const CH = "champions";

function makeAnswer(markdown: string): OakAnswer {
  return {
    status: "answered",
    answer_markdown: markdown,
    reasoning_markdown: "because reasons",
    citations: [],
    inferences: [],
    generation_basis: { generation: "gen-9", fallback: false },
  };
}

function userTurn(content: string): ChatTurn {
  return { id: randomUUID(), role: "user", content };
}
function assistantTurn(markdown: string): ChatTurn {
  return { id: randomUUID(), role: "assistant", answer: makeAnswer(markdown) };
}

async function append(
  accountId: string,
  conversationId: string,
  format: string,
  userMessage: string,
  answerMarkdown: string,
  now: number,
): Promise<void> {
  await repo.appendTurnPair({
    accountId,
    conversationId,
    format,
    userTurnId: repo.newTurnId(),
    userMessage,
    assistantTurnId: repo.newTurnId(),
    answer: makeAnswer(answerMarkdown),
    now,
  });
}

// ---------------------------------------------------------------------------
// appendTurnPair — creation, seq, continuation (BR-H2, BR-H7)
// ---------------------------------------------------------------------------

describe("appendTurnPair", () => {
  it("creates the conversation with a derived title + format on the first turn", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "What beats Garchomp?", "Ice types.", 1000);

    const conv = await repo.getConversation(ACCT_A, id);
    expect(conv).toMatchObject({
      id,
      accountId: ACCT_A,
      title: "What beats Garchomp?",
      format: SV,
      pinned: false,
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it("stores both turns with monotonic seq, text_content, and assistant answer_json", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "hi", "hello there", 1000);

    const turns = await repo.getMessages(ACCT_A, id);
    expect(turns.map((t) => [t.seq, t.role, t.textContent])).toEqual([
      [0, "user", "hi"],
      [1, "assistant", "hello there"],
    ]);
    expect(turns[0].answerJson).toBeNull();
    const parsed = JSON.parse(turns[1].answerJson!) as OakAnswer;
    expect(parsed.answer_markdown).toBe("hello there");
    expect(parsed.status).toBe("answered");
  });

  it("continues the same conversation (seq advances, updated_at bumps, title fixed)", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "first question", "a1", 1000);
    await append(ACCT_A, id, SV, "second question", "a2", 2000);

    const conv = await repo.getConversation(ACCT_A, id);
    expect(conv?.createdAt).toBe(1000);
    expect(conv?.updatedAt).toBe(2000); // bumped
    expect(conv?.title).toBe("first question"); // fixed at creation

    const turns = await repo.getMessages(ACCT_A, id);
    expect(turns.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
    expect(turns.map((t) => t.textContent)).toEqual([
      "first question",
      "a1",
      "second question",
      "a2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Account isolation (BR-H1)
// ---------------------------------------------------------------------------

describe("account isolation", () => {
  it("getConversation / getMessages return null/[] for another account", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "private thread", "secret", 1000);

    expect(await repo.getConversation(ACCT_B, id)).toBeNull();
    expect(await repo.getMessages(ACCT_B, id)).toEqual([]);
    // owner still sees it
    expect(await repo.getConversation(ACCT_A, id)).not.toBeNull();
  });

  it("listConversations only returns the asking account's conversations", async () => {
    await append(ACCT_A, randomUUID(), SV, "A1", "x", 1000);
    await append(ACCT_B, randomUUID(), SV, "B1", "y", 1000);

    const listA = await repo.listConversations(ACCT_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].title).toBe("A1");
  });
});

// ---------------------------------------------------------------------------
// listConversations — ordering + filters (HIST-US-3, HIST-US-10, HIST-US-11, BR-H11)
// ---------------------------------------------------------------------------

describe("listConversations", () => {
  it("orders pinned first, then most-recently-active", async () => {
    const older = randomUUID();
    const newer = randomUUID();
    const pinned = randomUUID();
    await append(ACCT_A, older, SV, "older", "x", 1000);
    await append(ACCT_A, newer, SV, "newer", "x", 3000);
    await append(ACCT_A, pinned, SV, "pinned", "x", 2000);
    await repo.setPinned(ACCT_A, pinned, true);

    const list = await repo.listConversations(ACCT_A);
    expect(list.map((c) => c.title)).toEqual(["pinned", "newer", "older"]);
    expect(list[0].pinned).toBe(true);
  });

  it("q filters by title (case-insensitive)", async () => {
    await append(ACCT_A, randomUUID(), SV, "Garchomp counters", "x", 1000);
    await append(ACCT_A, randomUUID(), SV, "Best Trick Room mons", "x", 2000);

    const list = await repo.listConversations(ACCT_A, { q: "garchomp" });
    expect(list.map((c) => c.title)).toEqual(["Garchomp counters"]);
  });

  it("q filters by message text, not just title (BR-H11)", async () => {
    const id = randomUUID();
    // title is the first user message ("hi"); the match is in a later turn.
    await append(ACCT_A, id, SV, "hi", "Iron Valiant outspeeds it.", 1000);
    await append(ACCT_A, randomUUID(), SV, "unrelated", "nothing here", 2000);

    const list = await repo.listConversations(ACCT_A, { q: "iron valiant" });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
  });

  it("format filters the list", async () => {
    await append(ACCT_A, randomUUID(), SV, "standard one", "x", 1000);
    await append(ACCT_A, randomUUID(), CH, "champions one", "x", 2000);

    const sv = await repo.listConversations(ACCT_A, { format: SV });
    expect(sv.map((c) => c.title)).toEqual(["standard one"]);
    const ch = await repo.listConversations(ACCT_A, { format: CH });
    expect(ch.map((c) => c.title)).toEqual(["champions one"]);
  });

  it("treats user-typed % literally (no wildcard surface)", async () => {
    await append(ACCT_A, randomUUID(), SV, "100% effective", "x", 1000);
    await append(ACCT_A, randomUUID(), SV, "plain title", "x", 2000);

    // A literal "%" should not match every title.
    const list = await repo.listConversations(ACCT_A, { q: "100%" });
    expect(list.map((c) => c.title)).toEqual(["100% effective"]);
  });
});

// ---------------------------------------------------------------------------
// importConversation — idempotent guest→sign-in bulk save (HIST-US-12, BR-H10)
// ---------------------------------------------------------------------------

describe("importConversation", () => {
  it("returns null and creates nothing for empty turns (AC-12.2)", async () => {
    const id = randomUUID();
    const result = await repo.importConversation({
      accountId: ACCT_A,
      id,
      format: SV,
      turns: [],
      now: 1000,
    });
    expect(result).toBeNull();
    expect(await repo.getConversation(ACCT_A, id)).toBeNull();
  });

  it("imports a thread (title from first user message, full fidelity)", async () => {
    const id = randomUUID();
    const turns = [
      userTurn("Build me a rain team"),
      assistantTurn("Here is a rain team..."),
      userTurn("make it weak to Trick Room instead"),
      assistantTurn("Adjusted..."),
    ];
    const result = await repo.importConversation({
      accountId: ACCT_A,
      id,
      format: CH,
      turns,
      now: 1000,
    });
    expect(result).toBe(id);

    const conv = await repo.getConversation(ACCT_A, id);
    expect(conv?.title).toBe("Build me a rain team");
    expect(conv?.format).toBe(CH);

    const stored = await repo.getMessages(ACCT_A, id);
    expect(stored.map((t) => [t.seq, t.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "user"],
      [3, "assistant"],
    ]);
    expect(JSON.parse(stored[1].answerJson!).answer_markdown).toBe(
      "Here is a rain team...",
    );
  });

  it("is idempotent — re-importing the same turns is a no-op", async () => {
    const id = randomUUID();
    const turns = [userTurn("hello"), assistantTurn("hi")];
    await repo.importConversation({ accountId: ACCT_A, id, format: SV, turns, now: 1000 });
    await repo.importConversation({ accountId: ACCT_A, id, format: SV, turns, now: 2000 });

    const stored = await repo.getMessages(ACCT_A, id);
    expect(stored).toHaveLength(2); // not duplicated
  });

  it("refuses to write into a conversation owned by another account (BR-H1)", async () => {
    const id = randomUUID();
    // Account A creates a conversation with this id.
    await append(ACCT_A, id, SV, "A owns this", "x", 1000);
    // Account B tries to import using the same id.
    const result = await repo.importConversation({
      accountId: ACCT_B,
      id,
      format: SV,
      turns: [userTurn("intrusion"), assistantTurn("nope")],
      now: 2000,
    });
    expect(result).toBeNull();
    // A's conversation is untouched; B sees nothing.
    expect((await repo.getMessages(ACCT_A, id)).map((t) => t.textContent)).toEqual([
      "A owns this",
      "x",
    ]);
    expect(await repo.getConversation(ACCT_B, id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rename / pin (HIST-US-7, HIST-US-9)
// ---------------------------------------------------------------------------

describe("rename + pin", () => {
  it("renameConversation persists and is account-scoped", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "old title", "x", 1000);

    await repo.renameConversation(ACCT_A, id, "New Name");
    expect((await repo.getConversation(ACCT_A, id))?.title).toBe("New Name");

    // Another account cannot rename it (no-op).
    await repo.renameConversation(ACCT_B, id, "Hijacked");
    expect((await repo.getConversation(ACCT_A, id))?.title).toBe("New Name");
  });

  it("setPinned toggles the pinned flag", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "t", "x", 1000);

    await repo.setPinned(ACCT_A, id, true);
    expect((await repo.getConversation(ACCT_A, id))?.pinned).toBe(true);
    await repo.setPinned(ACCT_A, id, false);
    expect((await repo.getConversation(ACCT_A, id))?.pinned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteConversation — permanent + scoped (HIST-US-8, BR-H8)
// ---------------------------------------------------------------------------

describe("deleteConversation", () => {
  it("removes the conversation and all its messages", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "doomed", "x", 1000);

    await repo.deleteConversation(ACCT_A, id);
    expect(await repo.getConversation(ACCT_A, id)).toBeNull();
    expect(await repo.getMessages(ACCT_A, id)).toEqual([]);
  });

  it("is idempotent (deleting an absent id is a no-op)", async () => {
    await expect(
      repo.deleteConversation(ACCT_A, "no-such-id"),
    ).resolves.toBeUndefined();
  });

  it("does not delete another account's conversation", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "A's thread", "x", 1000);

    await repo.deleteConversation(ACCT_B, id); // wrong account → no-op
    expect(await repo.getConversation(ACCT_A, id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// active team — round-trips on append/import + setActiveTeam (BR-T9, TEAM-US-8)
// ---------------------------------------------------------------------------

describe("active team", () => {
  it("defaults activeTeamId to null when no team is supplied", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "no team", "x", 1000);
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBeNull();
  });

  it("appendTurnPair persists active_team_id on creation; getConversation returns it", async () => {
    const id = randomUUID();
    await repo.appendTurnPair({
      accountId: ACCT_A,
      conversationId: id,
      format: SV,
      userTurnId: repo.newTurnId(),
      userMessage: "with team",
      assistantTurnId: repo.newTurnId(),
      answer: makeAnswer("ok"),
      now: 1000,
      activeTeamId: "team-1",
    });
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-1");
  });

  it("a continuation updates active_team_id last-selected-wins, and leaves it when omitted", async () => {
    const id = randomUUID();
    await repo.appendTurnPair({
      accountId: ACCT_A,
      conversationId: id,
      format: SV,
      userTurnId: repo.newTurnId(),
      userMessage: "q1",
      assistantTurnId: repo.newTurnId(),
      answer: makeAnswer("a1"),
      now: 1000,
      activeTeamId: "team-1",
    });
    // Next turn selects a different team.
    await repo.appendTurnPair({
      accountId: ACCT_A,
      conversationId: id,
      format: SV,
      userTurnId: repo.newTurnId(),
      userMessage: "q2",
      assistantTurnId: repo.newTurnId(),
      answer: makeAnswer("a2"),
      now: 2000,
      activeTeamId: "team-2",
    });
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-2");

    // A turn that omits activeTeamId leaves the stored value untouched.
    await append(ACCT_A, id, SV, "q3", "a3", 3000);
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-2");
  });

  it("setActiveTeam sets and clears, account-scoped", async () => {
    const id = randomUUID();
    await append(ACCT_A, id, SV, "thread", "x", 1000);

    await repo.setActiveTeam(ACCT_A, id, "team-9");
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-9");

    // Another account cannot change it (no-op).
    await repo.setActiveTeam(ACCT_B, id, "hijack");
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-9");

    // Clear with null.
    await repo.setActiveTeam(ACCT_A, id, null);
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBeNull();
  });

  it("importConversation carries active_team_id", async () => {
    const id = randomUUID();
    const result = await repo.importConversation({
      accountId: ACCT_A,
      id,
      format: SV,
      turns: [userTurn("hi"), assistantTurn("hello")],
      now: 1000,
      activeTeamId: "team-imported",
    });
    expect(result).toBe(id);
    expect((await repo.getConversation(ACCT_A, id))?.activeTeamId).toBe("team-imported");
  });
});
