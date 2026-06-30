import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

import ActiveTeamSelector from "./ActiveTeamSelector";
import type { TeamSummary } from "@/lib/api/teams-client";

function summary(over: Partial<TeamSummary>): TeamSummary {
  return {
    id: "t1",
    name: "Team One",
    format: "scarlet-violet",
    memberCount: 6,
    incomplete: false,
    updatedAt: Date.now(),
    ...over,
  };
}

/** A fetch double: GET /api/teams* → { teams }, every other call → { ok:true }. */
function installFetch(teams: TeamSummary[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const payload = method === "GET" ? { teams } : { ok: true };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ActiveTeamSelector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing and makes no fetch for a guest (enabled=false)", () => {
    const calls = installFetch([summary({})]);
    render(
      <ActiveTeamSelector
        format="scarlet-violet"
        conversationId="conv-1"
        value={null}
        onChange={vi.fn()}
        enabled={false}
      />,
    );
    expect(screen.queryByTestId("active-team-selector")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("lists teams for the CURRENT format only and defaults to none", async () => {
    const calls = installFetch([
      summary({ id: "a", name: "Alpha" }),
      summary({ id: "b", name: "Bravo" }),
    ]);
    render(
      <ActiveTeamSelector
        format="champions"
        conversationId="conv-1"
        value={null}
        onChange={vi.fn()}
        enabled
      />,
    );

    // Scope is the active format only.
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "GET" && c.url.includes("format=champions"),
        ),
      ).toBe(true),
    );

    await screen.findByRole("option", { name: "Alpha" });
    const select = screen.getByTestId("active-team-select") as HTMLSelectElement;
    // Default: "No active team" (empty value) is selected.
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "No active team" })).toBeTruthy();
  });

  it("on select lifts via onChange AND PATCHes the conversation with active_team_id", async () => {
    const calls = installFetch([summary({ id: "a", name: "Alpha" })]);
    const onChange = vi.fn();
    render(
      <ActiveTeamSelector
        format="scarlet-violet"
        conversationId="conv-42"
        value={null}
        onChange={onChange}
        enabled
      />,
    );
    await screen.findByRole("option", { name: "Alpha" });

    fireEvent.change(screen.getByTestId("active-team-select"), {
      target: { value: "a" },
    });

    expect(onChange).toHaveBeenCalledWith("a");

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain("/api/conversations/conv-42");
    expect(JSON.parse(patch!.body as string)).toEqual({ active_team_id: "a" });
  });

  it("selecting 'No active team' lifts null and PATCHes a clear", async () => {
    const calls = installFetch([summary({ id: "a", name: "Alpha" })]);
    const onChange = vi.fn();
    render(
      <ActiveTeamSelector
        format="scarlet-violet"
        conversationId="conv-7"
        value="a"
        onChange={onChange}
        enabled
      />,
    );
    await screen.findByRole("option", { name: "Alpha" });

    fireEvent.change(screen.getByTestId("active-team-select"), {
      target: { value: "" },
    });

    expect(onChange).toHaveBeenCalledWith(null);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.body as string)).toEqual({ active_team_id: null });
  });
});
