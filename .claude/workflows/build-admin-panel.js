export const meta = {
  name: 'build-admin-panel',
  description:
    'Build the Oak read-only admin panel (Next.js App Router + TypeScript, Postgres/Drizzle) per docs/features/admin-panel — phase by phase down the Build Manifest DAG, each phase gated by real typecheck/lint/Vitest commands with a bounded repair loop, plus 3 integration checkpoints. Adds turn_record + auth_event tables, non-blocking usage recording, ADMIN_EMAILS gating, cross-account read repos, /api/admin/* endpoints, and the /admin UI section. All work happens in one shared web/ tree (pass args.root to target a worktree).',
  whenToUse:
    'Run to (re)build the Oak admin panel. Default (no args) builds the whole DAG p1–p9 in the main repo; pass {root, phases} to target a worktree and/or a subset (phases: "p4" or ["p4","p5"]); resume a paused run with resumeFromRunId.',
  phases: [
    { title: 'P1 Recording storage', detail: 'turn_record+auth_event schema, db:generate, usage-repo, pricing' },
    { title: 'P2 Wire recording', detail: 'onTurnComplete sink; non-blocking recordTurn/recordAuthEvent' },
    { title: 'P3 Admin gating', detail: 'ADMIN_EMAILS, isAdmin/requireAdmin, requireAdminRequest guard' },
    { title: 'P4 Read repos', detail: 'admin-analytics-repo ∥ admin-content-repo + admin-types + fixtures' },
    { title: 'P5 Admin API', detail: '12 /api/admin/* GET handlers + integration test' },
    { title: 'P6 Admin shell', detail: 'gated layout, nav, shared admin primitives (hand-rolled SVG charts)' },
    { title: 'P7 Observability screens', detail: 'overview/cost/errors/usage + drill-down + live' },
    { title: 'P8 Account & content screens', detail: 'accounts/conversations/teams browsers' },
    { title: 'P9 Integration & privacy', detail: 'privacy disclosure, README/CLAUDE, e2e' },
    { title: 'Checkpoints', detail: 'recording-e2e (after p2), admin-api-e2e (after p5), panel-e2e (after p9)' },
    { title: 'Finalize', detail: 'contract guard + summary + deferred human follow-ups' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// args: {root?, phases?}  (back-compat: a bare string/array is treated as phases)
//   root   — repo/worktree root the agents operate in (keeps this file generic)
//   phases — 'all' | 'p4' | ['p4','p5']
// ─────────────────────────────────────────────────────────────────────────────
// Robust arg parsing: the host may deliver `args` as an actual object/array OR as a
// JSON-encoded string. Normalize to {root?, phases?}.
let A = args
if (typeof A === 'string') {
  const s = A.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      A = JSON.parse(s)
    } catch (e) {
      /* keep as bare string */
    }
  }
}
if (typeof A === 'string') A = { phases: A } // bare phase string, e.g. 'all' | 'p4'
else if (Array.isArray(A)) A = { phases: A } // bare phase list, e.g. ['p4','p5']
else if (!A || typeof A !== 'object') A = {} // undefined/null
const ARGS = A
const ROOT = ARGS.root || '/Users/gowtam/Documents/Projects/Oak'
const WEB = `${ROOT}/web`
const DESIGN = 'docs/features/admin-panel/architecture/design.md'
const REQS = 'docs/features/admin-panel/requirements/requirements.md'
const MAX_REPAIR = 3
const REPAIR_FLOOR = 40_000 // stop repairing if a budget target is set and less than this remains

// Best-effort Node-20 pin (project pins 20 via .nvmrc; the host may run a newer Node).
// Sourcing nvm is non-fatal if nvm isn't installed.
const NVM = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1 || true;'

// Whole-tree static gates (no Docker). Always run first; fail fast with &&.
const STATIC = `${NVM} cd ${WEB} && npm run typecheck && npm run lint`
// Full suite (node + jsdom) — needs Docker (Testcontainers). Used only at checkpoints.
const FULL_TEST = `${NVM} cd ${WEB} && npm test`
// Production build — used best-effort only in the final checkpoint.
const NEXT_BUILD = `${NVM} cd ${WEB} && npm run build`

// Docker-unavailable soft-pass clause, reused by every node-test verifier/checkpoint.
const DOCKER_CLAUSE = `This runs Vitest's NODE project, which starts a Testcontainers Postgres (needs a Docker daemon). If the command fails ONLY because Docker/Testcontainers is unavailable (e.g. "Cannot connect to the Docker daemon", "connect ECONNREFUSED", "could not find a working container runtime"), then typecheck+lint already passed: treat the phase as PASSED-ON-STATIC, set passed=true, and SAY SO explicitly in the summary. If Vitest actually runs and a real test fails, that is a FAIL with the error tail.`

// ─────────────────────────────────────────────────────────────────────────────
// Schemas (force structured returns)
// ─────────────────────────────────────────────────────────────────────────────
const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'Decisions, deviations, anything the verifier/next phase should know.' },
  },
  required: ['filesWritten'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passed: { type: 'boolean' },
    errorTail: { type: 'string', description: 'Up to ~120 lines of the most relevant tsc/eslint/vitest error output; empty if passed.' },
    summary: { type: 'string' },
  },
  required: ['passed', 'errorTail', 'summary'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'file', 'detail'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['issues', 'summary'],
}
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gatePassed: { type: 'boolean', description: 'Did the broad gate (full test / build) pass — or pass-on-static if Docker absent?' },
    claimVerified: { type: 'boolean', description: 'Did the adversarial inspection confirm the checkpoint claim holds in the code?' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          detail: { type: 'string' },
        },
        required: ['severity', 'detail'],
      },
    },
    errorTail: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['gatePassed', 'claimVerified', 'findings', 'summary'],
}
const GUARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractTouched: { type: 'boolean', description: 'true if any src/agent/tools|prompts|schemas.ts file was modified by the build (a violation)' },
    touchedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['contractTouched', 'touchedFiles', 'summary'],
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared prompt preamble
// ─────────────────────────────────────────────────────────────────────────────
const COMMON = `You are an autonomous builder for the **Oak admin panel** — a read-only, single-owner admin dashboard built AS A PROTECTED /admin ROUTE GROUP INSIDE the existing Next.js app (NOT a separate SPA). Oak is a TypeScript / Next.js App Router monolith rooted at \`web/\`, Postgres via Drizzle + node-postgres, Vitest tests backed by Testcontainers Postgres.

REPO ROOT: ${ROOT}
- The app lives under \`web/\`. Run every command from \`web/\` (\`cd ${WEB}\` first). The \`@/\` alias resolves to \`web/src/\`.
- This may be a git WORKTREE; operate only within ${ROOT}. Prefix node/npm commands with \`${NVM}\` so they run on Node 20 (the project's pinned version).

AUTHORITATIVE SPEC — READ IT, do not rely on memory:
- ${ROOT}/${DESIGN}  (implementation-ready: exact file list under "File Structure", exact signatures under "Interface Definitions", per-phase "Implementation Phases", the YAML "Build Manifest", and "Technical Decisions" AD-1..AD-7)
- ${ROOT}/${REQS}    (requirement IDs ADMIN-US-*, ADMIN-AC-*, ADMIN-BR-*)
- ${ROOT}/CLAUDE.md  ("Gotchas", "Testing", "Key conventions")
Read the sections your phase names BEFORE writing code. The design doc wins over anything stated here.

NON-NEGOTIABLE CONVENTIONS (CLAUDE.md + the ADRs):
- READ-ONLY PANEL (ADMIN-BR-2): nothing in the panel mutates user data, accounts, sessions, or config. The ONLY new writes are the two append-only records (turn_record, auth_event). Admin repos and the admin UI never expose a mutating control.
- NON-BLOCKING RECORDING (ADMIN-BR-3): every recording call is fire-and-forget — \`void recordX(...).catch(logOnly)\` — and is NEVER awaited on the user's chat/auth critical path.
- DO NOT TOUCH THE AGENT CONTRACT: never modify \`web/src/agent/tools/*\`, \`web/src/agent/prompts/*\`, or \`web/src/agent/schemas.ts\`. The cached prompt prefix + tool names are a frozen contract. (p2 may add ONE optional field to \`agent/types.ts\` and ONE line to \`agent/runtime.ts\` finalize() — nothing else in agent/.)
- Zod is the single source of truth for runtime shapes; don't hand-duplicate JSON Schemas. Existing contract names are fixed — never rename them.
- Error styles split at the route seam: Result/structured shapes in the data/repo layer (never throw in-domain); try/catch → \`jsonError(status, code, message)\` mapping at the HTTP edge (helpers in \`web/src/app/api/auth/_lib/http.ts\`: \`json\`, \`jsonError\`).
- Repos are the SOLE Postgres readers and are async; they \`import "server-only"\`, use the \`@/data/db\` singleton, \`.mapWith(Number)\` on count/computed columns (node-postgres returns bigint as string), \`ilike\` (not \`like\`) for substring search, \`bigint({mode:"number"})\` epoch-ms timestamps, \`text\` UUID ids, snake_case columns, logical (un-constrained) FK columns, keyset pagination on (created_at,id).
- API ROUTES: every \`/api/admin/*\` route MUST declare \`export const runtime = "nodejs"\` and \`export const dynamic = "force-dynamic"\`, and reach its repo + the guard via DYNAMIC import (\`const { x } = await import("@/...")\`) inside the handler — a top-level import of an env/db-touching module re-introduces the \`next build\` env-throw. Mirror \`web/src/app/api/auth/me/route.ts\` and \`web/src/app/api/conversations/route.ts\`.
- ENV: \`src/env.ts\` validates eagerly at import and throws on a missing \`XAI_API_KEY\`; that's why env-touching imports are deferred. The admin allowlist must be read from \`process.env.ADMIN_EMAILS\` AT CALL TIME (like \`logger.ts\` reads \`process.env.LOG_LEVEL\`), NOT through the memoized \`env\` object — this sidesteps the build-time throw and makes the allowlist re-stubbable per test with \`vi.stubEnv\`.
- COMPONENT TESTS (jsdom) render fixture payloads ONLY and must NEVER import db/repos/runtime (the jsdom project has no Postgres). Server gating uses \`getCurrentAccount()\` (\`web/src/server/auth/current-user.ts\`, cookie + Bearer).
- NODE TESTS that pull a repo (server-only) must \`vi.mock("server-only", () => ({}))\` at the top (see the reference tests).
- DB COST is an ESTIMATE (ADMIN-BR-5): cost responses carry \`estimated:true\`; pricing is a static in-code table.
- CHARTS: hand-rolled inline SVG/CSS only — DO NOT add recharts or any new dependency.

REFERENCE PATTERNS to mirror (read before writing the analogous file):
- repo oracle test: \`web/src/data/repos/accounts-repo.test.ts\` (uses \`vi.mock("server-only")\`, \`createPgSchema({seed})\`, \`installAsSingleton(fix)\`, dynamic repo import in beforeAll).
- route integration test: \`web/src/app/api/auth/auth-routes.integration.test.ts\`, \`web/src/app/api/teams/teams.integration.test.ts\` (mock getCurrentAccount to flip identity; \`vi.stubEnv\`).
- component test: \`web/src/components/answer-card/*.test.tsx\` (jsdom, fixtures only).
- the recording source object: \`TurnTrace\` in \`web/src/server/logger.ts\` (fields: request_id, session_id, model, input_tokens, output_tokens, thinking_tokens, tool_trace, turn_latency_ms, status, citation_count); the chat route + rate-limit branch in \`web/src/app/api/chat/route.ts\`.

EXECUTION RULES:
- Create files at the EXACT paths in design.md "File Structure". Only create/edit files inside your phase's ownership; edit \`shared\` (pre-existing) files SURGICALLY and ADDITIVELY so other phases and existing behavior are unaffected.
- Do NOT run the build gate yourself (typecheck/lint/vitest is owned by a separate verifier). You MAY read files and run read-only \`git\`/\`grep\` to inspect prior phases' output, and you MAY run \`npm run typecheck\` to self-check before returning.
- EXCEPTION (p1 ONLY): you OWN \`web/drizzle/**\`, so after editing \`schema.ts\` you MUST run \`${NVM} cd ${WEB} && npm run db:generate\` to emit the migration SQL — that generated file IS your phase's artifact and the Vitest harness applies it from \`web/drizzle/\` to every test schema. Confirm a new \`drizzle/00NN_*.sql\` + \`meta\` snapshot was written. NEVER run \`db:migrate\` (it imports @/env and needs a live DB — it's a deploy-time step). Touch ONLY the two new tables in schema.ts so db:generate stays non-interactive.`

