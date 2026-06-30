/**
 * FULL-STACK (frontend) — the Stop-button flow on the chat page.
 *
 * Renders the real <Home/> page (composer + thread + the `useSseClient` hook)
 * with a stubbed `fetch` that returns a never-closing SSE body, so the turn
 * stays "thinking" and the Send button becomes a Stop button. We then assert:
 *   - a quick stop (<2s) wipes the thread, restores the message into the
 *     composer, and the next send uses a brand-new session id;
 *   - a stop after >=2s leaves the (answer-less) question in the thread and does
 *     NOT prefill.
 *
 * Imports only view code + the client hook — never db/repos/runtime. Runs in the
 * Vitest "jsdom" project.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

import Home from "@/app/page";

// Request bodies captured from each fetch call (to inspect session_id / message).
let fetchBodies: Array<{ session_id: string; message: string }>;

/** A response whose body never enqueues or closes — keeps the turn in-flight. */
function openStreamResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  return { ok: true, body } as unknown as Response;
}

beforeEach(() => {
  fetchBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      fetchBodies.push(JSON.parse(init.body));
      return openStreamResponse();
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Type a question and submit it; returns once the turn is in flight. */
async function sendMessage(text: string): Promise<void> {
  const input = screen.getByTestId("composer-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("composer-send"));
  });
}

describe("Home — Stop button", () => {
  it("swaps Send for Stop while a turn is in flight", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    render(<Home />);

    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-stop")).not.toBeInTheDocument();

    await sendMessage("Garchomp speed?");

    expect(screen.getByTestId("user-turn")).toHaveTextContent("Garchomp speed?");
    expect(screen.getByTestId("composer-stop")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
  });

  it("quick stop (<2s) wipes the thread, prefills the message, and starts a new session on resend", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000); // T0 at send
    render(<Home />);

    await sendMessage("Garchomp speed?");
    expect(fetchBodies).toHaveLength(1);
    const firstSession = fetchBodies[0]!.session_id;

    // Stop 500ms later — within the 2s window.
    now.mockReturnValue(1500);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-stop"));
    });

    // Thread wiped, composer restored with the stopped message, Send is back.
    expect(screen.queryByTestId("user-turn")).not.toBeInTheDocument();
    expect(
      (screen.getByTestId("composer-input") as HTMLInputElement).value,
    ).toBe("Garchomp speed?");
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();

    // Resending uses a brand-new session id (fresh conversation).
    now.mockReturnValue(2000);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-send"));
    });
    expect(fetchBodies).toHaveLength(2);
    expect(fetchBodies[1]!.message).toBe("Garchomp speed?");
    expect(fetchBodies[1]!.session_id).not.toBe(firstSession);
  });

  it("stop after >=2s keeps the question in the thread and does not prefill", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000); // T0 at send
    render(<Home />);

    await sendMessage("Which Fire-types learn Will-O-Wisp?");

    // Stop 3s later — outside the quick-stop window.
    now.mockReturnValue(1000 + 3000);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-stop"));
    });

    // The question stays (answer-less), the composer is empty, Send is back.
    expect(screen.getByTestId("user-turn")).toHaveTextContent("Will-O-Wisp");
    expect(
      (screen.getByTestId("composer-input") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
  });
});
