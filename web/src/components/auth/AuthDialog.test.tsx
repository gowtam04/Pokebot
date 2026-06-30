/**
 * AuthDialog — jsdom component tests (account-creation design.md § Phase 6 /
 * § Implementation Phases "Phase 6 — Frontend auth UI", test_focus "two-step
 * dialog states").
 *
 * These exercise the REAL `@/lib/api/auth-client` over a mocked global `fetch`, so a
 * single suite covers both the fetch→result mapping AND every dialog branch. No
 * server modules are imported (jsdom project rule). Each negative branch asserts
 * the feedback discriminant via the `data-kind` attribute — never happy-path only.
 *
 * Requirement coverage: AC-2.1 (email step + send), AC-2.2 / BR-A1
 * (non-enumerating), AC-2.3 / AC-2.4 (created flag), AC-2.5 (invalid_code +
 * attemptsRemaining), AC-2.6 (expired/used), BR-A4 (too_many_attempts), AC-2.7
 * (change email), AC-3.1 (resend cooldown), AC-3.3 / BR-A6 (rate_limited).
 */

import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
  type Mock,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

import AuthDialog from "./AuthDialog";

// ---------------------------------------------------------------------------
// fetch stub (real auth-client runs against it)
// ---------------------------------------------------------------------------

/** Minimal `Response`-shaped stub matching what auth-client reads. */
function mockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderDialog() {
  const onSignedIn = vi.fn();
  const onClose = vi.fn();
  render(<AuthDialog open onClose={onClose} onSignedIn={onSignedIn} />);
  return { onSignedIn, onClose };
}

/** Drive the email step with a successful request-code → land on the code step. */
async function gotoCodeStep(email = "ash@pallet.town") {
  fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }));
  fireEvent.change(screen.getByTestId("auth-email-input"), {
    target: { value: email },
  });
  fireEvent.submit(screen.getByTestId("auth-email-step"));
  await screen.findByTestId("auth-code-step");
}

// ---------------------------------------------------------------------------
// Email step
// ---------------------------------------------------------------------------

