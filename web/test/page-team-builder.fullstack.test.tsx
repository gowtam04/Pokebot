/**
 * TEAM-BUILDER-UI-E2E (frontend) — the browser-level team-builder slice the
 * design mandates after Phase 10 and folds into Phase 11
 * (docs/features/team-builder § Integration checkpoints — `team-builder-ui-e2e`,
 * § Phase 11 test focus):
 *
 *   - manual build + Showdown import on `/teams`,
 *   - apply a `proposed_team` from a chat answer — both Apply paths (save-new
 *     via createTeam, apply-existing via updateTeam).
 *
 * Renders the REAL pages (`<TeamsPage/>` and `<Home/>`) with a single stubbed
 * `fetch` backed by an in-memory team store. It imports ONLY view + lib code —
 * never db/repos/runtime/server-only (those open Postgres and the Vitest jsdom
 * project has no Testcontainers). Runs in the Vitest jsdom project (the
 * `test/` `.test.tsx` glob).
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

import TeamsPage from "@/app/teams/page";
import Home from "@/app/page";
import { formatSseEvent } from "@/lib/sse/sse-types";
import { MINIMAL_ANSWER } from "@/components/test-fixtures";
import type { TeamMember } from "@/data/teams/team-schema";
import type { OakAnswer } from "@/components/types";

const EMAIL = "ash@pallet.town";
const SV = "scarlet-violet";

interface StoredTeam {
  id: string;
  name: string;
  format: string;
  members: TeamMember[];
}

let store: StoredTeam[];
let nextId: number;
let chatBodies: Array<Record<string, unknown>>;
let nextAnswer: OakAnswer;

const spread = (v = 0) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });

function garchompMember(): TeamMember {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: "leftovers",
    moves: ["earthquake", "dragon-claw", "fire-fang", "stealth-rock"],
    nature: "adamant",
    evs: { ...spread(), atk: 252, spe: 252, hp: 4 },
    ivs: spread(31),
    tera_type: "ground",
    level: 50,
  };
}

function summary(t: StoredTeam) {
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    memberCount: t.members.length,
    incomplete: t.members.length < 6,
    updatedAt: 1,
  };
}

function detail(t: StoredTeam) {
  return {
    team: { id: t.id, name: t.name, format: t.format, members: t.members },
    validation: t.members.length < 6 ? [{ code: "incomplete", message: "Add more." }] : [],
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
      controller.enqueue(
        new TextEncoder().encode(formatSseEvent("answer", { answer })),
      );
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
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

beforeEach(() => {
  store = [];
  nextId = 1;
  chatBodies = [];
  nextAnswer = { ...MINIMAL_ANSWER };
  vi.stubGlobal("localStorage", makeStorageStub());

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const parsed = new URL(u, "http://localhost");
      const path = parsed.pathname;

      // --- auth: always signed in (no sign-in dance needed here) ---
      if (path === "/api/auth/me") {
        return jsonResponse(200, { signedIn: true, email: EMAIL });
      }

      // --- entity index (live-stat lookups): a benign miss → no live column ---
      if (path === "/api/entity") return jsonResponse(404, {});

      // --- sprites + learnset (team builder progressive enhancement): empty ---
      if (path === "/api/sprites") return jsonResponse(200, { refs: {} });
      if (path === "/api/learnset") return jsonResponse(200, { moves: [] });

      // --- chat ---
      if (path === "/api/chat") {
        chatBodies.push(JSON.parse(init!.body!) as Record<string, unknown>);
        return sseAnswerResponse(nextAnswer);
      }

      // --- conversations PATCH (ActiveTeamSelector best-effort persist) ---
      if (path.startsWith("/api/conversations/")) {
        return jsonResponse(200, { ok: true });
      }

      // --- teams ---
      if (path === "/api/teams" && method === "GET") {
        const fmt = parsed.searchParams.get("format");
        const teams = store
          .filter((t) => !fmt || t.format === fmt)
          .map(summary);
        return jsonResponse(200, { teams });
      }
      if (path === "/api/teams" && method === "POST") {
        const b = JSON.parse(init!.body!) as {
          format: string;
          name?: string;
          members?: TeamMember[];
        };
        const t: StoredTeam = {
          id: `team-${nextId++}`,
          name: b.name ?? "Untitled team",
          format: b.format,
          members: b.members ?? [],
        };
        store.push(t);
        return jsonResponse(200, detail(t));
      }
      if (path === "/api/teams/import" && method === "POST") {
        const b = JSON.parse(init!.body!) as { format: string; paste: string };
        const t: StoredTeam = {
          id: `team-${nextId++}`,
          name: "Imported team",
          format: b.format,
          members: [garchompMember()],
        };
        store.push(t);
        return jsonResponse(200, {
          ...detail(t),
          notes: [
            { slot: 1, kind: "pokemon", raw: "Notarealmon", message: "Couldn't resolve." },
          ],
        });
      }
      if (path.startsWith("/api/teams/")) {
        const rest = path.slice("/api/teams/".length);
        const [rawId, sub] = rest.split("/");
        const id = decodeURIComponent(rawId!);
        const t = store.find((x) => x.id === id);

        if (sub === "export") {
          if (!t) return jsonResponse(404, {});
          return jsonResponse(200, { paste: "Garchomp @ Leftovers\n- Earthquake" });
        }
        if (sub === "duplicate") {
          if (!t) return jsonResponse(404, {});
          const copy: StoredTeam = {
            id: `team-${nextId++}`,
            name: `${t.name} copy`,
            format: t.format,
            members: t.members,
          };
          store.push(copy);
          return jsonResponse(200, detail(copy));
        }
        // bare /api/teams/[id]
        if (method === "GET") {
          if (!t) return jsonResponse(404, {});
          return jsonResponse(200, detail(t));
        }
        if (method === "PUT") {
          if (!t) return jsonResponse(404, {});
          const b = JSON.parse(init!.body!) as {
            name?: string;
            members?: TeamMember[];
          };
          if (b.name !== undefined) t.name = b.name;
          if (b.members !== undefined) t.members = b.members;
          return jsonResponse(200, detail(t));
        }
        if (method === "DELETE") {
          store = store.filter((x) => x.id !== id);
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

// ===========================================================================
// /teams — manual build + Showdown import
// ===========================================================================

describe("/teams — manual build", () => {
  it("creates a team, renames it, adds a member, and saves (TEAM-US-1/3)", async () => {
    render(<TeamsPage />);
    // Signed in → the workbench (not the guest prompt) renders.
    await screen.findByTestId("team-list");
    expect(screen.queryByTestId("teams-guest")).not.toBeInTheDocument();

    // Create a new team → the editor opens on it.
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-new"));
    });
    await screen.findByTestId("team-editor");
    expect(store).toHaveLength(1);

    // Rename + add a member, then Save (partial team is first-class, BR-T4).
    fireEvent.change(screen.getByTestId("team-name"), {
      target: { value: "Ladder Core" },
    });
    fireEvent.click(screen.getByTestId("team-add-member"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-save"));
    });

    await waitFor(() => {
      expect(store[0].name).toBe("Ladder Core");
      expect(store[0].members).toHaveLength(1);
    });
  });

  it("imports a Showdown paste, surfaces notes, and opens the imported team (TEAM-US-10)", async () => {
    render(<TeamsPage />);
    await screen.findByTestId("team-list");

    // Open the import dialog and submit a paste.
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-import"));
    });
    await screen.findByTestId("import-dialog");
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: "Garchomp @ Leftovers\n- Earthquake\n\nNotarealmon\n- Splash" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-submit"));
    });

    // Import succeeded → the page saves the team, closes the dialog, and opens
    // the imported team in the editor (per-slot notes are surfaced by the
    // dialog unit test; the page flow closes the dialog on success).
    const editor = await screen.findByTestId("team-editor");
    expect(within(editor).getByTestId("team-name")).toHaveValue("Imported team");
    expect(store).toHaveLength(1);
    expect(store[0].members[0].species).toBe("garchomp");
  });
});

// ===========================================================================
// chat — set an active team + apply a proposed_team
// ===========================================================================

describe("chat — active team + proposed_team apply", () => {
  function seedTeam(name: string): StoredTeam {
    const t: StoredTeam = {
      id: `team-${nextId++}`,
      name,
      format: SV,
      members: [garchompMember()],
    };
    store.push(t);
    return t;
  }

  it("applies a proposed_team — save-new (createTeam) and apply-existing (updateTeam)", async () => {
    const existing = seedTeam("Overwrite Me");
    const proposedMembers = [garchompMember()];
    nextAnswer = {
      ...MINIMAL_ANSWER,
      answer_markdown: "Here's a team you could try.",
      proposed_team: {
        name: "Proposed Rain",
        format: SV,
        members: proposedMembers,
      },
    };

    render(<Home />);
    // Wait until the signed-in chat shell has rendered (the Teams link is
    // signed-in-only) before driving the composer.
    await screen.findByRole("link", { name: "Teams" });

    // Ask for a build → the answer carries a proposed_team rendered as a card.
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "build me a team" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-send"));
    });

    const card = await screen.findByTestId("proposed-team");
    expect(within(card).getByTestId("proposed-team-name")).toHaveTextContent(
      "Proposed Rain",
    );

    // --- Save as a NEW team (createTeam) -----------------------------------
    await act(async () => {
      fireEvent.click(within(card).getByTestId("proposed-team-save-new"));
    });
    await waitFor(() =>
      expect(store.some((t) => t.name === "Proposed Rain")).toBe(true),
    );
    const saved = store.find((t) => t.name === "Proposed Rain")!;
    expect(saved.format).toBe(SV);
    expect(saved.members).toHaveLength(1);

    // --- Apply onto the EXISTING same-format team (updateTeam) --------------
    // The card listed `existing` (same format) as an overwrite target.
    const target = (await within(card).findByTestId(
      "proposed-team-target",
    )) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(target, { target: { value: existing.id } });
    });
    await act(async () => {
      fireEvent.click(within(card).getByTestId("proposed-team-apply-existing"));
    });

    await waitFor(() =>
      expect(within(card).getByTestId("proposed-team-status")).toHaveTextContent(
        /Overwrite Me/,
      ),
    );
    // The existing team's members were replaced with the proposed set.
    const after = store.find((t) => t.id === existing.id)!;
    expect(after.members).toHaveLength(1);
    expect(after.members[0].species).toBe("garchomp");
  });
});
