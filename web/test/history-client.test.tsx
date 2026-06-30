/**
 * Unit tests for src/lib/api/history-client.ts (chat-history Phase 5). `fetch` is
 * stubbed; asserts the never-throw contract — success maps to typed values, and
 * HTTP errors / transport faults fold into safe defaults ([] / null / false).
 * Runs under the jsdom project (test/**\/*.test.tsx).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteConversation,
  getConversation,
  importConversation,
  listConversations,
  renameConversation,
  setPinned,
} from "@/lib/api/history-client";
import type { OakAnswer } from "@/components/types";

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

const ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown: "hi",
  reasoning_markdown: "r",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listConversations", () => {
  it("returns the conversations array on 200", async () => {
    stubFetch(async () =>
      res(200, { conversations: [{ id: "a", title: "A", format: "scarlet-violet", pinned: false, updatedAt: 1 }] }),
    );
    const list = await listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
  });

  it("passes q and format as query params", async () => {
    const fetchMock = vi.fn(async () => res(200, { conversations: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listConversations({ q: "garchomp", format: "champions" });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const url = String(calls[0][0]);
    expect(url).toContain("q=garchomp");
    expect(url).toContain("format=champions");
  });

  it("returns [] on a malformed body / error / network throw", async () => {
    stubFetch(async () => res(200, { nope: true }));
    expect(await listConversations()).toEqual([]);
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await listConversations()).toEqual([]);
  });
});

describe("getConversation", () => {
  it("returns the detail on 200", async () => {
    stubFetch(async () =>
      res(200, { id: "x", title: "T", format: "scarlet-violet", pinned: false, turns: [] }),
    );
    const detail = await getConversation("x");
    expect(detail?.id).toBe("x");
  });

  it("returns null on 404 and on a transport fault", async () => {
    stubFetch(async () => res(404, { code: "not_found" }));
    expect(await getConversation("x")).toBeNull();
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await getConversation("x")).toBeNull();
  });
});

describe("renameConversation / setPinned", () => {
  it("returns true on 200 and sends the right PATCH body", async () => {
    const fetchMock = vi.fn(async () => res(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;

    expect(await renameConversation("id1", "New")).toBe(true);
    const init = calls[0][1]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ title: "New" });

    expect(await setPinned("id1", true)).toBe(true);
    expect(JSON.parse(calls[1][1]!.body as string)).toEqual({ pinned: true });
  });

  it("returns false on a non-ok response / throw", async () => {
    stubFetch(async () => res(404, { code: "not_found" }));
    expect(await renameConversation("id1", "x")).toBe(false);
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await setPinned("id1", false)).toBe(false);
  });
});

describe("deleteConversation", () => {
  it("treats 200 and 404 as success (idempotent), 500 as failure", async () => {
    stubFetch(async () => res(200, { ok: true }));
    expect(await deleteConversation("id1")).toBe(true);
    stubFetch(async () => res(404, { code: "not_found" }));
    expect(await deleteConversation("id1")).toBe(true);
    stubFetch(async () => res(500, {}));
    expect(await deleteConversation("id1")).toBe(false);
  });
});

describe("importConversation", () => {
  it("returns the id on success", async () => {
    stubFetch(async () => res(200, { id: "sess-1" }));
    expect(await importConversation("sess-1", false, [
      { id: "t1", role: "user", content: "hi" },
      { id: "t2", role: "assistant", answer: ANSWER },
    ])).toBe("sess-1");
  });

  it("returns null when the body id is null / non-ok / throw", async () => {
    stubFetch(async () => res(200, { id: null }));
    expect(await importConversation("s", false, [])).toBeNull();
    stubFetch(async () => res(401, { code: "unauthorized" }));
    expect(await importConversation("s", false, [])).toBeNull();
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await importConversation("s", false, [])).toBeNull();
  });
});