describe("AuthDialog — email step (AC-2.1)", () => {
  it("renders the email step first and hides the code step", () => {
    renderDialog();
    expect(screen.getByTestId("auth-email-step")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });

  it("returns null when open is false", () => {
    const { container } = render(
      <AuthDialog open={false} onClose={vi.fn()} onSignedIn={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("rejects a syntactically invalid email WITHOUT calling the API (AC-2.1)", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("auth-email-input"), {
      target: { value: "not-an-email" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-step"));
    expect(screen.getByTestId("auth-feedback")).toHaveAttribute(
      "data-kind",
      "invalid_email",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });

  it("advances to the code step on a successful request-code, posting the email (AC-2.1)", async () => {
    renderDialog();
    await gotoCodeStep("ash@pallet.town");
    expect(screen.getByTestId("auth-feedback")).toHaveAttribute(
      "data-kind",
      "code_sent",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/auth/request-code");
    expect(JSON.parse(String(init.body))).toEqual({ email: "ash@pallet.town" });
  });

  it("is NON-ENUMERATING: a successful send shows a generic message that never reveals registration (AC-2.2 / BR-A1)", async () => {
    renderDialog();
    await gotoCodeStep();
    const fb = screen.getByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "code_sent");
    // No copy hints whether the account already existed.
    expect((fb.textContent ?? "").toLowerCase()).not.toMatch(
      /exist|registered|already|new account|sign ?up|created/,
    );
  });

  it("maps a server 400 invalid_email → invalid_email feedback and stays on the email step", async () => {
    renderDialog();
    fetchMock.mockResolvedValueOnce(
      mockResponse(400, { code: "invalid_email", message: "x" }),
    );
    fireEvent.change(screen.getByTestId("auth-email-input"), {
      target: { value: "ash@pallet.town" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "invalid_email");
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });

  it("maps a 429 → rate_limited feedback (AC-3.3 / BR-A6)", async () => {
    renderDialog();
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        429,
        { code: "rate_limited", message: "x" },
        { "Retry-After": "30" },
      ),
    );
    fireEvent.change(screen.getByTestId("auth-email-input"), {
      target: { value: "ash@pallet.town" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "rate_limited");
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });

  it("maps a 502 email_failed → email_failed feedback and stays on the email step", async () => {
    renderDialog();
    fetchMock.mockResolvedValueOnce(
      mockResponse(502, { code: "email_failed", message: "x" }),
    );
    fireEvent.change(screen.getByTestId("auth-email-input"), {
      target: { value: "ash@pallet.town" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "email_failed");
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Code step — verify branches
// ---------------------------------------------------------------------------

describe("AuthDialog — code step verify branches", () => {
  it("verifies a correct code for a NEW email → onSignedIn({created:true}) (AC-2.3)", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep("ash@pallet.town");
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        ok: true,
        email: "ash@pallet.town",
        created: true,
      }),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "123456" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(onSignedIn).toHaveBeenCalledWith({ created: true });

    const verifyCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/api/auth/verify"),
    ) as [string, RequestInit] | undefined;
    expect(verifyCall).toBeTruthy();
    expect(JSON.parse(String(verifyCall![1].body))).toEqual({
      email: "ash@pallet.town",
      code: "123456",
    });
  });

  it("verifies a correct code for an EXISTING email → onSignedIn({created:false}) (AC-2.4)", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep();
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        ok: true,
        email: "ash@pallet.town",
        created: false,
      }),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "654321" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ created: false }));
  });

  it("wrong code → invalid_code feedback with attemptsRemaining, no sign-in, retry allowed (AC-2.5)", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep();
    fetchMock.mockResolvedValueOnce(
      mockResponse(400, {
        code: "invalid_code",
        message: "x",
        attemptsRemaining: 3,
      }),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "000000" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "invalid_code");
    expect(fb).toHaveTextContent("3 attempts remaining");
    expect(onSignedIn).not.toHaveBeenCalled();
    // Still on the code step so the user can retry until lockout.
    expect(screen.getByTestId("auth-code-step")).toBeInTheDocument();
  });

  it("expired / already-used code → expired feedback, no sign-in (AC-2.6)", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep();
    fetchMock.mockResolvedValueOnce(
      mockResponse(400, { code: "invalid_or_expired", message: "x" }),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "999999" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "expired");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("locked-out code → too_many feedback, no sign-in (BR-A4)", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep();
    fetchMock.mockResolvedValueOnce(
      mockResponse(400, { code: "too_many_attempts", message: "x" }),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "123456" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "too_many");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("per-IP verify throttle → rate_limited feedback, no sign-in", async () => {
    const { onSignedIn } = renderDialog();
    await gotoCodeStep();
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        429,
        { code: "rate_limited", message: "x" },
        { "Retry-After": "30" },
      ),
    );
    fireEvent.change(screen.getByTestId("auth-code-input"), {
      target: { value: "123456" },
    });
    fireEvent.submit(screen.getByTestId("auth-code-step"));
    const fb = await screen.findByTestId("auth-feedback");
    expect(fb).toHaveAttribute("data-kind", "rate_limited");
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Code step — change email + resend cooldown
// ---------------------------------------------------------------------------

describe("AuthDialog — change email + resend (AC-2.7, AC-3.1)", () => {
  it("change-email goes back to the email step (AC-2.7)", async () => {
    renderDialog();
    await gotoCodeStep();
    fireEvent.click(screen.getByTestId("auth-change-email"));
    expect(screen.getByTestId("auth-email-step")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-code-step")).not.toBeInTheDocument();
  });

  it("disables resend during the cooldown and re-enables it after it elapses (AC-3.1)", async () => {
    vi.useFakeTimers();

    const onSignedIn = vi.fn();
    render(<AuthDialog open onClose={vi.fn()} onSignedIn={onSignedIn} />);

    fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }));
    fireEvent.change(screen.getByTestId("auth-email-input"), {
      target: { value: "ash@pallet.town" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-step"));

    // Drain the fetch→json→setState microtask chain under fake timers
    // (findBy/waitFor can't be used — they poll on real timers).
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("auth-code-step")).toBeInTheDocument();
    // Cooldown active: resend disabled, countdown shows the full 60s.
    expect(screen.getByTestId("auth-resend")).toBeDisabled();
    expect(screen.getByTestId("auth-resend-countdown")).toHaveTextContent("60");

    // One second elapses → counts down, still disabled.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("auth-resend-countdown")).toHaveTextContent("59");
    expect(screen.getByTestId("auth-resend")).toBeDisabled();

    // Full cooldown elapses → countdown gone, resend enabled.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(
      screen.queryByTestId("auth-resend-countdown"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("auth-resend")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

describe("AuthDialog — dismissal", () => {
  it("calls onClose from the close button and the backdrop, but not the panel", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByTestId("auth-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("auth-dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking inside the panel must not bubble to a close.
    fireEvent.click(screen.getByTestId("auth-dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
