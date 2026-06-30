/**
 * Route-adapter tests for DELETE /api/auth/account (iphone-app api-design.md
 * "Change 1 — Account deletion"; ADR-2; M-NFR-6, M-ACCT-US-6, M-BR-ACCT-6).
 *
 * The route is a THIN adapter; these tests pin its HTTP contract with the
 * identity seam, the cascade repo, and the cookie helper all mocked so each
 * branch is driven deterministically (no DB / next/headers):
 *   - a guest (getCurrentAccount → null) gets 401 and NOTHING is deleted/cleared,
 *   - a signed-in caller gets 200 { ok: true }, the cascade runs for THEIR id,
 *     and the cookie is cleared afterward (parity with sign-out).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cu = vi.hoisted(() => ({
  getCurrentAccount: vi.fn<() => Promise<unknown>>(),
}));
const repo = vi.hoisted(() => ({
  deleteAccount: vi.fn<(accountId: string) => Promise<void>>(),
}));
const sess = vi.hoisted(() => ({
  clearSessionCookie: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentAccount: cu.getCurrentAccount,
}));
vi.mock("@/data/repos/accounts-repo", () => ({
  deleteAccount: repo.deleteAccount,
}));
vi.mock("@/server/auth/sessions", () => ({
  clearSessionCookie: sess.clearSessionCookie,
}));

import { DELETE } from "./route";

const ACCOUNT = {
  id: "acct-1",
  email: "ash@pallet.town",
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  cu.getCurrentAccount.mockReset();
  repo.deleteAccount.mockReset();
  repo.deleteAccount.mockResolvedValue(undefined);
  sess.clearSessionCookie.mockReset();
  sess.clearSessionCookie.mockResolvedValue(undefined);
});

describe("DELETE /api/auth/account", () => {
  it("guest → 401 unauthorized; deletes nothing and clears no cookie", async () => {
    cu.getCurrentAccount.mockResolvedValue(null);

    const res = await DELETE();

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("unauthorized");
    expect(repo.deleteAccount).not.toHaveBeenCalled();
    expect(sess.clearSessionCookie).not.toHaveBeenCalled();
  });

  it("signed in → 200 { ok: true }, cascades for THIS account, clears the cookie", async () => {
    cu.getCurrentAccount.mockResolvedValue(ACCOUNT);

    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Cascade runs for the resolved account's id only.
    expect(repo.deleteAccount).toHaveBeenCalledTimes(1);
    expect(repo.deleteAccount).toHaveBeenCalledWith(ACCOUNT.id);
    // Cookie cleared (parity with signout) so a cookie web session reverts to guest.
    expect(sess.clearSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("clears the cookie AFTER the cascade completes (order parity with signout)", async () => {
    cu.getCurrentAccount.mockResolvedValue(ACCOUNT);

    await DELETE();

    expect(repo.deleteAccount.mock.invocationCallOrder[0]!).toBeLessThan(
      sess.clearSessionCookie.mock.invocationCallOrder[0]!,
    );
  });
});
