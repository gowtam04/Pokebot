/**
 * TEAM-LOOKUP-AGENT-E2E — the by-name saved-team seam exercised end-to-end
 * through the REAL active-team service, the REAL agent runtime + tool layer (only
 * the Anthropic client is mocked, via a recorded transcript), and a REAL migrated
 * + seeded Postgres schema (Testcontainers):
 *
 *   a signed-in turn calls `list_teams` to see the account's saved teams (scoped
 *   to the turn's format) → `get_team({ team_id })` reads the matched team
 *   enriched with display names + validity warnings → a guest / unknown id yields
 *   `{ found: false }`. `resolveActiveTeam` (which `get_team` wraps) still binds a
 *   team ONLY when account-owned AND format-matched (BR-T3 / AC-8.3).
 *
 * Wiring mirrors the runtime-g4 oracle: neutralize `server-only`, install a
 * seeded schema as the `@/data/db` singleton BEFORE the first dynamic import of
 * the repos/runtime (resolve_entity + team-repo read the SINGLETON, not
 * `ctx.db`), and replay a scripted transcript through `runOakWith`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { oakAnswerSchema } from "@/agent/schemas";
import type {
  AgentContext,
  AgentMode,
  ChatMessage,
} from "@/agent/types";
import type { OakAnswer } from "@/agent/schemas";
import type { TeamMember } from "@/data/teams/team-schema";

import { createPgSchema, installAsSingleton, type PgFixture } from "../../test/support/pg";

// src/data/db.ts does `import "server-only"`; neutralize it so the real repos
// load under the vitest node environment.
vi.mock("server-only", () => ({}));

// --- Module handles (imported AFTER the singleton is installed) --------------

type TeamRepo = typeof import("@/data/repos/team-repo");
type ActiveTeamSvc = typeof import("@/server/teams/active-team");
type Runtime = typeof import("@/agent/runtime");
type ContextMod = typeof import("@/agent/context");

let fix: PgFixture;
let teamRepo: TeamRepo;
let activeTeamSvc: ActiveTeamSvc;
let runtime: Runtime;
let contextMod: ContextMod;

const ACCT_A = "acct-active-a";
const ACCT_B = "acct-active-b";
const SV = "scarlet-violet";
const CH = "champions";

const spread = (v = 0) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });

/** A partial Garchomp set (2 valid moves) → the team reads as "incomplete". */
function garchompMember(): TeamMember {
  return {
    species: "garchomp",
    ability: "rough-skin",
    item: "leftovers",
    moves: ["earthquake", "dragon-claw"],
    nature: "adamant",
    evs: { ...spread(), atk: 252, spe: 252, hp: 4 },
    ivs: spread(31),
    tera_type: "ground",
    level: 50,
  };
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY ??= "test-dummy-key";
  // seed "tools" → searchable_names (display labels) + pokedex/learnset
  // (legality) for enrichActiveTeam + validateTeam to read.
  fix = await createPgSchema({ seed: "tools" });
  await installAsSingleton(fix);

  teamRepo = await import("@/data/repos/team-repo");
  activeTeamSvc = await import("@/server/teams/active-team");
  runtime = await import("@/agent/runtime");
  contextMod = await import("@/agent/context");
}, 60_000);

afterAll(async () => {
  await fix?.cleanup();
});

beforeEach(async () => {
  const { sql } = await import("drizzle-orm");
  await fix.db.execute(
    sql`TRUNCATE TABLE team, conversation, conversation_message RESTART IDENTITY`,
  );
});

// --- Recorded-transcript Anthropic client (mirrors runtime-g4) --------------

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function toolUse(name: string, input: unknown, id: string): Block {
  return { type: "tool_use", id, name, input };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function message(content: Block[]): any {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 7,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: { thinking_tokens: 3 },
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function fakeStream(msg: any) {
  return {
    async *[Symbol.asyncIterator]() {
      // No incremental events needed — finalMessage suffices.
    },
    finalMessage: () => Promise.resolve(msg),
  };
}

function scriptedClient(responses: any[]) {
  const snapshots: any[] = [];
  const stream = vi.fn((params: any) => {
    snapshots.push(structuredClone(params));
    const next = responses.shift();
    if (next === undefined) {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("transcript exhausted")) };
        },
        finalMessage: () => Promise.reject(new Error("transcript exhausted")),
      };
    }
    return fakeStream(next);
  });
  return { client: { messages: { stream } } as any, stream, snapshots };
}

