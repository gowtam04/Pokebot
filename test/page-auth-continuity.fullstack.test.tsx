/**
 * FULL-STACK (frontend) — guest → sign-in → sign-out continuity on the chat page
 * (account-creation design.md § Phase 7 / guest-to-user-e2e checkpoint; BR-A10,
 * AUTH-US-6, AC-6.1, AC-6.2, AC-1.2, AUTH-US-5).
 *
 * Renders the REAL <Home/> page (composer + thread + `useSseClient` + `AuthMenu`
 * + `AuthDialog`) with a single stubbed `fetch` that routes:
 *   - POST /api/chat            → an SSE body with one terminal `answer` frame
 *     (framed exactly like the route via `formatSseEvent`), capturing each
 *     request body so we can inspect `session_id`;
 *   - GET  /api/auth/me         → the current (stateful) auth identity;
 *   - POST /api/auth/request-code / verify / signout → plain JSON.
 *
 * The defining assertion is BR-A10 / AD-2: auth identity is a SEPARATE axis from
 * the conversation, so signing in (or out) mid-thread must NOT reset the client's
 * `session_id` or its `turns[]`. We prove the on-screen thread survives the
 * guest→user→guest transitions AND that every /api/chat send keeps reusing the
 * SAME `session_id` S captured from the very first guest turn.
 *
 * Imports only view code + the lib layer (`@/lib/sse-types`, plain fixtures) —
 * never db/repos/runtime/server-only. Runs in the Vitest "jsdom" project.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

import Home from "@/app/page";
import { formatSseEvent } from "@/lib/sse-types";
import { MINIMAL_ANSWER } from "@/components/test-fixtures";
import type { OakAnswer } from "@/components/types";

const EMAIL = "ash@pallet.town";

/** Captured /api/chat request bodies (to inspect session_id / message). */
let chatBodies: Array<{
  session_id: string;
  message: string;
  champions_mode?: boolean;
}>;

/** Stateful /api/auth/me identity — flipped by verify (in) and signout (out). */
let meState: { signedIn: boolean; email?: string };

/** A distinct, renderable OakAnswer per turn (AnswerCard maps it field-by-field). */
function makeAnswer(markdown: string): OakAnswer {
  return { ...MINIMAL_ANSWER, answer_markdown: markdown };
}

/** A JSON `Response`-shaped stub matching what the auth-client reads. */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

/** An SSE `Response` whose body streams one terminal `answer` frame, then closes. */
function sseAnswerResponse(answer: OakAnswer): Response {
  const frame = formatSseEvent("answer", { answer });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
}

