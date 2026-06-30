/**
 * Unit tests for src/lib/api/teams-client.ts (team-builder Phase 8). `fetch` is
 * stubbed; asserts the never-throw contract — success maps to typed values
 * (the route's `{ team, validation }` folds into a flat TeamDetail), and HTTP
 * errors (guest 401 / other-account 404) / transport faults fold into safe
 * defaults ([] / null / false). Runs under the jsdom project (test/**\/*.test.tsx).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTeam,
  deleteTeam,
  duplicateTeam,
  exportPaste,
  getTeam,
  importPaste,
  listTeams,
  updateTeam,
} from "@/lib/api/teams-client";
import type { TeamMember } from "@/data/teams/team-schema";

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const MEMBER: TeamMember = {
  species: "garchomp",
  ability: "rough-skin",
  item: "life-orb",
  moves: ["earthquake", "dragon-claw", "swords-dance", "fire-fang"],
  nature: "jolly",
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  tera_type: "fire",
  level: 50,
};

const TEAM = {
  id: "t1",
  accountId: "a1",
  format: "scarlet-violet",
  name: "Rain",
  members: [MEMBER],
  createdAt: 1000,
  updatedAt: 2000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("listTeams", () => {
  it("returns the teams array on success and forwards the format filter", async () => {
    const summary = {
      id: "t1",
      name: "Rain",
      format: "scarlet-violet",
      memberCount: 1,
      incomplete: true,
      updatedAt: 2000,
    };
    const fn = stubFetch(async () => res(200, { teams: [summary] }));
    const out = await listTeams({ format: "scarlet-violet" });
    expect(out).toEqual([summary]);
    expect(fn).toHaveBeenCalledWith(
      "/api/teams?format=scarlet-violet",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("omits the query string when no format is given", async () => {
    const fn = stubFetch(async () => res(200, { teams: [] }));
    await listTeams();
    expect(fn).toHaveBeenCalledWith("/api/teams", expect.anything());
  });

  it("returns [] for a guest (401) and on transport failure", async () => {
    stubFetch(async () => res(401, { code: "unauthorized" }));
    expect(await listTeams()).toEqual([]);
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await listTeams()).toEqual([]);
  });
});

describe("getTeam", () => {
  it("folds { team, validation } into a flat TeamDetail", async () => {
    const validation = [{ code: "incomplete", message: "needs work" }];
    stubFetch(async () => res(200, { team: TEAM, validation }));
    const out = await getTeam("t1");
    expect(out).toEqual({
      id: "t1",
      name: "Rain",
      format: "scarlet-violet",
      members: [MEMBER],
      validation,
    });
  });

  it("defaults validation to [] when absent", async () => {
    stubFetch(async () => res(200, { team: TEAM }));
    const out = await getTeam("t1");
    expect(out?.validation).toEqual([]);
  });

  it("returns null on 404 and on transport failure", async () => {
    stubFetch(async () => res(404, { code: "not_found" }));
    expect(await getTeam("nope")).toBeNull();
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await getTeam("t1")).toBeNull();
  });

  it("encodes the id in the URL", async () => {
    const fn = stubFetch(async () => res(200, { team: TEAM }));
    await getTeam("a/b");
    expect(fn).toHaveBeenCalledWith("/api/teams/a%2Fb", expect.anything());
  });
});

describe("createTeam", () => {
  it("POSTs the input and returns the saved TeamDetail", async () => {
    const fn = stubFetch(async () => res(200, { team: TEAM, validation: [] }));
    const out = await createTeam({ format: "scarlet-violet", name: "Rain" });
    expect(out?.id).toBe("t1");
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      format: "scarlet-violet",
      name: "Rain",
    });
  });

  it("returns null for a guest (401)", async () => {
    stubFetch(async () => res(401, {}));
    expect(await createTeam({ format: "scarlet-violet" })).toBeNull();
  });
});

describe("updateTeam", () => {
  it("PUTs name/members and returns the saved TeamDetail", async () => {
    const fn = stubFetch(async () => res(200, { team: TEAM, validation: [] }));
    const out = await updateTeam("t1", { name: "New" });
    expect(out?.id).toBe("t1");
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ name: "New" });
  });

  it("returns null when not owned (404)", async () => {
    stubFetch(async () => res(404, {}));
    expect(await updateTeam("t1", { name: "x" })).toBeNull();
  });
});

describe("deleteTeam", () => {
  it("returns true on 200 and treats 404 as idempotent success", async () => {
    stubFetch(async () => res(200, {}));
    expect(await deleteTeam("t1")).toBe(true);
    stubFetch(async () => res(404, {}));
    expect(await deleteTeam("gone")).toBe(true);
  });

  it("returns false on a guest 401 and on transport failure", async () => {
    stubFetch(async () => res(401, {}));
    expect(await deleteTeam("t1")).toBe(false);
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await deleteTeam("t1")).toBe(false);
  });
});

describe("duplicateTeam", () => {
  it("POSTs to the duplicate path and returns the clone", async () => {
    const fn = stubFetch(async () => res(200, { team: TEAM, validation: [] }));
    const out = await duplicateTeam("t1");
    expect(out?.id).toBe("t1");
    expect(fn).toHaveBeenCalledWith(
      "/api/teams/t1/duplicate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns null when not owned (404)", async () => {
    stubFetch(async () => res(404, {}));
    expect(await duplicateTeam("t1")).toBeNull();
  });
});

describe("importPaste", () => {
  it("returns { team, notes } on success", async () => {
    const notes = [
      { slot: 0, kind: "move", raw: "Hidden Power", message: "unresolved" },
    ];
    stubFetch(async () =>
      res(200, { team: TEAM, validation: [], notes }),
    );
    const out = await importPaste("scarlet-violet", "Garchomp");
    expect(out?.team.id).toBe("t1");
    expect(out?.notes).toEqual(notes);
  });

  it("defaults notes to [] when absent", async () => {
    stubFetch(async () => res(200, { team: TEAM }));
    const out = await importPaste("scarlet-violet", "Garchomp");
    expect(out?.notes).toEqual([]);
  });

  it("returns null on a guest 401 and on transport failure", async () => {
    stubFetch(async () => res(401, {}));
    expect(await importPaste("scarlet-violet", "x")).toBeNull();
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await importPaste("scarlet-violet", "x")).toBeNull();
  });
});

describe("exportPaste", () => {
  it("returns the paste string on success", async () => {
    stubFetch(async () => res(200, { paste: "Garchomp @ Life Orb" }));
    expect(await exportPaste("t1")).toBe("Garchomp @ Life Orb");
  });

  it("returns null on 404, a non-string body, and transport failure", async () => {
    stubFetch(async () => res(404, {}));
    expect(await exportPaste("t1")).toBeNull();
    stubFetch(async () => res(200, { paste: 123 }));
    expect(await exportPaste("t1")).toBeNull();
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await exportPaste("t1")).toBeNull();
  });
});
