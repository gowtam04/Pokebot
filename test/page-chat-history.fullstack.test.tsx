/**
 * FULL-STACK (frontend) — the chat-history sidebar wiring on <Home/>
 * (chat-history Phase 7; history-ui-e2e checkpoint). Renders the REAL page with a
 * single stubbed `fetch` backed by an in-memory conversation store, and drives:
 *   - guest thread imported on sign-in → appears in the list (BR-H10),
 *   - open a saved conversation → its turns load, it becomes active, and the
 *     Champions toggle follows the stored format (AC-5.4),
 *   - New chat resets to an empty thread (AC-6.1),
 *   - sign-out hides the sidebar but keeps the thread,
 *   - delete the open conversation → resets to a new chat (AC-8.2).
 *
 * Imports only view + lib code (never db/repos/server-only). Vitest jsdom project.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";

import Home from "@/app/page";
import { formatSseEvent } from "@/lib/sse-types";
import { MINIMAL_ANSWER } from "@/components/test-fixtures";
import type { ChatTurn, OakAnswer } from "@/components/types";

const EMAIL = "ash@pallet.town";

interface ServerConvo {
  id: string;
  title: string;
  format: string;
  pinned: boolean;
  updatedAt: number;
  turns: ChatTurn[];
}

let serverConvos: ServerConvo[];
let meState: { signedIn: boolean; email?: string };
let clock: number;

function makeAnswer(markdown: string): OakAnswer {
  return { ...MINIMAL_ANSWER, answer_markdown: markdown };
}

/** A minimal in-memory localStorage (this jsdom config provides no real one). */
function makeStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function sseAnswerResponse(answer: OakAnswer): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(formatSseEvent("answer", { answer })));
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
}

function summary(c: ServerConvo) {
  return { id: c.id, title: c.title, format: c.format, pinned: c.pinned, updatedAt: c.updatedAt };
}

function seedConvo(c: Partial<ServerConvo> & { id: string; title: string }): void {
  serverConvos.push({
    format: "scarlet-violet",
    pinned: false,
    updatedAt: ++clock,
    turns: [],
    ...c,
  });
}

beforeEach(() => {
  serverConvos = [];
  meState = { signedIn: false };
  clock = 0;
  // Fresh in-memory localStorage per test so a persisted UI pref (e.g.
  // sidebar-collapsed) made in one test doesn't bleed into the next.
  vi.stubGlobal("localStorage", makeStorageStub());

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const parsed = new URL(u, "http://localhost");
      const path = parsed.pathname;

      // --- auth ---
      if (path === "/api/auth/me") return jsonResponse(200, meState);
      if (path === "/api/auth/request-code") return jsonResponse(200, { ok: true });
      if (path === "/api/auth/verify") {
        meState = { signedIn: true, email: EMAIL };
        return jsonResponse(200, { ok: true, email: EMAIL, created: true });
      }
      if (path === "/api/auth/signout") {
        meState = { signedIn: false };
        return jsonResponse(200, { ok: true });
      }

      // --- chat ---
      if (path === "/api/chat") {
        const body = JSON.parse(init!.body!);
        return sseAnswerResponse(makeAnswer(`answer to: ${body.message}`));
      }

      // --- conversations ---
      if (path === "/api/conversations" && method === "GET") {
        const list = [...serverConvos]
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
          .map(summary);
        return jsonResponse(200, { conversations: list });
      }
      if (path === "/api/conversations/import" && method === "POST") {
        const body = JSON.parse(init!.body!);
        const turns = body.turns as ChatTurn[];
        if (turns.length === 0) return jsonResponse(200, { id: null });
        const firstUser = turns.find((t) => t.role === "user");
        seedConvo({
          id: body.session_id,
          title: firstUser && firstUser.role === "user" ? firstUser.content : "New conversation",
          format: body.champions_mode ? "champions" : "scarlet-violet",
          turns,
        });
        return jsonResponse(200, { id: body.session_id });
      }
      if (path.startsWith("/api/conversations/")) {
        const id = decodeURIComponent(path.slice("/api/conversations/".length));
        const convo = serverConvos.find((c) => c.id === id);
        if (method === "GET") {
          if (!convo) return jsonResponse(404, { code: "not_found" });
          return jsonResponse(200, {
            id: convo.id,
            title: convo.title,
            format: convo.format,
            pinned: convo.pinned,
            turns: convo.turns,
          });
        }
        if (method === "PATCH") {
          if (!convo) return jsonResponse(404, { code: "not_found" });
          const patch = JSON.parse(init!.body!);
          if (typeof patch.title === "string") convo.title = patch.title;
          if (typeof patch.pinned === "boolean") convo.pinned = patch.pinned;
          return jsonResponse(200, { ok: true });
        }
        if (method === "DELETE") {
          serverConvos = serverConvos.filter((c) => c.id !== id);
          return jsonResponse(200, { ok: true });
        }
      }

      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signIn() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("auth-signin-button"));
  });
  fireEvent.change(screen.getByTestId("auth-email-input"), { target: { value: EMAIL } });
  await act(async () => {
    fireEvent.submit(screen.getByTestId("auth-email-step"));
  });
  await screen.findByTestId("auth-code-step");
  fireEvent.change(screen.getByTestId("auth-code-input"), { target: { value: "123456" } });
  await act(async () => {
    fireEvent.submit(screen.getByTestId("auth-code-step"));
  });
  await waitFor(() => expect(screen.getByTestId("auth-signout-button")).toBeInTheDocument());
}