beforeEach(() => {
  chatBodies = [];
  meState = { signedIn: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/chat")) {
        chatBodies.push(JSON.parse(init!.body!));
        return sseAnswerResponse(makeAnswer(`assistant-answer-${chatBodies.length}`));
      }
      if (u.includes("/api/auth/me")) {
        return jsonResponse(200, meState);
      }
      if (u.includes("/api/auth/request-code")) {
        return jsonResponse(200, { ok: true });
      }
      if (u.includes("/api/auth/verify")) {
        // Successful verify signs the device in — `me` must now report the account.
        meState = { signedIn: true, email: EMAIL };
        return jsonResponse(200, { ok: true, email: EMAIL, created: true });
      }
      if (u.includes("/api/auth/signout")) {
        meState = { signedIn: false };
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Type + send a message, then wait until its assistant turn has committed. */
async function sendAndAwait(text: string, expectedAssistantTurns: number) {
  fireEvent.change(screen.getByTestId("composer-input"), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("composer-send"));
  });
  await waitFor(() =>
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(
      expectedAssistantTurns,
    ),
  );
}

/** Drive the two-step AuthDialog from open → verified, signing the device in. */
async function signIn() {
  // Open the dialog from the guest "Sign in" affordance (AC-1.2).
  await act(async () => {
    fireEvent.click(screen.getByTestId("auth-signin-button"));
  });

  // Step 1 — email → request-code (non-enumerating 200 → advances to code step).
  fireEvent.change(screen.getByTestId("auth-email-input"), {
    target: { value: EMAIL },
  });
  await act(async () => {
    fireEvent.submit(screen.getByTestId("auth-email-step"));
  });
  await screen.findByTestId("auth-code-step");

  // Step 2 — code → verify ok:true → onSignedIn → page re-resolves identity.
  fireEvent.change(screen.getByTestId("auth-code-input"), {
    target: { value: "123456" },
  });
  await act(async () => {
    fireEvent.submit(screen.getByTestId("auth-code-step"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("auth-signout-button")).toBeInTheDocument(),
  );
}

const MSG1 = "What is Garchomp's base Speed?";
const MSG2 = "And its base Attack?";
const MSG3 = "What about Dragapult?";

describe("Home — guest → sign-in → sign-out thread continuity (BR-A10)", () => {
  it("preserves the on-screen thread and reuses the same session_id across sign-in and sign-out", async () => {
    render(<Home />);

    // Mount resolves auth: a guest sees the non-blocking "Sign in" control (AC-1.2).
    await screen.findByTestId("auth-signin-button");

    // ── Step 1 — a guest sends a message and gets a user + assistant turn ───────
    await sendAndAwait(MSG1, 1);

    expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
    expect(screen.getByText(MSG1)).toBeInTheDocument();
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(1);

    // Capture the conversation session id S established by the first guest turn.
    expect(chatBodies).toHaveLength(1);
    const S = chatBodies[0]!.session_id;
    expect(typeof S).toBe("string");
    expect(S.length).toBeGreaterThan(0);

    // ── Step 2 — the header menu shows the guest "Sign in" affordance ───────────
    expect(screen.getByTestId("auth-signin-button")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-signout-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-user-email")).not.toBeInTheDocument();

    // ── Step 3 — sign in MID-THREAD (request code → enter code → verify) ────────
    await signIn();

    // Menu now reflects the signed-in account: email + Sign out, no "Sign in".
    expect(screen.getByTestId("auth-user-email")).toHaveTextContent(EMAIL);
    expect(screen.getByTestId("auth-signout-button")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-signin-button")).not.toBeInTheDocument();

    // ── Step 4 — BR-A10: the step-1 turns are STILL on screen, and the next ─────
    // /api/chat send STILL carries the original session_id S (no reset on sign-in).
    expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
    expect(screen.getByText(MSG1)).toBeInTheDocument();
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(1);

    await sendAndAwait(MSG2, 2);
    expect(chatBodies).toHaveLength(2);
    const postSignInSessionId = chatBodies[1]!.session_id;
    expect(postSignInSessionId).toBe(S);

    // ── Step 5 — the follow-up appended to the SAME thread on session S ─────────
    expect(screen.getAllByTestId("user-turn")).toHaveLength(2);
    expect(screen.getByText(MSG1)).toBeInTheDocument(); // original turn retained
    expect(screen.getByText(MSG2)).toBeInTheDocument(); // follow-up appended
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(2);

    // ── Step 6 — sign out reverts the menu to guest; thread + session persist ───
    await act(async () => {
      fireEvent.click(screen.getByTestId("auth-signout-button"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("auth-signin-button")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("auth-signout-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-user-email")).not.toBeInTheDocument();

    // Thread is preserved across the user→guest transition exactly as guest→user.
    expect(screen.getAllByTestId("user-turn")).toHaveLength(2);
    expect(screen.getByText(MSG1)).toBeInTheDocument();
    expect(screen.getByText(MSG2)).toBeInTheDocument();
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(2);

    // And a further send as a guest again STILL reuses the original session id S.
    await sendAndAwait(MSG3, 3);
    expect(chatBodies).toHaveLength(3);
    expect(chatBodies[2]!.session_id).toBe(S);
    expect(screen.getAllByTestId("user-turn")).toHaveLength(3);
    expect(screen.getByText(MSG3)).toBeInTheDocument();
  });
});
