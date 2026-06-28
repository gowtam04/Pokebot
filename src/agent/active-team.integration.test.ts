/**
 * ACTIVE-TEAM-AGENT-E2E — the server-controlled "active team" seam exercised
 * end-to-end through the REAL active-team service, the REAL agent runtime +
 * tool layer (only the Anthropic client is mocked, via a recorded transcript),
 * and a REAL migrated + seeded Postgres schema (Testcontainers). This is the
 * integration checkpoint the design mandates after Phase 7 and folds into
 * Phase 11 (docs/features/team-builder § Integration checkpoints —
 * `active-team-agent-e2e`, § Phase 11 test focus):
 *
 *   a signed-in turn binds `ctx.activeTeam` ONLY when format-matched →
 *   `get_active_team` returns the enriched team + validity warnings (AC-9.3) →
 *   the selection persists + restores on resume → a mismatched-format team is
 *   not bound.
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
type ConvRepo = typeof import("@/data/repos/conversation-repo");
type ActiveTeamSvc = typeof import("@/server/teams/active-team");
type Runtime = typeof import("@/agent/runtime");
type ContextMod = typeof import("@/agent/context");

let fix: PgFixture;
let teamRepo: TeamRepo;
let convRepo: ConvRepo;
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
  convRepo = await import("@/data/repos/conversation-repo");
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
    "Read the active team (get_active_team): one Garchomp, flagged incomplete (<6 members).",
  citations: [],
  inferences: [],
  generation_basis: { generation: "gen-9", fallback: false },
};

async function buildCtx(
  mode: AgentMode,
  activeTeam: import("@/server/teams/active-team").ActiveTeam | undefined,
): Promise<AgentContext> {
  return contextMod.createAgentContext({
    requestId: "active-team-it",
    mode,
    activeTeam,
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
// get_active_team — through the real runtime, returns the enriched team +
// validity warnings on demand, and {active:false} when none is bound (AC-9.3).
// ---------------------------------------------------------------------------

describe("active-team-agent-e2e — get_active_team via the real runtime", () => {
  it("returns the enriched team (display names) + an incomplete warning when bound", async () => {
    const now = Date.now();
    const team = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "SV Squad",
      members: [garchompMember()],
      now,
    });
    const db = fix.db as unknown as import("@/data/db").OakDb;
    const activeTeam = await activeTeamSvc.resolveActiveTeam(
      ACCT_A,
      team.id,
      "standard",
      db,
    );
    expect(activeTeam).not.toBeNull();

    const ctx = await buildCtx("standard", activeTeam!);
    const { client, snapshots, stream } = scriptedClient([
      message([toolUse("get_active_team", {}, "t1")]),
      message([toolUse("submit_answer", TEAM_ANSWER, "t2")]),
    ]);

    const progress: string[] = [];
    const result = await runtime.runOakWith(
      client,
      "how's my team look?",
      [] as ChatMessage[],
      ctx,
      (e) => progress.push(e.tool),
    );

    // The tool fired, and its tool_result (fed back on the 2nd turn) carries the
    // enriched team: active:true, the Garchomp display name, and the COMPUTED
    // incomplete warning (validity surfaced on demand, AC-9.3).
    expect(progress).toContain("get_active_team");
    expect(stream).toHaveBeenCalledTimes(2);
    const toolResult = lastToolResultText(snapshots[1]);
    expect(toolResult).toMatch(/"active":\s*true/);
    expect(toolResult).toContain("Garchomp"); // species_display from searchable_names
    expect(toolResult).toContain("incomplete"); // validateTeam warning

    expect(oakAnswerSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("answered");
  });

  it("returns {active:false} when no team is bound (the model can still answer)", async () => {
    const ctx = await buildCtx("standard", undefined);
    const { client, snapshots } = scriptedClient([
      message([toolUse("get_active_team", {}, "t1")]),
      message([toolUse("submit_answer", TEAM_ANSWER, "t2")]),
    ]);

    await runtime.runOakWith(client, "how's my team?", [] as ChatMessage[], ctx);

    expect(lastToolResultText(snapshots[1])).toMatch(/"active":\s*false/);
  });
});

// ---------------------------------------------------------------------------
// Persist + restore on resume — the selection rides the conversation
// (TEAM-US-8 / BR-T9, last-selected-wins) and a format-mismatched team is not
// bound on a later turn.
// ---------------------------------------------------------------------------

describe("active-team-agent-e2e — persist + restore on resume", () => {
  it("persists the bound team on the turn and restores it on resume", async () => {
    const now = Date.now();
    const team = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: SV,
      name: "SV Squad",
      members: [garchompMember()],
      now,
    });
    const convId = "conv-active-1";

    // A turn that bound this team persists active_team_id last-selected-wins.
    await convRepo.appendTurnPair({
      accountId: ACCT_A,
      conversationId: convId,
      format: SV,
      userTurnId: convRepo.newTurnId(),
      userMessage: "rate my team",
      assistantTurnId: convRepo.newTurnId(),
      answer: TEAM_ANSWER,
      now,
      activeTeamId: team.id,
    });

    // Resume: the conversation restores its active team (AC-8.1).
    const resumed = await convRepo.getConversation(ACCT_A, convId);
    expect(resumed?.activeTeamId).toBe(team.id);

    // Re-resolving on resume still binds it (format still matches).
    const db = fix.db as unknown as import("@/data/db").OakDb;
    const rebound = await activeTeamSvc.resolveActiveTeam(
      ACCT_A,
      resumed!.activeTeamId,
      "standard",
      db,
    );
    expect(rebound?.id).toBe(team.id);

    // Set + clear the active team without chatting (the PATCH path, AC-8.2).
    await convRepo.setActiveTeam(ACCT_A, convId, null);
    expect((await convRepo.getConversation(ACCT_A, convId))?.activeTeamId).toBeNull();
    await convRepo.setActiveTeam(ACCT_A, convId, team.id);
    expect((await convRepo.getConversation(ACCT_A, convId))?.activeTeamId).toBe(team.id);
  });

  it("does not bind a persisted team when the resumed turn's format disagrees (BR-T3)", async () => {
    const now = Date.now();
    // The team is Champions-format; a standard-mode resume must not bind it.
    const chTeam = await teamRepo.createTeam({
      accountId: ACCT_A,
      format: CH,
      name: "Champ Squad",
      members: [garchompMember()],
      now,
    });
    const db = fix.db as unknown as import("@/data/db").OakDb;
    expect(
      await activeTeamSvc.resolveActiveTeam(ACCT_A, chTeam.id, "standard", db),
    ).toBeNull();
  });
});