async function sendAndAwait(text: string, expectedAssistantTurns: number) {
  fireEvent.change(screen.getByTestId("composer-input"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("composer-send"));
  });
  await waitFor(() =>
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(expectedAssistantTurns),
  );
}

describe("Home — chat-history sidebar", () => {
  it("imports the on-screen guest thread on sign-in and lists it (BR-H10)", async () => {
    render(<Home />);
    await screen.findByTestId("auth-signin-button");

    // Guest has no sidebar.
    expect(screen.queryByTestId("history-sidebar")).not.toBeInTheDocument();

    await sendAndAwait("What beats Garchomp?", 1);
    await signIn();

    // Sidebar appears and lists the imported conversation (title = first message).
    const sidebar = await screen.findByTestId("history-sidebar");
    await waitFor(() =>
      expect(within(sidebar).getByText("What beats Garchomp?")).toBeInTheDocument(),
    );
    // The on-screen thread is untouched.
    expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
  });

  it("opens a saved conversation: loads its turns, activates it, follows its format", async () => {
    seedConvo({
      id: "champ-convo",
      title: "Champions rain team",
      format: "champions",
      turns: [
        { id: "u1", role: "user", content: "Build a rain team" },
        { id: "a1", role: "assistant", answer: makeAnswer("Here is a rain team") },
      ],
    });

    render(<Home />);
    await screen.findByTestId("auth-signin-button");
    await signIn();

    const sidebar = await screen.findByTestId("history-sidebar");
    const row = await within(sidebar).findByTitle("Champions rain team");
    await act(async () => {
      fireEvent.click(row);
    });

    // Turns load into the thread.
    await waitFor(() => expect(screen.getByText("Build a rain team")).toBeInTheDocument());
    expect(screen.getByText("Here is a rain team")).toBeInTheDocument();
    // Champions toggle follows the stored format (AC-5.4).
    expect(screen.getByTestId("champions-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("New chat resets to an empty thread (AC-6.1)", async () => {
    render(<Home />);
    await screen.findByTestId("auth-signin-button");
    await sendAndAwait("a question", 1);
    await signIn();

    const sidebar = await screen.findByTestId("history-sidebar");
    await act(async () => {
      fireEvent.click(within(sidebar).getByTestId("new-chat"));
    });
    expect(screen.queryByTestId("user-turn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-turn")).not.toBeInTheDocument();
  });

  it("sign-out hides the sidebar but keeps the thread", async () => {
    render(<Home />);
    await screen.findByTestId("auth-signin-button");
    await sendAndAwait("keep me", 1);
    await signIn();
    await screen.findByTestId("history-sidebar");

    await act(async () => {
      fireEvent.click(screen.getByTestId("auth-signout-button"));
    });
    await waitFor(() => expect(screen.getByTestId("auth-signin-button")).toBeInTheDocument());

    expect(screen.queryByTestId("history-sidebar")).not.toBeInTheDocument();
    // Thread persists across the user→guest transition.
    expect(screen.getByText("keep me")).toBeInTheDocument();
  });

  it("toggles the sidebar collapsed/expanded and persists the choice", async () => {
    render(<Home />);
    await screen.findByTestId("auth-signin-button");

    // Guest: no toggle (the sidebar itself is also absent).
    expect(screen.queryByTestId("sidebar-toggle")).not.toBeInTheDocument();

    await signIn();
    const sidebar = await screen.findByTestId("history-sidebar");
    const toggle = screen.getByTestId("sidebar-toggle");
    const inner = sidebar.querySelector(".chat-page__sidebar-inner")!;

    // Starts expanded (no stored pref; jsdom has no matchMedia → not narrow).
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).not.toHaveClass("chat-page__sidebar--collapsed");
    expect(inner).not.toHaveAttribute("inert");

    // Collapse.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(sidebar).toHaveClass("chat-page__sidebar--collapsed");
    expect(inner).toHaveAttribute("inert");
    expect(localStorage.getItem("oak-sidebar-collapsed")).toBe("true");

    // Expand again.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).not.toHaveClass("chat-page__sidebar--collapsed");
    expect(inner).not.toHaveAttribute("inert");
    expect(localStorage.getItem("oak-sidebar-collapsed")).toBe("false");
  });

  it("deleting the open conversation resets to a new chat (AC-8.2)", async () => {
    seedConvo({
      id: "to-delete",
      title: "Doomed thread",
      turns: [
        { id: "u1", role: "user", content: "doomed question" },
        { id: "a1", role: "assistant", answer: makeAnswer("doomed answer") },
      ],
    });

    render(<Home />);
    await screen.findByTestId("auth-signin-button");
    await signIn();

    const sidebar = await screen.findByTestId("history-sidebar");
    const row = await within(sidebar).findByTitle("Doomed thread");
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(screen.getByText("doomed question")).toBeInTheDocument());

    // Delete it from its row (confirm step).
    const rowEl = within(sidebar).getByTestId("conversation-row");
    await act(async () => {
      fireEvent.click(within(rowEl).getByRole("button", { name: "Delete conversation" }));
    });
    await act(async () => {
      fireEvent.click(within(rowEl).getByRole("button", { name: "Confirm delete" }));
    });

    // Thread reset to empty, and the row is gone from the list.
    await waitFor(() => expect(screen.queryByText("doomed question")).not.toBeInTheDocument());
    expect(screen.queryByTestId("user-turn")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(sidebar).queryByTitle("Doomed thread")).not.toBeInTheDocument(),
    );
  });
});
