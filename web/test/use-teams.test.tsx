/**
 * Tests for src/lib/hooks/use-teams.ts (team-builder Phase 8). Mocks the teams-client
 * entirely so the hook's list / format-filter / create / update / delete /
 * duplicate / import / export / refresh behaviour is asserted without any
 * network. Runs under the jsdom project.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api/teams-client", () => ({
  listTeams: vi.fn(),
  getTeam: vi.fn(),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  deleteTeam: vi.fn(),
  duplicateTeam: vi.fn(),
  importPaste: vi.fn(),
  exportPaste: vi.fn(),
}));

import {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  duplicateTeam,
  importPaste,
  exportPaste,
  type TeamDetail,
  type TeamSummary,
} from "@/lib/api/teams-client";
import { useTeams } from "@/lib/hooks/use-teams";

const SUMMARY: TeamSummary = {
  id: "t1",
  name: "Rain",
  format: "scarlet-violet",
  memberCount: 1,
  incomplete: true,
  updatedAt: 2000,
};

const DETAIL: TeamDetail = {
  id: "t2",
  name: "New",
  format: "scarlet-violet",
  members: [],
  validation: [],
};

beforeEach(() => {
  vi.mocked(listTeams).mockResolvedValue([SUMMARY]);
  vi.mocked(getTeam).mockResolvedValue(DETAIL);
  vi.mocked(createTeam).mockResolvedValue(DETAIL);
  vi.mocked(updateTeam).mockResolvedValue(DETAIL);
  vi.mocked(deleteTeam).mockResolvedValue(true);
  vi.mocked(duplicateTeam).mockResolvedValue(DETAIL);
  vi.mocked(importPaste).mockResolvedValue({ team: DETAIL, notes: [] });
  vi.mocked(exportPaste).mockResolvedValue("paste");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useTeams", () => {
  it("stays empty and never fetches when disabled (guest)", async () => {
    const { result } = renderHook(() => useTeams(false));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.teams).toEqual([]);
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("lists on mount when enabled", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    expect(listTeams).toHaveBeenCalledWith({ format: undefined });
  });

  it("re-lists when the format filter changes", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));

    act(() => result.current.setFormatFilter("champions"));
    await waitFor(() =>
      expect(listTeams).toHaveBeenCalledWith({ format: "champions" }),
    );
  });

  it("refresh re-lists", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    act(() => result.current.refresh());
    await waitFor(() => expect(listTeams).toHaveBeenCalledTimes(1));
  });

  it("get passes through to the client without refreshing", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    let out: TeamDetail | null = null;
    await act(async () => {
      out = await result.current.get("t1");
    });
    expect(getTeam).toHaveBeenCalledWith("t1");
    expect(out).toEqual(DETAIL);
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("create calls the API and refreshes the list", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    let out: TeamDetail | null = null;
    await act(async () => {
      out = await result.current.create({ format: "scarlet-violet" });
    });
    expect(createTeam).toHaveBeenCalledWith({ format: "scarlet-violet" });
    expect(out).toEqual(DETAIL);
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
  });

  it("create does NOT refresh when the API returns null", async () => {
    vi.mocked(createTeam).mockResolvedValue(null);
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    await act(async () => {
      await result.current.create({ format: "scarlet-violet" });
    });
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("update calls the API and refreshes", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    await act(async () => {
      await result.current.update("t1", { name: "X" });
    });
    expect(updateTeam).toHaveBeenCalledWith("t1", { name: "X" });
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
  });

  it("remove optimistically filters the row out and calls the API", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));

    await act(async () => {
      await result.current.remove("t1");
    });
    expect(deleteTeam).toHaveBeenCalledWith("t1");
    expect(result.current.teams).toEqual([]);
  });

  it("duplicate calls the API and refreshes", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    let out: TeamDetail | null = null;
    await act(async () => {
      out = await result.current.duplicate("t1");
    });
    expect(duplicateTeam).toHaveBeenCalledWith("t1");
    expect(out).toEqual(DETAIL);
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
  });

  it("importPaste calls the API, refreshes, and returns { team, notes }", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    let out: { team: TeamDetail; notes: unknown[] } | null = null;
    await act(async () => {
      out = await result.current.importPaste("scarlet-violet", "Garchomp");
    });
    expect(importPaste).toHaveBeenCalledWith("scarlet-violet", "Garchomp");
    expect(out).toEqual({ team: DETAIL, notes: [] });
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
  });

  it("exportPaste passes through without refreshing", async () => {
    const { result } = renderHook(() => useTeams(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    vi.mocked(listTeams).mockClear();

    let out: string | null = null;
    await act(async () => {
      out = await result.current.exportPaste("t1");
    });
    expect(exportPaste).toHaveBeenCalledWith("t1");
    expect(out).toBe("paste");
    expect(listTeams).not.toHaveBeenCalled();
  });
});
