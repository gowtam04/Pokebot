/**
 * AuthMenu — jsdom component tests (account-creation design.md § Phase 6,
 * test_focus "guest vs signed-in menu").
 *
 * Drives the REAL `@/lib/api/auth-client.signOut` over a mocked global `fetch`; no
 * server modules imported (jsdom project rule). Covers the guest affordance
 * (AC-1.2), the signed-in identity + Sign out (AUTH-US-5 / AC-5.1), and that
 * sign-out targets only the current device's session endpoint (AC-5.2).
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
  waitFor,
} from "@testing-library/react";

import AuthMenu from "./AuthMenu";

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
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
});

// ---------------------------------------------------------------------------
// Guest state (AC-1.2)
// ---------------------------------------------------------------------------

describe("AuthMenu — guest (AC-1.2)", () => {
  it("renders a non-blocking 'Sign in' control and no email", () => {
    render(
      <AuthMenu signedIn={false} onSignInClick={vi.fn()} onSignedOut={vi.fn()} />,
    );
    expect(screen.getByTestId("auth-signin-button")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-signout-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-user-email")).not.toBeInTheDocument();
  });

  it("opens the dialog via onSignInClick when 'Sign in' is pressed", () => {
    const onSignInClick = vi.fn();
    render(
      <AuthMenu
        signedIn={false}
        onSignInClick={onSignInClick}
        onSignedOut={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("auth-signin-button"));
    expect(onSignInClick).toHaveBeenCalledTimes(1);
    // Guest control never calls the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Signed-in state (AUTH-US-5)
// ---------------------------------------------------------------------------

describe("AuthMenu — signed in (AUTH-US-5)", () => {
  it("renders the account email and a Sign out control, not 'Sign in'", () => {
    render(
      <AuthMenu
        signedIn
        email="ash@pallet.town"
        onSignInClick={vi.fn()}
        onSignedOut={vi.fn()}
      />,
    );
    expect(screen.getByTestId("auth-user-email")).toHaveTextContent(
      "ash@pallet.town",
    );
    expect(screen.getByTestId("auth-signout-button")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-signin-button")).not.toBeInTheDocument();
  });

  it("signs out via the current-device endpoint, then notifies the parent (AC-5.1, AC-5.2)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }));
    const onSignedOut = vi.fn();
    render(
      <AuthMenu
        signedIn
        email="ash@pallet.town"
        onSignInClick={vi.fn()}
        onSignedOut={onSignedOut}
      />,
    );

    fireEvent.click(screen.getByTestId("auth-signout-button"));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/auth/signout");
    expect(init.method).toBe("POST");
  });

  it("still reverts to guest (onSignedOut) when the sign-out request fails", async () => {
    // Best-effort sign-out: a network reject must NOT strand the user signed in.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const onSignedOut = vi.fn();
    render(
      <AuthMenu
        signedIn
        email="ash@pallet.town"
        onSignInClick={vi.fn()}
        onSignedOut={onSignedOut}
      />,
    );

    fireEvent.click(screen.getByTestId("auth-signout-button"));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });
});