/** Concatenate the tool_result string content of the LAST user message. */
function lastToolResultText(params: any): string {
  const msgs = params.messages;
  const lastUser = msgs[msgs.length - 1];
  return (lastUser.content as { content?: unknown }[])
    .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c)))
    .join(" ");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const TEAM_ANSWER: OakAnswer = {
  status: "answered",
  answer_markdown:
    "Your Garchomp slot is solid, but the team is incomplete — you only have one Pokémon.",
  reasoning_markdown:
    "Listed the saved teams (list_teams), read the matching one (get_team): one Garchomp, flagged incomplete (<6 members).",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

async function buildCtx(
  mode: AgentMode,
  accountId?: string,
): Promise<AgentContext> {
  return contextMod.createAgentContext({
    requestId: "team-lookup-it",
    mode,
    accountId,
    db: fix.db as unknown as import("@/data/db").OakDb,
  });
}

// ---------------------------------------------------------------------------
// resolveActiveTeam — binds ONLY a format-matched, account-owned team (BR-T3).
// ---------------------------------------------------------------------------

describe("active-team-agent-e2e — format-matched binding (resolveActiveTeam)", () => {
  it("binds a same-format owned team and rejects mismatch / not-owned / none", async () => {
    const now = Date.now();
    const svTeam = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "SV Squad",
      members: [garchompMember()],
      now,
    });
    const chTeam = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: CH,
      name: "Champ Squad",
      members: [garchompMember()],
      now,
    });
    const db = fix.db as unknown as import("@/data/db").OakDb;

    // Format-matched + owned → bound (raw slugs, server-controlled view).
    const bound = await activeTeamSvc.resolveActiveTeam(ACCT_A, svTeam.id, "standard", db);
    expect(bound).toMatchObject({ id: svTeam.id, name: "SV Squad", format: SV });

    // Same team, Champions toggle ON → format mismatch → NOT bound (AC-8.3).
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_A, svTeam.id, "champions", db),
    ).toBeNull();

    // The Champions team binds under champions mode, not standard.
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_A, chTeam.id, "champions", db),
    ).toMatchObject({ id: chTeam.id, format: CH });
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_A, chTeam.id, "standard", db),
    ).toBeNull();

    // Another account's id is indistinguishable from missing → null (BR-T2).
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_B, svTeam.id, "standard", db),
    ).toBeNull();

    // No selection → null (guests / deselect).
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_A, null, "standard", db),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list_teams + get_team — through the real runtime: list the account's saved
// teams (format-scoped), then read the matched one enriched with display names +
// validity warnings on demand. A guest / unknown id yields { found: false }.
// ---------------------------------------------------------------------------

describe("team-lookup-agent-e2e — list_teams + get_team via the real runtime", () => {
  it("lists the saved teams then reads the matched one (display names + incomplete warning)", async () => {
    const now = Date.now();
    const team = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "SV Squad",
      members: [garchompMember()],
      now,
    });

    const ctx = await buildCtx("standard", ACCT_A);
    const { client, snapshots, stream } = scriptedClient([
      message([toolUse("list_teams", {}, "t1")]),
      message([toolUse("get_team", { team_id: team.id }, "t2")]),
      message([toolUse("submit_answer", TEAM_ANSWER, "t3")]),
    ]);

    const progress: string[] = [];
    const result = await runtime.runOakWith(
      client,
      "how's my SV Squad look?",
      [] as ChatMessage[],
      ctx,
      (e) => progress.push(e.tool),
    );

    expect(progress).toContain("list_teams");
    expect(progress).toContain("get_team");
    expect(stream).toHaveBeenCalledTimes(3);

    // list_teams result (fed back on turn 2) carries the team name + species
    // DISPLAY name, scoped to the signed-in account.
    const listResult = lastToolResultText(snapshots[1]);
    expect(listResult).toMatch(/"signed_in":\s*true/);
    expect(listResult).toContain("SV Squad");
    expect(listResult).toContain("Garchomp");

    // get_team result (fed back on turn 3) carries the enriched team: found:true,
    // the Garchomp display name, and the COMPUTED incomplete warning.
    const teamResult = lastToolResultText(snapshots[2]);
    expect(teamResult).toMatch(/"found":\s*true/);
    expect(teamResult).toContain("Garchomp");
    expect(teamResult).toContain("incomplete");

    expect(oakAnswerSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("answered");
  });

  it("scopes list_teams to the turn's format (a Champions team is hidden in standard mode)", async () => {
    const now = Date.now();
    await teamRepo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "SV Squad",
      members: [garchompMember()],
      now,
    });
    await teamRepo.createTeam({
      accountId: ACCT_A,
      format: CH,
      name: "Champ Squad",
      members: [garchompMember()],
      now,
    });

    const ctx = await buildCtx("standard", ACCT_A);
    const { client, snapshots } = scriptedClient([
      message([toolUse("list_teams", {}, "t1")]),
      message([toolUse("submit_answer", TEAM_ANSWER, "t2")]),
    ]);
    await runtime.runOakWith(client, "what teams do I have?", [] as ChatMessage[], ctx);

    const listResult = lastToolResultText(snapshots[1]);
    expect(listResult).toContain("SV Squad");
    expect(listResult).not.toContain("Champ Squad");
  });

  it("get_team for a guest / unknown id returns { found: false }", async () => {
    const ctx = await buildCtx("standard", undefined); // guest — no accountId
    const { client, snapshots } = scriptedClient([
      message([toolUse("get_team", { team_id: "nope" }, "t1")]),
      message([toolUse("submit_answer", TEAM_ANSWER, "t2")]),
    ]);
    await runtime.runOakWith(client, "how's my team?", [] as ChatMessage[], ctx);

    expect(lastToolResultText(snapshots[1])).toMatch(/"found":\s*false/);
  });
});