// ─────────────────────────────────────────────────────────────────────────────
// PHASES — transcribed from design.md "Build Manifest" (the YAML).
//   depends_on / owns / shared / test_focus are the manifest.
//   gateTest: the phase-specific vitest invocation appended after STATIC.
//   project: 'node' (Docker) | 'jsdom' (no Docker).
//   task | (pre?,fanout,post?): implementer structure.
//   securityReview: optional adversarial concern (used where no checkpoint follows soon).
// ─────────────────────────────────────────────────────────────────────────────
const PHASES = [
  {
    id: 'p1',
    name: 'Recording storage + write repo + pricing',
    depends_on: [],
    owns: ['web/src/data/repos/usage-repo.ts', 'web/src/server/admin/pricing.ts', 'web/src/data/repos/usage-repo.oracle.test.ts', 'web/drizzle/**'],
    shared: ['web/src/data/schema.ts'],
    project: 'node',
    gateTest: `npx vitest run --project node src/data/repos/usage-repo.oracle.test.ts`,
    docs: ['Data Model (turn_record, auth_event)', 'Interface Definitions (usage-repo, pricing)', 'Implementation Phases (Phase 1)', 'AD-3, AD-4, AD-6'],
    test_focus: 'insert/read-back, tool_error_count derivation, cost math (incl. unknown model -> 0)',
    task: `PHASE P1 — RECORDING STORAGE + WRITE REPO + PRICING.
Read design.md "Data Model" + "Interface Definitions" (usage-repo, pricing) + "Implementation Phases > Phase 1" + AD-3/AD-4/AD-6.
1. \`web/src/data/schema.ts\` (SHARED — additive, do NOT alter existing tables): add the two append-only tables EXACTLY per design.md "Data Model":
   - \`turn_record\` (id text PK = request_id; session_id; account_id NULLABLE = guest; mode; status superset incl. "rate_limited" per AD-4; input/output/thinking_tokens int default 0; tool_trace text default '[]'; tool_error_count int default 0; citation_count; turn_latency_ms; images_count; prompt_text text default ''; answer_text text NULLABLE; answer_json text NULLABLE; created_at bigint{mode:number}) + the 5 indexes (created, account+created, session, status+created, model+created).
     IMPORTANT (rate_limited rows are inserted BEFORE the model is resolved on the chat path): make \`model\` and \`provider_model\` NULLABLE so a rate_limited row with no resolved model can be stored without violating NOT NULL. Document this in a comment. (The analytics repo treats null model as "n/a".)
   - \`auth_event\` (id text PK; type; email NULLABLE; account_id NULLABLE; created_flag int NULLABLE; detail text NULLABLE; created_at bigint) + the 2 indexes (created, type+created).
2. Run \`${NVM} cd ${WEB} && npm run db:generate\` to emit the migration into \`web/drizzle/\` (your owned artifact). Verify a new \`drizzle/00NN_*.sql\` + \`drizzle/meta/00NN_snapshot.json\` + updated \`drizzle/meta/_journal.json\` were written. Do NOT hand-write the migration; do NOT predict its filename; do NOT run db:migrate. If db:generate prompts interactively, you've accidentally renamed/retyped an existing column — revert that and re-run.
3. \`web/src/data/repos/usage-repo.ts\` (NEW): \`import "server-only"\`; \`recordTurn(input: TurnRecordInput): Promise<void>\` and \`recordAuthEvent(input: AuthEventInput): Promise<void>\` — both INSERT-only over the \`@/data/db\` singleton. recordTurn DERIVES tool_error_count from toolTrace (count of entries with error != null), JSON.stringifies toolTrace into tool_trace and answer into answer_json. Use the EXACT TurnRecordInput / AuthEventInput interfaces from design.md "Interface Definitions > usage-repo" (allow model/providerModel to be string|null to match the nullable columns).
4. \`web/src/server/admin/pricing.ts\` (NEW): \`ModelPrice\`, \`MODEL_PRICING: Record<string, ModelPrice>\` keyed by ModelKey, \`estimateCostUsd({model,inputTokens,outputTokens,thinkingTokens}): number\` — unknown/null model -> 0 (caller flags). Use reasonable static placeholder per-1M prices and note them.
TESTS: \`web/src/data/repos/usage-repo.oracle.test.ts\` mirroring \`accounts-repo.test.ts\`'s harness (vi.mock("server-only"), createPgSchema({seed:"none"}), installAsSingleton, dynamic import). Assert: insert then read back every turn_record column; tool_error_count is derived (mix of error/no-error tool entries); a rate_limited row stores null model AND null answer_text/answer_json; recordAuthEvent round-trips; estimateCostUsd math for a known model AND unknown model -> 0.`,
  },
  {
    id: 'p2',
    name: 'Wire recording into chat + auth (non-blocking)',
    depends_on: ['p1'],
    owns: [],
    shared: ['web/src/agent/types.ts', 'web/src/agent/runtime.ts', 'web/src/app/api/chat/route.ts', 'web/src/app/api/chat/route.test.ts', 'web/src/server/auth/auth-service.ts'],
    project: 'node',
    gateTest: `npx vitest run --project node src/app/api/chat/route.test.ts src/server/auth`,
    docs: ['Component Design §1 (Usage recording)', 'Interface Definitions (recording sink)', 'Implementation Phases (Phase 2)', 'AD-2'],
    test_focus: 'one record per turn; recorder failure never fails/delays turn; rate_limited row; auth events',
    securityReview: `NON-BLOCKING + correctness (ADMIN-BR-3). Confirm: (1) every recordTurn/recordAuthEvent is \`void recordX(...).catch(logOnly)\` — NEVER awaited on the request's critical path, and a thrown/rejected recorder cannot fail or delay the turn or the SSE stream. (2) exactly ONE turn_record per completed turn (post-answer path) AND one on the pre-stream rate-limit rejection branch with status "rate_limited" (NOT on the input_too_long branch). (3) runtime stays pure — only \`ctx.onTurnComplete?.(trace)\` added in finalize(), runOak's return type unchanged, no other agent/ file touched except types.ts. (4) recordTurn is reached via a DYNAMIC import in the route. (5) no token/OTP/email/raw-image content is logged beyond what the schema stores.`,
    task: `PHASE P2 — WIRE RECORDING INTO CHAT + AUTH (non-blocking). Read design.md "Component Design §1" + "Interface Definitions > Recording sink" + "Implementation Phases > Phase 2" + AD-2.
- \`web/src/agent/types.ts\` (SHARED — additive): add \`onTurnComplete?: (trace: TurnTrace) => void\` to AgentContext (a pure sink; import the existing TurnTrace type). This is the ONLY allowed change under agent/ besides the one runtime line.
- \`web/src/agent/runtime.ts\` (SHARED — surgical): in \`finalize()\`, right next to the existing \`logTurn(trace, ...)\` call, add ONE line: \`ctx.onTurnComplete?.(trace)\`. No other runtime change; runOak's return type is unchanged.
- \`web/src/app/api/chat/route.ts\` (SHARED — surgical): \`createAgentContext\` does NOT take onTurnComplete, so set it POST-CONSTRUCTION on the returned ctx object (\`ctx.onTurnComplete = (trace) => { captured = trace }\`) — the same way the route already reads other server-controlled ctx fields. Reach recordTurn via a DYNAMIC import (\`const { recordTurn } = await import("@/data/repos/usage-repo")\`) — never a top-level import. In the EXISTING post-answer non-blocking section (where conversation turns are already persisted in try/catch), compose a TurnRecordInput from the captured trace + message/images/answer/account/mode and fire \`void recordTurn(...).catch(logOnly)\`. On the PRE-STREAM rejection branch, record ONLY when the reason is rate_limited (NOT input_too_long); since the model may be unresolved there, pass model:null/providerModel:null (schema is nullable from p1) — or resolve activeModelKey() first if you prefer; keep it consistent. Never await these.
- \`web/src/server/auth/auth-service.ts\` (SHARED — additive): at the three auth emit sites (otp_requested; otp_verified [set created_flag = signup?1:0 and accountId/email]; otp_email_failed [detail = error]) add a sibling \`void recordAuthEvent(...).catch(logOnly)\` (dynamic import of the repo).
TESTS: UPDATE \`web/src/app/api/chat/route.test.ts\` (SHARED). NOTE the existing test mocks runOak AND createAgentContext, so finalize() never runs on its own — your "writes one turn_record" test must have the mocked runOak (or the mocked ctx) INVOKE \`ctx.onTurnComplete?.(fakeTrace)\`, and you must \`vi.mock("@/data/repos/usage-repo")\` to assert the call. Assert: a completed turn writes exactly ONE turn_record with correct fields; a recorder that REJECTS (mock recordTurn to throw/reject) leaves the turn's response/stream unaffected and undelayed; a rate-limited request writes a rate_limited row (and input_too_long does NOT). Keep the existing chat-route assertions green. Auth-event assertions extend the auth-service tests under src/server/auth.`,
  },
  {
    id: 'p3',
    name: 'Admin auth gating',
    depends_on: [],
    owns: ['web/src/server/auth/admin.ts', 'web/src/server/auth/admin.test.ts', 'web/src/app/api/admin/_lib/guard.ts'],
    shared: ['web/src/env.ts'],
    project: 'node',
    gateTest: `npx vitest run --project node src/server/auth/admin.test.ts`,
    docs: ['Component Design §2 (Admin auth & gating)', 'Interface Definitions (Admin auth)', 'API Design (auth)', 'Implementation Phases (Phase 3)', 'AD-5'],
    test_focus: 'allowlist match/normalization; empty/unset -> zero admins; guard 401/403/pass',
    securityReview: `GATING correctness (ADMIN-AC-1.*, ADMIN-BR-1). Confirm: allowlist matching normalizes email (trim + lowercase) on BOTH sides; isAdmin reads \`process.env.ADMIN_EMAILS\` AT CALL TIME (not the memoized env); an EMPTY or UNSET ADMIN_EMAILS yields ZERO admins (safe dark default); requireAdminRequest returns 401 for no session, 403 for an authenticated non-admin, and the account for an admin; it reuses the SAME getCurrentAccount + isAdmin (no second code path).`,
    task: `PHASE P3 — ADMIN AUTH GATING. Read design.md "Component Design §2" + "Interface Definitions > Admin auth" + "API Design" + AD-5.
- \`web/src/env.ts\` (SHARED — additive): add \`ADMIN_EMAILS\` (optional, comma-separated) using the existing \`preprocess(emptyToUndefined, ...)\` pattern, for documentation/validation. Do NOT make it required (unset must boot fine).
- \`web/src/server/auth/admin.ts\` (NEW): \`isAdmin(account: Account | null): boolean\` — read the allowlist from \`process.env.ADMIN_EMAILS\` AT CALL TIME (split on comma, trim+lowercase each), compare to the normalized account.email; null account or empty/unset list -> false. \`requireAdmin(account: Account | null): Account\` throws if !isAdmin. Import the existing Account type. Do NOT import \`@/env\` here (call-time process.env keeps this build-safe + test-stubbable).
- \`web/src/app/api/admin/_lib/guard.ts\` (NEW): \`requireAdminRequest(req: Request): Promise<{account: Account} | {response: Response}>\` — resolve getCurrentAccount() (dynamic import); if null return {response: jsonError(401,"unauthorized")}; if not isAdmin return {response: jsonError(403,"forbidden")}; else {account}. Use json/jsonError from \`web/src/app/api/auth/_lib/http.ts\`.
TESTS: \`web/src/server/auth/admin.test.ts\` — use \`vi.stubEnv("ADMIN_EMAILS", ...)\` to set the allowlist per case; assert match incl. case/whitespace normalization; unset/empty -> no admins; cover isAdmin/requireAdmin thoroughly (guard branches can also be covered here by mocking getCurrentAccount, or deferred to the p5 integration test).`,
  },
  {
    id: 'p4',
    name: 'Admin read repos',
    depends_on: ['p1'],
    owns: ['web/src/data/repos/admin-analytics-repo.ts', 'web/src/data/repos/admin-content-repo.ts', 'web/src/lib/admin/admin-types.ts', 'web/src/data/repos/admin-analytics-repo.oracle.test.ts', 'web/src/data/repos/admin-content-repo.oracle.test.ts', 'web/test/fixtures/admin-fixture.ts'],
    shared: [],
    project: 'node',
    gateTest: `npx vitest run --project node src/data/repos/admin-analytics-repo.oracle.test.ts src/data/repos/admin-content-repo.oracle.test.ts`,
    docs: ['Component Design §3 (Admin read repos)', 'Interface Definitions (analytics-repo, content-repo)', 'API Design (params)', 'Implementation Phases (Phase 4)', 'AD-7'],
    test_focus: 'aggregation correctness, distinct active-user counts, cost rollups, error taxonomy (ADMIN-BR-9), cross-account search/keyset pagination',
    pre: {
      label: 'types',
      files: 'web/src/lib/admin/admin-types.ts',
      detail: `\`web/src/lib/admin/admin-types.ts\` (NEW, CLIENT-SAFE — no server-only / db imports): the shared request/response wire types imported by BOTH the repos AND (later) the API routes + pages, so shapes can't drift. Define TurnSummary, TurnDetail, AccountWithActivity, SessionInfo, ConversationSummary, StoredTurn, TeamSummary, TeamDetail, plus the API response wrappers OverviewResponse, CostResponse, ErrorsResponse, TurnsListResponse, TurnDetailResponse, AccountsResponse, AccountDetailResponse, LiveResponse, and the conversations/teams responses — EXACTLY per design.md "Interface Definitions" and "API Design". Carry estimated:true on cost. Pure types/constants only.`,
    },
    fanout: [
      {
        label: 'analytics-repo',
        files: 'web/src/data/repos/admin-analytics-repo.ts (+ oracle test)',
        detail: `\`web/src/data/repos/admin-analytics-repo.ts\` (NEW, server-only) + \`admin-analytics-repo.oracle.test.ts\`. Implement the EXACT signatures from design.md "Interface Definitions > admin-analytics-repo": getUsageSeries(Range), getCostBreakdown(Range), getErrorBreakdown(Range), getHeavyUsers(Range,sort,limit), getLive(). Aggregate with SQL GROUP BY + date_trunc over to_timestamp(created_at/1000), bucket day|hour; .mapWith(Number) on every computed column; distinct active-user counts (signed vs guest split); cost via pricing.estimateCostUsd per model (null model -> "n/a", priced:false); error taxonomy per ADMIN-BR-9 (resolution_failed|clarification_needed|insufficient_data|tool_error[from tool_error_count>0]|otp_email_failed|rate_limited). TEST against the shared admin fixture seed: bucket boundaries, distinct active counts, cost rollups by model, every error category, heavy-user ranking by turns/cost/errors, live recent+window. Import types from \`@/lib/admin/admin-types\`.`,
      },
      {
        label: 'content-repo',
        files: 'web/src/data/repos/admin-content-repo.ts (+ oracle test)',
        detail: `\`web/src/data/repos/admin-content-repo.ts\` (NEW, server-only) + \`admin-content-repo.oracle.test.ts\`. Implement the EXACT signatures from design.md "Interface Definitions > admin-content-repo": listTurns(TurnFilter)/getTurn(id); listAccounts/getAccountDetail; listAllConversations/getConversationThread; listAllTeams/getTeamById. These are CROSS-ACCOUNT (UN-scoped) reads — the opposite of the existing account-scoped repos. ilike substring search; KEYSET pagination on (created_at,id) returning nextCursor. TEST against the shared admin fixture (multi-account): cross-account listing returns rows from all accounts AND guest turns; search filters; keyset pagination returns stable non-overlapping pages; getTurn drill-down returns full tool_trace/prompt_text/answer_json; null on miss. Import row types from \`@/lib/admin/admin-types\`.`,
      },
    ],
    post: `P4 SHARED FIXTURE — also create \`web/test/fixtures/admin-fixture.ts\`: a DETERMINISTIC seed helper that inserts a realistic multi-account dataset into \`account\`, \`auth_session\`, \`conversation\`/\`conversation_message\`, \`team\`, \`turn_record\` (multiple accounts + guest turns, multiple models incl. a null-model rate_limited row, every status, spread across FIXED \`created_at\` epoch-ms values so date_trunc bucket assertions are stable) and \`auth_event\`. Both oracle tests import it (createPgSchema({seed:"none"}) then run this helper against the installed singleton). Keep all timestamps hard-coded constants — no Date.now.`,
  },
  {
    id: 'p5',
    name: 'Admin API endpoints',
    depends_on: ['p3', 'p4'],
    owns: ['web/src/app/api/admin/overview/**', 'web/src/app/api/admin/cost/**', 'web/src/app/api/admin/errors/**', 'web/src/app/api/admin/turns/**', 'web/src/app/api/admin/accounts/**', 'web/src/app/api/admin/conversations/**', 'web/src/app/api/admin/teams/**', 'web/src/app/api/admin/live/**', 'web/src/app/api/admin/admin-routes.integration.test.ts'],
    shared: [],
    project: 'node',
    gateTest: `npx vitest run --project node src/app/api/admin/admin-routes.integration.test.ts`,
    docs: ['Component Design §4 (Admin API)', 'API Design (params, shapes, error envelope)', 'Implementation Phases (Phase 5)'],
    test_focus: 'per-route gating (401/403/200); param defaults; response shapes match admin-types; pagination cursors',
    fanout: [
      { label: 'overview', files: 'web/src/app/api/admin/overview/route.ts', detail: `GET /api/admin/overview -> OverviewResponse (KPI totals + per-bucket series + headline cost & error rate).` },
      { label: 'cost', files: 'web/src/app/api/admin/cost/route.ts', detail: `GET /api/admin/cost -> CostResponse (token totals + estUSD by model + per-bucket series; estimated:true).` },
      { label: 'errors', files: 'web/src/app/api/admin/errors/route.ts', detail: `GET /api/admin/errors -> ErrorsResponse (counts/rates by category over the range).` },
      { label: 'turns', files: 'web/src/app/api/admin/turns/route.ts + turns/[id]/route.ts', detail: `GET /api/admin/turns -> TurnsListResponse (paginated, filtered summary rows). GET /api/admin/turns/[id] -> TurnDetailResponse (full turn_record incl. tool_trace/prompt_text/answer_json).` },
      { label: 'accounts', files: 'web/src/app/api/admin/accounts/route.ts + accounts/[id]/route.ts', detail: `GET /api/admin/accounts -> AccountsResponse (accounts + derived activity; ?sort=cost|turns|errors|recent enables heavy-users — NOT a separate route). GET /api/admin/accounts/[id] -> AccountDetailResponse (activity + sessions).` },
      { label: 'conversations', files: 'web/src/app/api/admin/conversations/route.ts + conversations/[id]/route.ts', detail: `GET /api/admin/conversations -> cross-account list; GET /api/admin/conversations/[id] -> full thread.` },
      { label: 'teams', files: 'web/src/app/api/admin/teams/route.ts + teams/[id]/route.ts', detail: `GET /api/admin/teams -> cross-account list; GET /api/admin/teams/[id] -> detail.` },
      { label: 'live', files: 'web/src/app/api/admin/live/route.ts', detail: `GET /api/admin/live -> LiveResponse (last N turns + current-window counts); intended for ~10s client polling (ADMIN-BR-10).` },
    ],
    post: `P5 INTEGRATION TEST — \`web/src/app/api/admin/admin-routes.integration.test.ts\` (mirror \`auth-routes.integration.test.ts\` / \`teams.integration.test.ts\`). EVERY handler must declare \`runtime="nodejs"\`+\`dynamic="force-dynamic"\`, dynamically import its repo + the guard, call requireAdminRequest FIRST (return its {response} before touching a repo), then parse query (lenient defaults: from/to default last 7 days, bucket=day, limit defaults, never 500 on bad params), then json(200,...). Use \`@/lib/admin/admin-types\` for response types. TEST: for EVERY route — no session -> 401 {code:"unauthorized"}; authed non-admin -> 403 {code:"forbidden"}; admin -> 200 with correctly shaped/filtered payload; param defaults applied; keyset cursor round-trips. Seed via the p4 admin fixture; mock getCurrentAccount + \`vi.stubEnv("ADMIN_EMAILS", ...)\` to flip identity.`,
  },
  {
    id: 'p6',
    name: 'Admin shell — gated layout, nav, shared components',
    depends_on: ['p5'],
    owns: ['web/src/app/admin/layout.tsx', 'web/src/app/admin/admin.css', 'web/src/components/admin/**'],
    shared: [],
    project: 'jsdom',
    gateTest: `npx vitest run --project jsdom src/components/admin`,
    docs: ['Component Design §5 (Admin frontend)', 'Implementation Phases (Phase 6)', 'AD-1, AD-5'],
    test_focus: 'nav render; non-admin server-gate redirect; primitives render fixtures',
    uiTestNote: true,
    fanout: [
      { label: 'KpiCard', files: 'web/src/components/admin/KpiCard.tsx (+ .test.tsx)', detail: `Headline metric tile. Pure props; renders fixture data.` },
      { label: 'TimeSeriesChart', files: 'web/src/components/admin/TimeSeriesChart.tsx (+ .test.tsx)', detail: `Bucketed line/area chart over a series prop, rendered as HAND-ROLLED inline SVG/CSS (NO recharts, NO new dependency). Test renders without crashing on a fixture series AND an empty series.` },
      { label: 'DataTable', files: 'web/src/components/admin/DataTable.tsx (+ .test.tsx)', detail: `Sortable/paginated table over rows + columns props; a "load more"/cursor affordance. NO mutating row actions (read-only).` },
      { label: 'FilterBar', files: 'web/src/components/admin/FilterBar.tsx (+ .test.tsx)', detail: `model/mode/status/kind/search filter controls; emits a filter object via callback.` },
      { label: 'DateRangePicker', files: 'web/src/components/admin/DateRangePicker.tsx (+ .test.tsx)', detail: `Global from/to + bucket control; default last 7 days / day.` },
      { label: 'TurnDetail', files: 'web/src/components/admin/TurnDetail.tsx (+ .test.tsx)', detail: `Full per-turn breakdown over a TurnDetailResponse fixture (tokens, tool_trace, prompt_text, answer_json re-render). Read-only.` },
    ],
    post: `P6 SHELL INTEGRATOR — \`web/src/app/admin/layout.tsx\` (NEW, SERVER component): the SECOND gate (AD-5) — resolve the account server-side and \`redirect("/")\` (or notFound()) for non-admins so non-admins never receive admin HTML; render the nav shell (tabs: Overview, Usage, Cost, Errors, Accounts, Conversations, Teams) + the global DateRangePicker provider. \`web/src/app/admin/admin.css\` (NEW): admin BEM styles. TESTS (all jsdom, placed UNDER \`web/src/components/admin/\` — the jsdom project does NOT scan src/app): nav renders all tabs; the layout's gate redirects a non-admin (extract the gate decision into a testable component/helper under src/components/admin if needed; mock getCurrentAccount + isAdmin); each primitive renders its fixture without importing db/repos.`,
  },
  {
    id: 'p7',
    name: 'Observability screens',
    depends_on: ['p5', 'p6'],
    owns: ['web/src/app/admin/page.tsx', 'web/src/app/admin/cost/**', 'web/src/app/admin/errors/**', 'web/src/app/admin/usage/**'],
    shared: [],
    project: 'jsdom',
    gateTest: `npx vitest run --project jsdom src/components/admin`,
    docs: ['Component Design §5', 'API Design', 'Implementation Phases (Phase 7)', 'requirements (ADMIN-US-2/3/4/5/7, ADMIN-AC-5.2)'],
    test_focus: 'fixture KPIs/series/filters; full drill-down breakdown (ADMIN-AC-5.2); live polling',
    uiTestNote: true,
    fanout: [
      { label: 'overview', files: 'web/src/app/admin/page.tsx (Overview) + a tested view component in src/components/admin/', detail: `Overview: KPI cards + usage series + headline cost/error rate from GET /api/admin/overview.` },
      { label: 'cost', files: 'web/src/app/admin/cost/page.tsx + src/components/admin view', detail: `Cost screen from GET /api/admin/cost; show estimated:true caveat (ADMIN-BR-5).` },
      { label: 'errors', files: 'web/src/app/admin/errors/page.tsx + src/components/admin view', detail: `Errors screen from GET /api/admin/errors; each category links to a Usage filter.` },
      { label: 'usage', files: 'web/src/app/admin/usage/page.tsx + usage/[id]/page.tsx + src/components/admin views', detail: `Usage explorer (filtered/paginated turns from GET /api/admin/turns) + the per-turn DRILL-DOWN at usage/[id] (GET /api/admin/turns/[id]) via TurnDetail (ADMIN-AC-5.2).` },
      { label: 'live', files: 'web/src/app/admin/usage live panel + src/components/admin view', detail: `Live view that polls GET /api/admin/live every ~10s (ADMIN-BR-10) — recent turns + current-window counts. Polling, NOT SSE/streaming.` },
    ],
    post: `P7 NOTE: keep each app/admin page a THIN client wrapper that fetches its endpoint and renders an extracted, tested component under \`web/src/components/admin/\`. Put ALL jsdom tests under \`web/src/components/admin/\` (the jsdom project does NOT scan src/app). Tests render fixture payloads only (never import repos): assert KPIs/series/filters, the full drill-down breakdown, and that the live view issues a poll (fake timers).`,
  },
  {
    id: 'p8',
    name: 'Account & content screens',
    depends_on: ['p5', 'p6'],
    owns: ['web/src/app/admin/accounts/**', 'web/src/app/admin/conversations/**', 'web/src/app/admin/teams/**'],
    shared: [],
    project: 'jsdom',
    gateTest: `npx vitest run --project jsdom src/components/admin`,
    docs: ['Component Design §5', 'API Design', 'Implementation Phases (Phase 8)', 'requirements (ADMIN-US-8/9/10/11)'],
    test_focus: 'fixture lists/detail; search; thread reader; NO mutating controls (read-only)',
    uiTestNote: true,
    fanout: [
      { label: 'accounts', files: 'web/src/app/admin/accounts/page.tsx + accounts/[id]/page.tsx + src/components/admin views', detail: `Accounts list (+ derived activity; ?sort enables the heavy-users view, ADMIN-US-11) and detail (activity + sessions). View-only (ADMIN-US-8).` },
      { label: 'conversations', files: 'web/src/app/admin/conversations/page.tsx + conversations/[id]/page.tsx + src/components/admin views', detail: `Cross-account conversations browser + a full THREAD READER at conversations/[id] (ADMIN-US-9). Read-only.` },
      { label: 'teams', files: 'web/src/app/admin/teams/page.tsx + src/components/admin view', detail: `Cross-account saved-teams browser (ADMIN-US-10). Read-only.` },
    ],
    post: `P8 NOTE: same pattern as P7 — thin app/admin pages, tested view components + ALL jsdom tests under \`web/src/components/admin/\`. Tests: fixture lists/detail; search filters; the thread reader renders a multi-turn fixture; assert there are NO mutating controls anywhere (no edit/delete/save buttons) — the panel is strictly read-only (ADMIN-BR-2).`,
  },
  {
    id: 'p9',
    name: 'Integration, privacy disclosure, polish',
    depends_on: ['p2', 'p7', 'p8'],
    owns: [],
    shared: ['web/src/app/privacy/page.tsx', 'README.md', 'CLAUDE.md'],
    project: 'jsdom',
    gateTest: `npx vitest run --project jsdom src/components/admin`,
    docs: ['Implementation Phases (Phase 9)', 'Deployment & Infrastructure', 'AD-3 (privacy consequence)', 'requirements (ADMIN-BR-2/4/7, ADMIN-AC-1.2)'],
    test_focus: 'privacy copy present; admin-only access; read-only',
    securityReview: `READ-ONLY + PRIVACY + GATING (ADMIN-BR-2/4/7, ADMIN-AC-1.2). Confirm: the admin UI exposes NO mutating control anywhere; the privacy page now DISCLOSES operator read-access + per-turn usage recording (incl. guest prompt/answer storage) per AD-3/ADMIN-BR-7; both gates (layout server redirect + every API route's requireAdminRequest) are present and consistent.`,
    task: `PHASE P9 — INTEGRATION, PRIVACY DISCLOSURE, POLISH. Read design.md "Implementation Phases > Phase 9" + "Deployment & Infrastructure" + AD-3.
- \`web/src/app/privacy/page.tsx\` (SHARED — additive): DISCLOSE that the operator can read account/guest conversations and that Oak persists one record per chat turn (prompt + answer, guests included) and per auth event, retained indefinitely (AD-3, ADMIN-BR-7). Honest, plain copy.
- DO NOT edit \`web/src/app/page.tsx\` — per the risk review, skip the main-page admin link; the sole operator reaches the panel via the direct \`/admin\` URL (the layout still gates).
- \`README.md\` + \`CLAUDE.md\` (SHARED — additive): document the admin panel, the \`ADMIN_EMAILS\` secret (\`fly secrets set ADMIN_EMAILS=...\`; unset -> zero admins -> dark panel), the two new tables, and that recording is non-blocking + retained indefinitely.
- Empty/zero-data states: ensure each screen renders cleanly with no data.
TESTS: add a jsdom test under \`web/src/components/admin/\` asserting the privacy disclosure copy is present (extract the disclosure into a tested component/string if needed). The cross-cutting e2e (admin sees a real turn; non-admin fully blocked) is verified by the panel-e2e checkpoint.`,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Integration checkpoints — dedicated gated + adversarial-verification agents.
//   keyed by the phase id they run AFTER (design.md "Integration checkpoints").
// ─────────────────────────────────────────────────────────────────────────────
const CHECKPOINTS = {
  p2: {
    name: 'recording-e2e',
    after: ['p2'],
    needsDocker: true,
    claim: `ADMIN-BR-3 — recording is NON-BLOCKING: a real chat turn (and a rate-limited request) writes the expected turn_record, and forcing the recorder to throw leaves the turn unaffected and undelayed.`,
    verify: `1) Run the broad gate \`${FULL_TEST}\` (Docker; apply the Docker soft-pass rule). 2) ADVERSARIALLY inspect \`web/src/app/api/chat/route.ts\` and \`web/src/agent/runtime.ts\`: PROVE recordTurn/recordAuthEvent are \`void recordX(...).catch(...)\`, NEVER awaited on the critical path, and reached via dynamic import; that finalize() only ADDS \`ctx.onTurnComplete?.(trace)\`; that exactly one turn_record is written per turn plus one rate_limited row on the pre-stream rate-limit branch (not input_too_long). 3) Confirm route.test.ts exercises the recorder-throws-does-not-fail-the-turn case. Report any path where a recorder failure could propagate, block, or delay the response.`,
  },
  p5: {
    name: 'admin-api-e2e',
    after: ['p5'],
    needsDocker: true,
    claim: `Admin API against a real seeded DB — a non-admin is blocked on EVERY route (401/403), and an admin gets correctly shaped/filtered data.`,
    verify: `1) Run \`${FULL_TEST}\` (Docker soft-pass rule). 2) ADVERSARIALLY grep every \`web/src/app/api/admin/**/route.ts\`: confirm EACH handler declares runtime="nodejs"+dynamic="force-dynamic", dynamically imports repo+guard, and calls requireAdminRequest FIRST, returning its {response} before touching a repo (no route bypasses the guard). 3) Confirm the integration test asserts 401/403/200 for every route and that response shapes match \`@/lib/admin/admin-types\`. Report any unguarded route, cross-account leak to a non-admin, or shape drift.`,
  },
  p9: {
    name: 'panel-e2e',
    after: ['p9'],
    needsDocker: false,
    claim: `An allowlisted admin signs in and a freshly-made chat turn surfaces in Overview + the Usage drill-down; a non-admin is fully blocked; the panel is read-only and the privacy disclosure is present.`,
    verify: `1) Run \`${FULL_TEST}\` (Docker soft-pass rule) AND best-effort \`${NEXT_BUILD}\` — if the build fails ONLY because env (e.g. XAI_API_KEY) is unset here, note it as a DEFERRED human check and do NOT fail the checkpoint on that alone. 2) ADVERSARIALLY trace the data path end to end: turn_record (p1) -> admin-analytics-repo.getUsageSeries (p4) -> GET /api/admin/overview (p5) -> Overview page (p7) and usage/[id] drill-down -> getTurn -> TurnDetail. Confirm BOTH gates exist (layout server redirect + every route's requireAdminRequest), the privacy page discloses recording (AD-3/ADMIN-BR-7), and NO mutating control exists anywhere in the admin UI (ADMIN-BR-2). 3) State clearly that the LIVE sign-in + live-turn confirmation is a human follow-up (needs a running server + live model). Report gaps as findings.`,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function byId(id) {
  return PHASES.find((p) => p.id === id)
}

// Deterministic Kahn topological sort; ties broken by PHASES array order.
function topoOrder(phases) {
  const ids = phases.map((p) => p.id)
  const indeg = {}
  const adj = {}
  for (const p of phases) {
    indeg[p.id] = 0
    adj[p.id] = []
  }
  for (const p of phases) {
    for (const d of p.depends_on || []) {
      adj[d].push(p.id)
      indeg[p.id]++
    }
  }
  const order = []
  let queue = phases.filter((p) => indeg[p.id] === 0).map((p) => p.id)
  queue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const n of adj[id]) {
      indeg[n]--
      if (indeg[n] === 0) queue.push(n)
    }
    queue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
  }
  return order
}

function gateOf(ph) {
  return `${STATIC} && ${ph.gateTest}`
}

function header(ph) {
  return `${COMMON}

=== PHASE ${ph.id.toUpperCase()} — ${ph.name} ===
Read these design.md sections first: ${(ph.docs || []).join(', ')}
Manifest test_focus: ${ph.test_focus}
OWNS (new files you create): ${ph.owns.length ? ph.owns.join(', ') : '(none — this phase only edits shared files)'}
SHARED (pre-existing files — edit SURGICALLY/ADDITIVELY): ${ph.shared.length ? ph.shared.join(', ') : '(none)'}
${ph.uiTestNote ? `UI TEST-PLACEMENT RULE: the jsdom Vitest project only scans \`src/components/**/*.test.tsx\` and \`test/**/*.test.tsx\` — NOT \`src/app/**\`. Put EVERY test for this phase under \`web/src/components/admin/\` (extract each screen's render logic into a tested component there; keep app/admin pages thin). Tests render fixtures only and never import db/repos.` : ''}`
}

function verifyPrompt(ph) {
  const needsDocker = ph.project === 'node'
  return `You are the BUILD VERIFIER for phase ${ph.id.toUpperCase()} (${ph.name}).
Run EXACTLY this command (it can take minutes — call Bash with timeout 600000):

    ${gateOf(ph)} ; echo "OAK_EXIT=$?"

Capture combined stdout+stderr. ${needsDocker ? DOCKER_CLAUSE : 'This is the jsdom project — NO Docker is needed.'}
Determine pass/fail from the OAK_EXIT line (0 = pass). If it FAILED, extract the most relevant errors — lines with "error TS", "error:", "FAIL", "✖", "failed", "Expected", "Received", "Cannot find", "is not assignable", "Type error", "ESLint" plus a little surrounding context — and return up to ~120 lines as errorTail (trim noise; keep the actionable errors). If it PASSED, errorTail is "".
Do NOT modify any files. Do NOT try to fix anything. Return {passed, errorTail, summary}.`
}

function canRepair(tries) {
  if (tries >= MAX_REPAIR) return false
  if (budget.total && budget.remaining() < REPAIR_FLOOR) return false
  return true
}

async function runImplementers(ph) {
  if (ph.fanout) {
    if (ph.pre) {
      await agent(
        `${header(ph)}

YOUR FILE: ${ph.pre.files}
SPEC: ${ph.pre.detail}

Create ONLY this file. It must compile standalone and is the shared seam the fan-out depends on. Do not run the gate.`,
        { label: `${ph.id}:impl:${ph.pre.label}`, phase: ph.name, schema: IMPL_SCHEMA },
      )
    }
    const intro = `${header(ph)}`
    await parallel(
      ph.fanout.map((sub) => () =>
        agent(
          `${intro}

YOUR FILE(S): ${sub.files}
SPEC: ${sub.detail}

Create ONLY these file(s) (plus their colocated test where the spec asks). Match the conventions and the design's exact signatures/shapes. Do not touch other sub-tasks' files. Do not run the gate.`,
          { label: `${ph.id}:impl:${sub.label}`, phase: ph.name, schema: IMPL_SCHEMA },
        ),
      ),
    )
    if (ph.post) {
      await agent(`${header(ph)}

${ph.post}`, { label: `${ph.id}:impl:integrate`, phase: ph.name, schema: IMPL_SCHEMA })
    }
  } else {
    await agent(`${header(ph)}

${ph.task}`, { label: `${ph.id}:impl`, phase: ph.name, schema: IMPL_SCHEMA })
  }
}

async function buildPhase(ph) {
  log(`▶ ${ph.name} — implementing`)
  await runImplementers(ph)

  let verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify`, phase: ph.name, schema: VERIFY_SCHEMA })
  let tries = 0
  while ((!verdict || !verdict.passed) && canRepair(tries)) {
    tries++
    const errs = (verdict && verdict.errorTail) || 'gate produced no structured output (treat as failed)'
    log(`✗ ${ph.name} gate failed — repair attempt ${tries}/${MAX_REPAIR}`)
    await agent(
      `${header(ph)}

The gate for this phase FAILED. Gate command:
    ${gateOf(ph)}
Error tail:
-----
${errs}
-----
FIX this phase's files in place (Read then Edit/Write) so the gate passes, WITHOUT breaking other files or existing behavior. Common Oak fixes:
- TS: add/repair types & exports; import types from \`@/lib/admin/admin-types\`; never \`any\`-cast around a real shape mismatch.
- Drizzle/DB: \`.mapWith(Number)\` on count/computed columns; \`ilike\` (not \`like\`); bigint{mode:"number"} epoch ms; repos \`import "server-only"\` and read the \`@/data/db\` singleton; oracle tests use \`vi.mock("server-only")\` + createPgSchema + installAsSingleton.
- If you changed \`schema.ts\`, RE-RUN \`${NVM} cd ${WEB} && npm run db:generate\` so the migration in \`web/drizzle/\` matches (the test harness applies it per schema).
- ESLint: fix imports/ordering/unused per the repo config.
- jsdom component tests: must NOT import db/repos/runtime; render fixtures only; tests under \`src/components/admin/\`.
- Routes: runtime="nodejs"+dynamic="force-dynamic"; dynamic-import repo+guard; requireAdminRequest first; \`jsonError\`/\`json\` from \`@/app/api/auth/_lib/http\`; lenient param parsing (never 500).
Do NOT run the gate command yourself (you MAY run \`npm run typecheck\` to self-check, and \`db:generate\` if you touched the schema). Return {filesWritten (the ones you changed), notes}.`,
      { label: `${ph.id}:repair:${tries}`, phase: ph.name, schema: IMPL_SCHEMA },
    )
    verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify:${tries}`, phase: ph.name, schema: VERIFY_SCHEMA })
  }

  const passedAfterGate = !!(verdict && verdict.passed)

  // Optional adversarial security/correctness review (one repair pass on blocking issues).
  let review = null
  if (ph.securityReview && passedAfterGate) {
    log(`🔒 ${ph.name} — security review`)
    review = await agent(
      `${header(ph)}

SECURITY / CORRECTNESS REVIEW. Inspect the changed files (\`cd ${ROOT} && git diff --stat\` then read them). Focus: ${ph.securityReview}
Report ONLY real, exploitable or correctness-affecting issues (no style nits). Return {issues, summary}.`,
      { label: `${ph.id}:secreview`, phase: ph.name, schema: REVIEW_SCHEMA, effort: 'high' },
    )
    const blocking = review && review.issues ? review.issues.filter((i) => i.severity === 'critical' || i.severity === 'high') : []
    if (blocking.length) {
      log(`🔒 ${ph.name} — ${blocking.length} blocking issue(s); applying fix`)
      await agent(
        `${header(ph)}

A review of this phase found issues that must be fixed:
${blocking.map((i) => `- [${i.severity}] ${i.file}: ${i.detail}`).join('\n')}
Fix them in place without breaking the gate or existing behavior. Return {filesWritten, notes}.`,
        { label: `${ph.id}:secfix`, phase: ph.name, schema: IMPL_SCHEMA },
      )
      verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify:sec`, phase: ph.name, schema: VERIFY_SCHEMA })
    }
  }

  const finalPassed = !!(verdict && verdict.passed)
  log(`${finalPassed ? '✓' : '⚠'} ${ph.name} — ${finalPassed ? 'gate green' : `gate NOT green after ${tries} repair attempt(s)`}`)
  return {
    id: ph.id,
    name: ph.name,
    passed: finalPassed,
    repairs: tries,
    summary: (verdict && verdict.summary) || '',
    reviewIssues: review && review.issues ? review.issues.length : 0,
  }
}

async function runCheckpoint(cp) {
  log(`◆ checkpoint ${cp.name} — gate + adversarial verification`)
  const verdict = await agent(
    `${COMMON}

=== INTEGRATION CHECKPOINT: ${cp.name} ===
This runs AFTER phase(s) ${cp.after.join(', ')}. It is BOTH a broad gate AND an adversarial proof of one claim. Do NOT modify files.

CLAIM TO VERIFY: ${cp.claim}

STEPS:
${cp.verify}

When running a command, use Bash with timeout 600000 and append \`; echo "OAK_EXIT=$?"\`. ${cp.needsDocker ? DOCKER_CLAUSE : ''}
Return {gatePassed, claimVerified, findings, errorTail, summary}.`,
    { label: `checkpoint:${cp.name}`, phase: `checkpoint:${cp.name}`, schema: CHECKPOINT_SCHEMA, effort: 'high' },
  )
  const ok = !!(verdict && verdict.gatePassed && verdict.claimVerified)
  log(`${ok ? '✓' : '⚠'} checkpoint ${cp.name} — ${ok ? 'verified' : 'NOT fully verified (see findings)'}`)
  return {
    name: cp.name,
    after: cp.after,
    gatePassed: !!(verdict && verdict.gatePassed),
    claimVerified: !!(verdict && verdict.claimVerified),
    findings: (verdict && verdict.findings) || [],
    summary: (verdict && verdict.summary) || '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive the DAG — single shared web/ tree → STRICTLY SEQUENTIAL topo order.
//   Concurrent phases would race the whole-tree tsc/eslint gate and the single
//   Testcontainers Postgres. Intra-phase fan-out (disjoint NEW files, gate run
//   only after the join) is where parallelism lives. No per-agent worktree
//   isolation: dependent phases (p2 needs p1, p5 needs p3+p4, ...) require the
//   SAME cumulative working tree.
// ─────────────────────────────────────────────────────────────────────────────
const ORDER = topoOrder(PHASES)
const phasesArg = ARGS.phases
const want = !phasesArg || phasesArg === 'all' ? null : Array.isArray(phasesArg) ? phasesArg : [phasesArg]
const selected = (id) => !want || want.includes(id)
const runIds = ORDER.filter(selected)

log(`Building Oak admin panel — ${want ? `subset: ${want.join(', ')}` : 'full DAG p1–p9'} · root ${ROOT}`)
log(`Topological order (computed from depends_on): ${ORDER.join(' → ')}`)
if (want) log(`Subset build: unselected dependencies are assumed already present on disk from a prior run.`)

const results = []
const checkpointResults = []
const done = new Set()

for (const id of runIds) {
  const ph = byId(id)
  phase(`${ph.id.toUpperCase()} ${ph.name}`)

  const redDeps = (ph.depends_on || []).filter((d) => selected(d) && results.some((r) => r.id === d && !r.passed))
  if (redDeps.length) log(`⚠ ${ph.name} depends on ${redDeps.join(', ')} which did NOT go green this run — follow-on errors are possible.`)

  const r = await buildPhase(ph)
  results.push(r)
  done.add(id)
  if (!r.passed) log(`⚠ ${ph.name} did not reach a green gate; continuing (red gates are reported at the end).`)

  const cp = CHECKPOINTS[id]
  if (cp && cp.after.every((a) => done.has(a))) {
    const cpr = await runCheckpoint(cp)
    checkpointResults.push(cpr)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize — contract guard + summary + deferred follow-ups
// ─────────────────────────────────────────────────────────────────────────────
phase('Finalize')

let guard = null
if (!want) {
  guard = await agent(
    `${COMMON}

=== CONTRACT GUARD ===
The agent prompt-cache prefix + tool names are a FROZEN contract. Verify the build did NOT modify any of:
  web/src/agent/tools/  ·  web/src/agent/prompts/  ·  web/src/agent/schemas.ts
Run: \`cd ${ROOT} && git diff --name-only HEAD ; echo "OAK_EXIT=$?"\` (timeout 120000). The only permitted edits under web/src/agent/ are \`types.ts\` (one optional AgentContext field) and \`runtime.ts\` (one finalize() line). If any tools/prompts/schemas.ts file appears, that's a violation. Do NOT modify anything. Return {contractTouched, touchedFiles (the agent-contract files that were wrongly touched, if any), summary}.`,
    { label: 'finalize:contract-guard', phase: 'Finalize', schema: GUARD_SCHEMA },
  )
  if (guard && guard.contractTouched) log(`⛔ CONTRACT VIOLATION — agent contract files were modified: ${(guard.touchedFiles || []).join(', ')}`)
  else log(`✓ contract guard clean — no agent tools/prompts/schemas touched`)
}

const green = results.filter((r) => r && r.passed).map((r) => r.id)
const red = results.filter((r) => r && !r.passed).map((r) => r.id)
log(`Gates green: ${green.join(', ') || 'none'}`)
if (red.length) log(`Gates NOT green: ${red.join(', ')}`)
for (const c of checkpointResults) log(`Checkpoint ${c.name}: gate=${c.gatePassed ? 'pass' : 'fail'} claim=${c.claimVerified ? 'verified' : 'NOT verified'}${c.findings.length ? ` (${c.findings.length} finding(s))` : ''}`)

const deferred = [
  'Apply migrations to dev/prod: `cd web && npm run db:migrate` (tests do NOT need this — the Testcontainers harness applies web/drizzle/ per schema; the Fly deploy release command runs migrate.mjs on deploy).',
  'Set the allowlist secret: `fly secrets set ADMIN_EMAILS=you@example.com` (UNSET => zero admins => dark panel, the safe default).',
  'LIVE panel-e2e (ADMIN-AC-1.2 + "a freshly-made turn appears"): sign in as an allowlisted admin against a running server with a live model and confirm a real turn surfaces in Overview + the Usage drill-down — not runnable in the build sandbox.',
  'If `next build` was skipped/soft-failed due to a missing XAI_API_KEY in this environment, run `cd web && npm run build` where env is configured.',
  'Review the worktree diff and MERGE the admin-panel branch back, then `git worktree remove`.',
]
log(`DEFERRED human follow-ups: ${deferred.length} item(s) — see the return object.`)

return {
  root: ROOT,
  selected: want || 'all',
  order: ORDER,
  ran: runIds,
  results,
  greenGates: green,
  redGates: red,
  checkpoints: checkpointResults,
  contractGuard: guard,
  deferred,
  parity:
    'The autonomously-buildable admin-panel surface was built and gated: append-only turn_record/auth_event storage + non-blocking recording (ADMIN-BR-3), ADMIN_EMAILS two-layer gating (AD-5), cross-account read repos, the /api/admin/* read API, and the read-only /admin UI (observability + accounts/conversations/teams) with the privacy disclosure (AD-3/ADMIN-BR-7). Live admin sign-in + live-turn confirmation is a human follow-up.',
}
