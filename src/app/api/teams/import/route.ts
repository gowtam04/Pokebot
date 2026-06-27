/**
 * `POST /api/teams/import` — Showdown paste → a new saved team
 * (docs/features/team-builder § API Design; TEAM-US-10, BR-T7, BR-T11, AC-10.2,
 * AC-10.3, BR-T2).
 *
 *   POST body { format, paste } → 200 { team, validation, notes: ImportNote[] }
 *
 * Never aborts wholesale: `importPaste` resolves what it can and surfaces the
 * rest as `notes`; the team is created from whatever resolved (the resolve-or-
 * clarify contract). Validation is warn-but-allow.
 *
 * WAVE-2 carry-over: `@pkmn` does NOT clamp EVs, so `importPaste` can return a
 * member with an EV/IV > 255, which would fail `teamMembersSchema` (max 255) on
 * write/read. We CLAMP those into the schema range here so the import is a safe
 * **200** (never a 500); `validateTeam` then owns the competitive cap warnings
 * (>252 per stat / total >508 / IV outside 0..31). `importPaste` itself emits no
 * cap warnings.
 *
 * Guests → **401**.
 */

import { json, jsonError, readJsonObject } from "@/app/api/auth/_lib/http";
import { isFormat } from "@/data/formats";
import { teamMembersSchema, type TeamMember } from "@/data/teams/team-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TEAM_NAME = "Imported team";

const UNAUTHORIZED = () =>
  jsonError(401, "unauthorized", "You must be signed in.");

async function currentAccount() {
  const { getCurrentAccount } = await import("@/server/auth/current-user");
  return getCurrentAccount();
}

/** Clamp a single stat value into the schema-legal range (0..255). */
function clampStat(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.trunc(v)));
}

/**
 * Bring a member's EV/IV spreads into the schema range so the team can be
 * persisted/round-tripped. `@pkmn` may hand back out-of-range values; we never
 * reject the import for them (validateTeam flags the competitive caps).
 */
function clampMember(m: TeamMember): TeamMember {
  const clampSpread = (s: TeamMember["evs"]) => ({
    hp: clampStat(s.hp),
    atk: clampStat(s.atk),
    def: clampStat(s.def),
    spa: clampStat(s.spa),
    spd: clampStat(s.spd),
    spe: clampStat(s.spe),
  });
  return { ...m, evs: clampSpread(m.evs), ivs: clampSpread(m.ivs) };
}

export async function POST(req: Request): Promise<Response> {
  const account = await currentAccount();
  if (account === null) return UNAUTHORIZED();

  const body = await readJsonObject(req);
  if (body === null) {
    return jsonError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (typeof body.format !== "string" || !isFormat(body.format)) {
    return jsonError(400, "invalid_request", "A valid `format` is required.");
  }
  const format = body.format;

  if (typeof body.paste !== "string") {
    return jsonError(400, "invalid_request", "`paste` (Showdown text) is required.");
  }
  const paste = body.paste;

  const { db } = await import("@/data/db");
  const { importPaste } = await import("@/server/teams/import-export");
  const { createTeam } = await import("@/data/repos/team-repo");
  const { validateTeam } = await import("@/server/teams/validate-team");

  const { members: rawMembers, notes } = await importPaste(paste, format, db);

  // Clamp out-of-range EV/IVs into the schema range so persistence never throws
  // (carry-over). `safeParse` is a belt-and-suspenders guard: if anything still
  // fails the schema, drop to an empty team rather than 500 the import.
  const clamped = rawMembers.map(clampMember);
  const parsed = teamMembersSchema.safeParse(clamped);
  const members: TeamMember[] = parsed.success ? parsed.data : [];

  const team = await createTeam({
    accountId: account.id,
    format,
    name: DEFAULT_TEAM_NAME,
    members,
    now: Date.now(),
  });
  const validation = await validateTeam(team.members, format, db);

  return json(200, { team, validation, notes });
}