// ---------------------------------------------------------------------------
// proposed_team roster gate — the runtime roster-validates a proposed team
// against the turn's format. An out-of-roster species (`species_illegal`) is
// fed back so the model rebuilds legally (one dedicated retry), then accepted
// with warnings stamped (warn-but-allow). `heatran` is ABSENT from the "tools"
// seed → species_illegal; `garchomp` is present → legal.
// ---------------------------------------------------------------------------

/** A complete set whose species is NOT in the seed roster → species_illegal. */
function heatranMember(): TeamMember {
  return {
    species: "heatran",
    ability: "flash-fire",
    item: "leftovers",
    moves: ["magma-storm", "earth-power", "flash-cannon", "stealth-rock"],
    nature: "modest",
    evs: { ...spread(), spa: 252, spe: 252, hp: 4 },
    ivs: spread(31),
    tera_type: "fire",
    level: 50,
  };
}

describe("active-team-agent-e2e — proposed_team roster gate", () => {
  it("re-emits on an out-of-roster species, then accepts the rebuilt legal team", async () => {
    const ctx = await buildCtx("standard", undefined);
    const illegalAnswer: OakAnswer = {
      ...TEAM_ANSWER,
      proposed_team: { name: "Bad", format: SV, members: [heatranMember()] },
    };
    const legalAnswer: OakAnswer = {
      ...TEAM_ANSWER,
      proposed_team: { name: "Good", format: SV, members: [garchompMember()] },
    };
    const { client, snapshots, stream } = scriptedClient([
      message([toolUse("submit_answer", illegalAnswer, "t1")]),
      message([toolUse("submit_answer", legalAnswer, "t2")]),
    ]);

    const result = await runtime.runOakWith(
      client,
      "build me a team",
      [] as ChatMessage[],
      ctx,
    );

    // The server fed the illegality back (turn 2's incoming tool_result) and the
    // model re-emitted — so the stream ran twice, not once.
    expect(stream).toHaveBeenCalledTimes(2);
    const feedback = lastToolResultText(snapshots[1]);
    expect(feedback).toMatch(/not in the .*roster/i);
    expect(feedback).toContain("heatran");

    // Final answer carries the LEGAL rebuild; no species_illegal survives.
    expect(result.proposed_team?.members[0]?.species).toBe("garchomp");
    expect(
      (result.proposed_team_warnings ?? []).some(
        (w) => w.code === "species_illegal",
      ),
    ).toBe(false);
  });

  it("accepts with species_illegal stamped once the retry budget is spent (warn-fallback)", async () => {
    const ctx = await buildCtx("standard", undefined);
    const illegalAnswer: OakAnswer = {
      ...TEAM_ANSWER,
      proposed_team: {
        name: "Still bad",
        format: SV,
        members: [heatranMember(), garchompMember()],
      },
    };
    // Model stays illegal on the retry; budget (MAX_PROPOSED_TEAM_RETRIES=1) spent.
    const { client, stream } = scriptedClient([
      message([toolUse("submit_answer", illegalAnswer, "t1")]),
      message([toolUse("submit_answer", illegalAnswer, "t2")]),
    ]);

    const result = await runtime.runOakWith(
      client,
      "build me a team",
      [] as ChatMessage[],
      ctx,
    );

    // One re-emit, then accepted on the 2nd despite still being illegal — the
    // turn never fails; the warning rides through for the UI to flag.
    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.proposed_team).toBeDefined();
    expect(
      (result.proposed_team_warnings ?? []).some(
        (w) => w.code === "species_illegal",
      ),
    ).toBe(true);
    expect(oakAnswerSchema.safeParse(result).success).toBe(true);
  });
});
