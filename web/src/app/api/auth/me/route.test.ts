/**
 * Route-adapter tests for GET /api/auth/me (account-creation design.md
 * § API Design; AUTH-US-1, AC-1.2, BR-A11).
 *
 * The route is a THIN adapter; these tests pin both states: a resolved account →
 * `{ signedIn: true, email }`, and a guest (`getCurrentAccount` returns null) →
 * `{ signedIn: false }` — always 200, never an error path (guests are
 * first-class, BR-A11). `current-user` is mocked so neither cookie nor DB is
 * needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/server/auth/current-user", () => cu);

import { GET } from "./route";

beforeEach(() => {
  cu.getCurrentAccount.mockReset();
});

describe("GET /api/auth/me", () => {
  it("reports a signed-in account → 200 { signedIn: true, email }", async () => {
    cu.getCurrentAccount.mockResolvedValue({
      id: "acct-1",
      email: "ash@pallet.town",
      createdAt: 1_700_000_000_000,
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      signedIn: true,
      email: "ash@pallet.town",
    });
  });

  it("reports a guest → 200 { signedIn: false } (never errors — BR-A11)", async () => {
    cu.getCurrentAccount.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });
});
