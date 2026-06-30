export const meta = {
  name: 'build-ios-app',
  description:
    'Build the native Oak iPhone app (Swift 6 / SwiftUI) per docs/features/iphone-app — phase by phase down the Build Manifest DAG, each phase gated by a real xcodebuild/npm compile-or-test command with a bounded repair loop, plus the two additive web/ backend changes (account deletion + Bearer auth). Xcode project generated with xcodegen; simulator iPhone 17.',
  whenToUse:
    'Run to (re)build the Oak iOS client. Default (no args) builds the whole DAG; pass a phase id ("p3") or a list (["p3","p4"]) to build a subset; resume a paused run with resumeFromRunId.',
  phases: [
    { title: 'P1 Scaffold', detail: 'xcodegen project + app shell + theme + CI' },
    { title: 'P2 Backend', detail: 'web/: DELETE /api/auth/account + Bearer auth' },
    { title: 'P3 Wire DTOs', detail: 'Models/Wire/** (fan out) + decode fixtures' },
    { title: 'P4 Networking', detail: 'OakAPIClient/SSE/TokenStore/OakError' },
    { title: 'P5 Auth', detail: 'AuthService + Auth feature + AppState' },
    { title: 'P6 Chat', detail: 'ChatService + streaming reducer + thread' },
    { title: 'P7 AnswerCard', detail: 'field-by-field render tree (wide fan out)' },
    { title: 'P8 Images', detail: 'ImageEncoder + camera/library pickers' },
    { title: 'P9 History', detail: 'HistoryService + browse/resume/import' },
    { title: 'P10 Teams', detail: 'TeamService + editor + apply/active-team' },
    { title: 'P11 Artifact', detail: 'bottom-sheet artifact viewer + back stack' },
    { title: 'P12 Account & Polish', detail: 'deletion + a11y + offline + assets' },
    { title: 'P13 Integration & E2E', detail: 'XCUITest critical path (code only)' },
    { title: 'Finalize', detail: 'parity checklist + deferred human follow-ups' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = '/Users/gowtam/Documents/Projects/Oak'
const IOS = `${ROOT}/ios`
const WEB = `${ROOT}/web`
const SIM = 'iPhone 17' // installed sim family; manifest's "iPhone 16" is not installed
const MAX_REPAIR = 3
const REPAIR_FLOOR = 40_000 // stop repairing if budget target is set and < this remains

// iOS gate commands: xcodegen first (glob-resolved → new files enter the project), no signing on sim.
const iosBuild = `cd ${IOS} && xcodegen generate >/dev/null && set -o pipefail && xcodebuild build -scheme OakApp -destination 'platform=iOS Simulator,name=${SIM}' CODE_SIGNING_ALLOWED=NO -quiet`
const iosTest = `cd ${IOS} && xcodegen generate >/dev/null && set -o pipefail && xcodebuild test -scheme OakApp -only-testing:OakAppTests -destination 'platform=iOS Simulator,name=${SIM}' CODE_SIGNING_ALLOWED=NO`
const iosUITestBuild = `cd ${IOS} && xcodegen generate >/dev/null && set -o pipefail && xcodebuild build-for-testing -scheme OakApp -destination 'platform=iOS Simulator,name=${SIM}' CODE_SIGNING_ALLOWED=NO -quiet`
const webGate = `cd ${WEB} && npm run typecheck && npm run lint`

// Authoritative contracts the Swift DTOs mirror (TS source wins — fidelity rule).
const CONTRACTS = {
  sse: 'web/src/lib/sse/sse-types.ts',
  oak: 'web/src/agent/schemas.ts',
  team: 'web/src/data/teams/team-schema.ts',
  formats: 'web/src/data/formats.ts',
  entity: 'web/src/lib/entity-artifact.ts',
}

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
    errorTail: { type: 'string', description: 'Up to ~120 lines of the most relevant compiler/test error output; empty if passed.' },
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared prompt preamble
// ─────────────────────────────────────────────────────────────────────────────
const COMMON = `You are an autonomous builder for the **Oak iPhone app** — a native Swift 6 / SwiftUI client to Oak's existing Next.js backend. The app holds no LLM keys and no DB; it only talks to the HTTP/SSE API.

REPO ROOT: ${ROOT}
- iOS client lives under \`ios/\` (Xcode project generated by **xcodegen** from \`ios/project.yml\`).
- Backend (read-only for iOS phases) under \`web/\`.

DESIGN DOCS (read what your phase lists — they are the source of truth):
- ${ROOT}/docs/features/iphone-app/architecture/{overview,component-design,data-model,api-design,conventions,decisions,testing-strategy,deployment,implementation-plan}.md
- ${ROOT}/docs/features/iphone-app/requirements/*.md
The exact target file structure is in component-design.md ("File Structure"); the exact Swift interfaces/seams are in its "Interface Definitions"; conventions.md is binding.

NON-NEGOTIABLE CONVENTIONS (conventions.md / the ADRs):
- Swift 6, strict concurrency (data races are errors). Cross-actor types are \`Sendable\`. View models are \`@MainActor @Observable\`; shared mutable infra (\`OakAPIClient\`, \`TokenStore\`) are \`actor\`s.
- MVVM + Observation. ViewModels depend on **service protocols** (never \`Live…\` concretes) so they're testable with \`Fake…\`. Layering is strictly downward: Features → Services → Networking(+Models/Wire) → Apple frameworks. Views never touch OakAPIClient directly.
- **No third-party Swift packages** (Apple frameworks only). (xcodegen is a build tool, not an app dependency.)
- Naming: files PascalCase matching the primary type, one primary type per file. Protocol = role name; concrete = \`Live…\`; test double = \`Fake…\`.
- Wire is snake_case, Swift is camelCase, mapped with **explicit per-type CodingKeys** (do NOT set a global .convertFromSnakeCase — payloads mix conventions, e.g. dex_number vs mimeType).
- Errors: \`async throws\` + the single typed \`OakError\`. **In-domain failures are values, not errors** — a non-\`answered\` OakAnswer, entity not_found/unavailable, and team validation warnings are normal results rendered in the UI, never thrown. (ArtifactService returns nil instead of throwing.)
- Respect light/dark + Dynamic Type; color is never the sole carrier of meaning (pair with text/icon).
- Never log the token, OTP, email, message content, or image bytes.

CONTRACT FIDELITY (critical): the Swift DTOs must mirror the TypeScript/Zod source EXACTLY. When the iPhone docs and the TS source disagree, **the TS source wins**. Authoritative files:
  ${CONTRACTS.sse}, ${CONTRACTS.oak}, ${CONTRACTS.team}, ${CONTRACTS.formats}, ${CONTRACTS.entity}
TWO KNOWN RECONCILIATIONS you must honor:
  1) \`active_team_id\` is NOT in the chat request body (sse-types.ts has only session_id, message, images?, champions_mode?). Do NOT put activeTeamId on ChatRequest. Active team is applied server-side, set via PATCH /api/conversations/{id} (HistoryService.setActiveTeam). Ignore the activeTeamId-on-ChatRequest shown in data-model.md/component-design.md.
  2) No recorded /api/chat fixtures exist; fixtures are schema-derived (see the P3 task), not live-captured.

IMPORTANT EXECUTION RULES:
- Create files at the EXACT paths in component-design.md's File Structure (under \`ios/OakApp/…\`, tests under \`ios/OakAppTests/…\`, UI tests under \`ios/OakAppUITests/…\`).
- Do NOT run \`xcodebuild\` or \`xcodegen\` yourself — a separate verifier owns the build gate. (You MAY read files and use git to inspect prior phases' output.)
- Only create/edit files inside your phase's ownership; edit \`shared\` files surgically (additively) without breaking other phases' use of them.
- Match the surrounding code's idioms. Keep one primary type per file.`

// ─────────────────────────────────────────────────────────────────────────────
// PHASES — transcribed from architecture/implementation-plan.md "Build Manifest".
//   gate: shell command the verifier runs (exit code = pass/fail).
//   fanout: array of independent sub-tasks built in parallel (disjoint files).
//   post: a single integrator task run after the fanout (sees all fanned-out files).
//   securityReview: concerns string → adversarial reviewer + one repair pass.
// ─────────────────────────────────────────────────────────────────────────────
const PHASES = [
  {
    id: 'p1',
    title: 'P1 Scaffold',
    codebase: 'ios',
    gate: iosBuild,
    docs: ['overview.md', 'component-design.md', 'conventions.md', 'deployment.md', 'implementation-plan.md (P1)'],
    reqRefs: ['M-CON-1', 'M-CON-2', 'M-NFR-5', 'M-UI-US-1'],
    task: `PHASE P1 — iOS SCAFFOLDING. Produce a launchable empty app + the scaffolding every later phase builds on.
Create:
- \`ios/project.yml\` for **xcodegen** defining THREE targets — \`OakApp\` (iOS app), \`OakAppTests\` (unit, **Swift Testing**), \`OakAppUITests\` (XCUITest). Settings: Swift 6 with SWIFT_VERSION 6.0 and SWIFT_STRICT_CONCURRENCY=complete; IPHONEOS_DEPLOYMENT_TARGET 18.0; PRODUCT_BUNDLE_IDENTIFIER us.optiwise.oak (tests us.optiwise.oak.*); GENERATE_INFOPLIST_FILE where possible OR reference ios/OakApp/Resources/Info.plist; ENABLE_USER_SCRIPT_SANDBOXING NO if needed; iPhone-only (TARGETED_DEVICE_FAMILY 1). Use **source globs** (e.g. path: OakApp, path: OakAppTests) so files added by later phases are picked up on regeneration. Define an explicit **shared scheme named \`OakApp\`** whose Test action runs BOTH \`OakAppTests\` and \`OakAppUITests\` (so \`xcodebuild -scheme OakApp\` resolves, and \`-only-testing:OakAppTests\` selects just the unit suite). Debug→staging, Release→prod via BaseURL.swift (config-conditional compilation or build settings).
- \`ios/OakApp/App/OakApp.swift\` (@main App; injects AppState + service environment; root scene = RootView).
- \`ios/OakApp/App/AppState.swift\` (@MainActor @Observable: auth state guest/signedIn(email), active conversation id, in-memory guest thread, champions-mode default) — a real stub others extend.
- \`ios/OakApp/App/RootView.swift\` (TabView shell: Chat / History / Teams / Account — placeholder screens).
- \`ios/OakApp/App/Environment+Services.swift\` (@Environment keys for service injection so previews/tests substitute Fake…). It can reference forward-declared service protocols via a thin placeholder until P4/P5; keep it compiling.
- \`ios/OakApp/UI/Theme.swift\` (Oak brand colors/type over iOS; light+dark; Dynamic Type friendly).
- \`ios/OakApp/Support/Logging.swift\` (OSLog Logger; subsystem us.optiwise.oak; categories network/auth/chat/ui).
- \`ios/OakApp/Networking/BaseURL.swift\` (per-scheme base URL; pick reasonable staging/prod placeholders — note them).
- \`ios/OakApp/Resources/Info.plist\` (NSCameraUsageDescription, NSPhotoLibraryUsageDescription, ATS defaults) and \`ios/OakApp/Resources/Assets.xcassets\` (AppIcon placeholder + AccentColor).
- \`ios/OakAppTests/SmokeTests.swift\` (one trivial Swift Testing @Test that passes).
- \`ios/OakAppUITests/LaunchUITests.swift\` (a minimal XCUITest that launches the app — keep it building; deeper flow is P13).
- \`ios/ci/ios.yml\` (GitHub Actions: macOS runner, xcodegen generate + xcodebuild test on the simulator for ios/** PRs).
- \`ios/.gitignore\` for Xcode/DerivedData/build, and the generated *.xcodeproj if you prefer (your call; document it).
Success: the project generates, builds Debug, and launches to a 4-tab shell. Keep EVERYTHING compiling — stubs are fine, but no build errors.`,
  },
  {
    id: 'p2',
    title: 'P2 Backend',
    codebase: 'web',
    gate: webGate,
    verifyNotes: `This is the web/ backend phase. ALWAYS run: ${webGate}. THEN ADDITIONALLY attempt the auth Vitest subset: \`cd ${WEB} && npx vitest run src/server/auth src/data/repos/accounts-repo.test.ts src/app/api/auth\`. Vitest needs a Docker daemon (Testcontainers Postgres) — if it fails ONLY because Docker/Testcontainers is unavailable (connection refused / cannot find docker), treat the phase as PASSED on typecheck+lint and say so in the summary (do not fail the phase for missing Docker). If Vitest runs and a real test fails, that's a FAIL with the error tail.`,
    docs: ['api-design.md', 'data-model.md (§C)', 'decisions.md (ADR-2)', 'conventions.md (Backend changes)', 'implementation-plan.md (P2)'],
    reqRefs: ['M-NFR-6', 'M-ACCT-US-6', 'M-BR-ACCT-5', 'M-BR-ACCT-6', 'M-ACCT-US-2', 'M-BR-PLAT-3'],
    securityReview: `Auth path + deletion correctness. Confirm: (1) the cookie path is tried FIRST and is byte-for-byte unchanged (web behavior identical); Bearer is a pure fallback resolved through the SAME hashToken+resolveSessionToken (no second code path, no weaker hashing). (2) deleteAccount is scoped to the authenticated account.id ONLY — no way to delete another account's rows; runs in one transaction; FK-safe order; idempotent. (3) verify still sets the cookie and only ADDS token to the body. (4) no token/secret logging.`,
    task: `PHASE P2 — BACKEND ADDITIVE CHANGES (web/, TypeScript). Follow the repo's existing patterns (web/CLAUDE.md): Result/structured shapes in data/tool layer; try/catch→error mapping at the HTTP edge; Zod as the single source of truth; never rename existing contracts. The two changes MUST NOT alter existing web behavior.

CHANGE 1 — Bearer-token auth adaptation (additive):
- \`web/src/app/api/auth/verify/route.ts\`: add \`token\` (the already-generated raw 256-bit hex session token) to the 200 JSON body. Keep setting the oak_session cookie. (Consider adding expiresAt too if trivially available.)
- \`web/src/server/auth/current-user.ts\`: \`getCurrentAccount()\` is the SINGLE resolver. Extend it: if there is NO valid oak_session cookie, read \`Authorization: Bearer <token>\` via \`headers()\` (next/headers) and resolve it through the EXISTING \`resolveSessionToken()\` (same SHA-256 \`hashToken\`). **Cookie path stays first and unchanged.** Do not duplicate hashing/lookup logic — reuse sessions.ts helpers.

CHANGE 2 — Account deletion (new endpoint + cascade):
- \`web/src/data/repos/accounts-repo.ts\`: add \`deleteAccount(accountId: string): Promise<void>\`. FKs are LOGICAL (no physical ON DELETE CASCADE), so delete explicitly inside ONE \`db.transaction()\` in FK-safe order: \`conversation_message\` → \`conversation\` → \`team\` → \`auth_session\` (all WHERE account_id = accountId) → \`otp_code\` (by the account's email) → \`account\` (WHERE id = accountId). Idempotent. Match existing repo delete patterns (e.g. team-repo deleteTeam, conversation-repo deleteConversation).
- \`web/src/app/api/auth/account/route.ts\`: new DELETE handler. Require auth (use getCurrentAccount; guest → 401). Call deleteAccount(account.id), then clear the cookie the same way signout does (\`clearSessionCookie()\`). Return \`{ ok: true }\` (200).

TESTS:
- Keep green: web/src/server/auth/sessions.test.ts, auth-service.test.ts, web/src/app/api/auth/verify/route.test.ts (update its body assertion to allow the new \`token\` field), auth-routes.integration.test.ts, web/src/data/repos/accounts-repo.test.ts.
- ADD tests: Bearer resolves identity identically to the cookie (and cookie-present still wins); deleteAccount removes ALL account-scoped rows in one txn, is FK-safe, idempotent, and never deletes another account's rows; DELETE /api/auth/account returns 401 for guests and clears the cookie when authed.
Verify locally with: ${webGate} (typecheck+lint). Vitest needs Docker; the verifier handles that.`,
  },
  {
    id: 'p3',
    title: 'P3 Wire DTOs',
    codebase: 'ios',
    deps: ['p1'],
    gate: iosTest,
    docs: ['data-model.md', 'component-design.md (Interface Definitions)', 'api-design.md', 'testing-strategy.md', 'conventions.md'],
    reqRefs: ['M-AC-1.2', 'M-AC-1.4', 'M-SUCCESS-3', 'M-BR-CHAT-5'],
    fanoutIntro: `PHASE P3 — WIRE DTOs. Create the Codable/Sendable value-type mirrors under \`ios/OakApp/Models/Wire/\`. Each type maps snake_case→camelCase with EXPLICIT CodingKeys. They all share one module (no imports between them) — use the EXACT type names below so the files compose. Mirror the TS source (cited) precisely; if data-model.md disagrees with the TS source, the TS source wins. Honor the two reconciliations (no activeTeamId on ChatRequest).`,
    fanout: [
      { label: 'JSONScalar', files: 'Models/Wire/JSONScalar.swift', detail: `\`JSONScalar\` — a Codable enum wrapping string | number(Double or Int) | bool | null for free-form maps (key_stats, assumptions, result). MUST round-trip unknown scalar shapes without loss (decode+encode). Add an Equatable conformance.` },
      { label: 'Team', files: 'Models/Wire/Team.swift', detail: `Mirror ${CONTRACTS.team} + ${CONTRACTS.formats}: \`enum Format: String, Codable, Sendable, CaseIterable { case scarletViolet = "scarlet-violet", champions }\`; \`TeamMember\` (species/ability/item: String?; moves: [String] (≤4); nature: String?; evs/ivs: StatSpread; teraType: String? (tera_type); level: Int; nickname: String?; gender: Gender? (M/F/N); shiny: Bool?); \`StatSpread\` (hp,atk,def,spa,spd,spe: Int); \`TeamWarning\` with \`Code\` enum (incomplete, ev_total_exceeded, ev_stat_exceeded, iv_out_of_range, species_illegal, ability_not_for_species, item_illegal, move_not_in_learnset, duplicate_species, duplicate_item) + message + slot:Int? + field:String?; \`TeamValidationResult { warnings: [TeamWarning] }\` (mirror the server shape exactly — read the TS).` },
      { label: 'OakAnswer', files: 'Models/Wire/OakAnswer.swift', detail: `Mirror oakAnswerSchema in ${CONTRACTS.oak}. \`OakAnswer\` + Status (answered, clarification_needed, resolution_failed, insufficient_data) + answer_markdown, reasoning_markdown, citations:[Citation], inferences:[Inference], generation_basis:GenerationBasis, and optionals subjects:[Subject]?, candidates:Candidates?, damage_calc:DamageCalc?, suggestions:[String]?, question:ClarifyQuestion?, uncertainty_flags:[String]?, proposed_team:ProposedTeam?, saved_team:SavedTeamRef?, proposed_team_warnings:[TeamWarning]?. Define the sub-structs: Citation(source, detail, endpoint_url?), Inference(claim, confidence high/medium/low, note?), GenerationBasis(generation, fallback, note?), Subject(name, dex_number?, sprite_url, types:[String], is_fallback, source_generation?), Candidates(total_count, truncated, sort?, shown:[CandidateRow]), CandidateRow(name, dex_number?, sprite_url?, types:[String], base_stats:BaseStats?, key_stats:[String:JSONScalar]?, ability?), BaseStats(hp,atk,def,spa,spd,spe), DamageCalc(assumptions:[String:JSONScalar], result:[String:JSONScalar], is_estimate, breakdown?), ClarifyQuestion(options:[ClarifyOption]), ClarifyOption(label, description?), ProposedTeam(name, format:Format, members:[TeamMember]), SavedTeamRef(id, name, format:Format). References Format/TeamMember/TeamWarning (Team.swift) and JSONScalar (JSONScalar.swift) — do not redefine them. Codable+Sendable+Equatable.` },
      { label: 'ChatWire', files: 'Models/Wire/ChatWire.swift', detail: `Mirror ${CONTRACTS.sse}. \`ChatRequest: Encodable, Sendable\` with ONLY: sessionId(session_id), message, images:[ChatImage]?, championsMode:Bool?(champions_mode). DO NOT include activeTeamId. \`ChatImage: Encodable, Sendable\` { mimeType, data (RAW base64, no data: prefix) }. \`enum SSEEvent: Sendable\` decoded from event:/data: frames: toolActivity(tool,label) "tool_activity", answerStart "answer_start", answerDelta(text) "answer_delta", answer(OakAnswer) "answer", error(code,message,status:Int?) "error". (Decoding of the event name happens in the SSEParser in P4; here just model the event + a way to decode each frame's data payload.)` },
      { label: 'Conversation', files: 'Models/Wire/Conversation.swift', detail: `\`ConversationSummary: Decodable, Sendable, Identifiable\` (id, title, format:Format, pinned, createdAt:Int64(created_at), updatedAt:Int64(updated_at)); \`ConversationDetail: Decodable, Sendable\` (id, title, format, pinned, activeTeamId:String?(active_team_id), turns:[ChatTurn]); \`enum ChatTurn: Decodable, Sendable, Identifiable\` discriminated on "role": .user(id, content:String), .assistant(id, answer:OakAnswer). Also \`Team: Decodable, Sendable, Identifiable\` (id, name, format, members:[TeamMember], createdAt:Int64, updatedAt:Int64) — the full saved-team envelope (TeamMember from Team.swift). Confirm the exact JSON field names against the conversations/teams routes if unsure.` },
      { label: 'EntityArtifact', files: 'Models/Wire/EntityArtifact.swift', detail: `Mirror ${CONTRACTS.entity} EXACTLY (quote the TS). A discriminated union on status (ok/not_found/unavailable) and, for ok, on kind: pokemon/move/ability/item/type. Pokemon.data: display_name, national_dex_number, types, abilities, base_stats, base_stat_total, sprite_url, artwork_url, forms, is_gen9_native, source_generation, matchups{weak_to,resists,immune_to,quad_weak_to?,quad_resists?}, movepool:[{method, moves:[{slug,display_name,type}]}]. Move.data: display_name, type, damage_class(physical/special/status), power, accuracy, pp, priority, target, hits_allies?, spread_modifier_doubles?, effect_short, effect_full, gen9_learner_count?. Ability.data: display_name, effect_short, effect_full, learned_by:[{slug,display_name}]. Item.data: display_name, effect_short, effect_full, held_by_wild?:[{pokemon,rarity_percent}]. Type.data: types, offensive?{super_effective_against,not_very_effective_against,no_effect_against}, defensive{weak_to,resists,immune_to,quad_weak_to?,quad_resists?}. NotFound: {kind, format, query, suggestions:[String]}. Unavailable: {kind, format}. Model nullable/optional faithfully; use EntityKind enum (pokemon/move/ability/item/type).` },
      { label: 'AuthDTOs', files: 'Models/Wire/AuthDTOs.swift', detail: `\`AuthVerifyResponse: Decodable\` (ok:Bool, email:String, created:Bool, token:String — the NEW field from P2); \`MeResponse: Decodable\` (signedIn:Bool(signed_in? confirm), email:String?); \`APIErrorBody: Decodable, Sendable\` (code, message, status:Int?). Confirm field names against api-design.md (/api/auth/me returns {signedIn,email} per the doc).` },
    ],
    post: `P3 INTEGRATION — fixtures + the decode contract-test suite (run AFTER the DTO files exist; read them).
1. \`ios/OakAppTests/Fixtures/\`: commit representative wire JSON + SSE fixtures. Because no live /api/chat fixtures exist, BUILD them from the documented/Zod shapes and GUARANTEE they're contract-valid: write a throwaway check using the repo's own zod schema — e.g. \`cd ${WEB} && npx tsx -e '...'\` that imports oakAnswerSchema from src/agent/schemas.ts and \`.parse()\`s each OakAnswer JSON you authored; fix any that fail; then commit the validated JSON. Cover: an OakAnswer per status (answered with ALL optional fields populated incl. subjects+candidates+damage_calc+proposed_team; clarification_needed; resolution_failed; insufficient_data); REST envelopes (conversations_list.json, conversation_detail.json, team.json, teams_list.json, entity_pokemon.json, entity_move.json, entity_not_found.json, auth_verify.json, me.json, api_error.json); and \`.sse\` raw chat streams (chat_answered_full.sse with tool_activity*→answer_start→answer_delta*→answer; chat_single_delta_grok.sse; chat_error.sse; one with \`: keep-alive\` heartbeat comments). Name by endpoint+scenario.
2. \`ios/OakAppTests/Fixtures/Fixtures.swift\`: a \`Fixtures.load(_:)\` helper reading a named fixture from the test bundle.
3. \`ios/OakAppTests/Decoding/\`: a "decode every fixture" parameterized Swift Testing suite that decodes each JSON into its DTO with NO data loss, plus round-trip encode/decode for ChatRequest and JSONScalar (unknown scalar shapes survive). Build DTOs from fixtures, not inline literals, so a contract change fails decoding loudly.
Make sure project.yml includes the test resources (the Fixtures folder) so they're in the test bundle.`,
  },
  {
    id: 'p4',
    title: 'P4 Networking',
    codebase: 'ios',
    deps: ['p3'],
    gate: iosTest,
    docs: ['component-design.md (Interface Definitions)', 'api-design.md', 'conventions.md (Networking)', 'data-model.md (Keychain)', 'testing-strategy.md'],
    reqRefs: ['M-NFR-2', 'M-NFR-12', 'M-NFR-13', 'M-BR-CHAT-4', 'M-AC-4.4', 'M-NFR-1'],
    task: `PHASE P4 — NETWORKING CORE. Create under \`ios/OakApp/Networking/\`:
- \`OakError.swift\`: \`enum OakError: Error, Equatable\` { transport(underlying:String), http(status:Int,code:String,message:String), rateLimited(retryAfter:TimeInterval?), unauthorized, decoding(String), imageRejected(reason:ImageRejectReason) } + \`enum ImageRejectReason: Equatable { tooMany, perImageTooLarge, totalTooLarge, unsupportedType }\`; plus a mapper from (HTTPURLResponse, Data) → success or OakError per api-design.md (429+Retry-After → rateLimited; 401 on authed → unauthorized; 4xx/5xx with {code,message} → http; transport → transport).
- \`Endpoint.swift\`: request builder (path, method, query items, body Encodable?, requiresAuth flag).
- \`TokenStore.swift\`: \`actor TokenStore\` — Keychain CRUD (kSecClassGenericPassword, service us.optiwise.oak, account session-token, kSecAttrAccessibleAfterFirstUnlock). token()/set(_:)/clear().
- \`OakAPIClient.swift\`: \`actor OakAPIClient\` — owns one URLSession + baseURL + JSON encode/decode; \`send<Response: Decodable>(_:as:)\` and \`sendNoContent(_:)\`; attaches \`Authorization: Bearer\` from TokenStore when endpoint.requiresAuth and a token exists; HTTPS only; maps via OakError.
- \`SSEParser.swift\`: a PURE incremental line parser — accumulate event:/data: lines, emit one SSEEvent per blank-line-terminated frame, ignore \`:\`-comment heartbeats. Decode each frame's data JSON into the SSEEvent case (from P3). No I/O.
- \`SSEClient.swift\`: \`struct SSEClient\` — POST /api/chat via URLSession.bytes(for:); attach Bearer + base URL via OakAPIClient; return \`AsyncThrowingStream<SSEEvent, Error>\`. PRE-stream HTTP failures (rate limit, 413, 503…) throw OakError; once open, a transport drop throws mid-stream, and an SSE \`error\` event yields as .error(...) then the stream finishes.
TESTS (\`ios/OakAppTests/Networking/\`): SSEParser over the recorded .sse fixtures (multi-frame, heartbeat comments, single-delta Grok, terminal answer, terminal error) reconstructs the exact SSEEvent sequence; OakError mapping (429+Retry-After, 401, 4xx/5xx envelope, transport); TokenStore Keychain CRUD round-trips. Keep ChatService/services for P5/P6 — here just the networking layer.`,
  },
  {
    id: 'p5',
    title: 'P5 Auth',
    codebase: 'ios',
    deps: ['p4', 'p2'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/App/AppState.swift'],
    securityReview: `Token storage/handling. Confirm: token lives ONLY in Keychain (never UserDefaults/logs); cleared on signOut AND on 401/expiry; no token/OTP/email content logged; sign-out is idempotent and clears local token even if the network call fails.`,
    docs: ['component-design.md', 'api-design.md (Auth)', 'requirements/accounts-and-access.md', 'conventions.md'],
    reqRefs: ['M-ACCT-US-1', 'M-ACCT-US-2', 'M-ACCT-US-3', 'M-ACCT-US-5', 'M-BR-ACCT-1', 'M-BR-ACCT-2', 'M-BR-ACCT-5'],
    task: `PHASE P5 — AUTH & SESSION.
- \`ios/OakApp/Services/AuthService.swift\`: \`protocol AuthService: Sendable\` (requestCode(email), verify(email,code)->Account [stores token in Keychain], me()->AuthState, signOut() [clears token + calls endpoint, idempotent], deleteAccount() [DELETE /api/auth/account then clears token]) + \`LiveAuthService\` over OakAPIClient/TokenStore. \`struct Account { email; created }\`, \`enum AuthState { guest; signedIn(email) }\`.
- \`ios/OakApp/Features/Auth/AuthViewModel.swift\` (@MainActor @Observable): email→OTP entry, resend cooldown (60s), invalid/expired/too-many handling, rate-limit message, OTP autofill support; depends on the AuthService PROTOCOL.
- \`ios/OakApp/Features/Auth/AuthView.swift\`: email → 6-digit OTP UI; \`.textContentType(.oneTimeCode)\` for autofill; resend cooldown; error surfacing.
- Extend \`ios/OakApp/App/AppState.swift\` (SHARED — edit additively): auth transitions (guest↔signedIn), restore session on launch (token in Keychain → me()), 401/expiry → drop token → guest.
TESTS (\`ios/OakAppTests/Auth/\`): AuthViewModel against a \`FakeAuthService\` — happy path, invalid code, expired/too-many, resend cooldown, rate-limit message, signOut clears token, expiry→guest. (Live OTP/device autofill is a human follow-up.)`,
  },
  {
    id: 'p6',
    title: 'P6 Chat',
    codebase: 'ios',
    deps: ['p4'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/App/AppState.swift'],
    docs: ['component-design.md (streaming reducer notes)', 'requirements/chat-experience.md', 'api-design.md (Chat)', 'data-model.md', 'conventions.md'],
    reqRefs: ['M-CHAT-US-1', 'M-CHAT-US-2', 'M-CHAT-US-3', 'M-CHAT-US-4', 'M-CHAT-US-6', 'M-BR-CHAT-1', 'M-BR-CHAT-2'],
    task: `PHASE P6 — CHAT CORE + STREAMING (guest chat needs no auth).
- \`ios/OakApp/Services/ChatService.swift\`: \`protocol ChatService: Sendable\` { send(sessionId, message, images:[UIImage], championsMode:Bool, activeTeamId:String?) -> AsyncThrowingStream<SSEEvent,Error> } + \`LiveChatService\` over SSEClient. NOTE: activeTeamId is NOT sent on ChatRequest (reconciliation #1) — it is applied via the conversation (HistoryService.setActiveTeam in P9/P10). Keep the param in the signature for the composer but do not put it on the wire body here. Image encoding is P8 — for now accept [UIImage] and pass [] through (P8 wires ImageEncoder).
- \`ios/OakApp/Features/Chat/ChatViewModel.swift\` (@MainActor @Observable): the SSE REDUCER — holds visible turns, in-progress streaming state (tool-activity items + streamed text buffer), composer state (text + mode + active team). On \`answer_start\` clear the streamed-text buffer (keep tool-activity history); on \`answer_delta\` append; on terminal \`answer\` replace buffer with the authoritative OakAnswer and stop; on \`error\` → recoverable banner. Grok delivers the answer in ONE delta — don't assume many. Champions toggle flows into the request. Cancel the stream Task on new turn / view disappear. Depends on the ChatService PROTOCOL.
- \`ios/OakApp/Features/Chat/ChatView.swift\` (thread) + \`ComposerView.swift\` (text + mode toggle + active-team chip; image attach is P8) + \`StreamingStatusView.swift\` (tool-activity ticker + thinking state).
- A MINIMAL answer view here (status + answer_markdown only); the full AnswerCard tree is P7.
TESTS (\`ios/OakAppTests/Chat/\`): the reducer over the .sse fixtures (deltas append; answer_start resets; terminal answer finalizes; error→banner); champions toggle present in the request; in-domain non-answered statuses render (NOT as errors).`,
  },
  {
    id: 'p7',
    title: 'P7 AnswerCard',
    codebase: 'ios',
    deps: ['p3', 'p6'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/Features/Chat/ChatView.swift'],
    docs: ['component-design.md', 'requirements/chat-experience.md', 'requirements/ui-and-experience.md', 'design-system/design-system.md', 'conventions.md'],
    reqRefs: ['M-AC-1.2', 'M-AC-1.4', 'M-SUCCESS-3', 'M-AC-6.2', 'M-UI-US-1', 'M-UI-US-9'],
    securityReview: false,
    designReview: true,
    fanoutIntro: `PHASE P7 — ANSWERCARD field-by-field rendering. Build the full \`ios/OakApp/Features/Chat/AnswerCard/\` tree + shared UI helpers. Each subview takes its typed OakAnswer field and renders it natively; render NOTHING when the field is absent. Tables come from structured fields (not markdown). Color is never the sole flag carrier (pair text/icon). Light/dark + large Dynamic Type must not clip. All one module — use the exact view names below.`,
    fanout: [
      { label: 'MarkdownText', files: 'UI/MarkdownText.swift', detail: `\`MarkdownText\` — render prose via AttributedString(markdown:) (Apple-native; no third-party renderer). Handles answer_markdown/reasoning_markdown; degrade gracefully on parse failure (show raw).` },
      { label: 'SpriteImage', files: 'UI/SpriteImage.swift', detail: `\`SpriteImage\` — AsyncImage over a sprite URL with placeholder + failure state. May use URLSession's default cache. Accessibility label = the entity name.` },
      { label: 'TypeBadge', files: 'UI/TypeBadge.swift', detail: `\`TypeBadge\` — a Pokémon type chip (color + LABEL, never color-only). One badge per type slug; consistent palette per the 18 types.` },
      { label: 'CitationsView', files: 'Features/Chat/AnswerCard/CitationsView.swift', detail: `Render [Citation] (source, detail, endpoint_url?) — a "Sources" section; endpoint_url tappable if present.` },
      { label: 'InferencesView', files: 'Features/Chat/AnswerCard/InferencesView.swift', detail: `Render [Inference] (claim, confidence high/medium/low, note?) — confidence shown via text+icon, not color alone.` },
      { label: 'GenerationBasisView', files: 'Features/Chat/AnswerCard/GenerationBasisView.swift', detail: `Render GenerationBasis (generation, fallback, note?) — the format/generation tag; flag fallback clearly.` },
      { label: 'SubjectsView', files: 'Features/Chat/AnswerCard/SubjectsView.swift', detail: `Render [Subject] (name, dex_number?, sprite_url, types, is_fallback, source_generation?) using SpriteImage + TypeBadge; flag is_fallback.` },
      { label: 'CandidatesTableView', files: 'Features/Chat/AnswerCard/CandidatesTableView.swift', detail: `Render Candidates (total_count, truncated, sort?, shown:[CandidateRow]) as a native, legible, horizontally-scrollable table: name+sprite, types, base_stats, key_stats ([String:JSONScalar]), ability. Show truncation ("showing N of total").` },
      { label: 'DamageCalcView', files: 'Features/Chat/AnswerCard/DamageCalcView.swift', detail: `Render DamageCalc (assumptions, result [String:JSONScalar], is_estimate=true, breakdown?) — clearly mark it an estimate; show assumptions + result; optional breakdown disclosure.` },
      { label: 'ClarifyQuestionView', files: 'Features/Chat/AnswerCard/ClarifyQuestionView.swift', detail: `Render ClarifyQuestion (options:[{label, description?}]) as tappable choices that send the chosen label as the next turn (callback to ChatViewModel).` },
      { label: 'SuggestionsView', files: 'Features/Chat/AnswerCard/SuggestionsView.swift', detail: `Render [String] suggestions as tappable follow-up chips (callback to send as next message).` },
      { label: 'UncertaintyFlagsView', files: 'Features/Chat/AnswerCard/UncertaintyFlagsView.swift', detail: `Render [String] uncertainty_flags as a clearly-marked caveats section (icon+text).` },
      { label: 'TeamBlocksView', files: 'Features/Chat/AnswerCard/TeamBlocksView.swift', detail: `Render proposed_team / saved_team + proposed_team_warnings (warn-but-allow). Show member sets; show warnings (text+icon, never blocking). Include an "Apply" affordance for proposed_team (action wired in P10 — expose a closure/placeholder now).` },
    ],
    post: `P7 INTEGRATION — \`ios/OakApp/Features/Chat/AnswerCard/AnswerCardView.swift\`: orchestrate the field-by-field render in a sensible reading order (status → answer markdown → key structured blocks → reasoning → citations/inferences/generation basis → uncertainty), invoking each subview only when its field is present. Then REPLACE the minimal answer view from P6 inside ChatView (SHARED — edit surgically) so finalized answers render via AnswerCardView. TESTS (\`ios/OakAppTests/AnswerCard/\`): per-subview structure tests over fixtures with the field present AND absent (absent → renders nothing); a full OakAnswer (all fields) composes without crashing.`,
  },
  {
    id: 'p8',
    title: 'P8 Images',
    codebase: 'ios',
    deps: ['p6'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/Features/Chat/ComposerView.swift', 'ios/OakApp/Services/ChatService.swift'],
    docs: ['component-design.md', 'requirements/chat-experience.md (M-CHAT-US-5)', 'api-design.md (image caps)', 'conventions.md'],
    reqRefs: ['M-CHAT-US-5'],
    task: `PHASE P8 — IMAGE INPUT (camera + library).
- \`ios/OakApp/Services/ImageEncoder.swift\` (pure): UIImage → validated ChatImage. Enforce caps BEFORE send: ≤4 images, ≤3.75 MiB per image and ≤10 MiB total (DECODED bytes), JPEG/PNG/GIF/WebP; re-encode to JPEG/PNG as needed; output RAW base64 (NO data: prefix). On violation throw OakError.imageRejected(reason:) with the specific ImageRejectReason.
- \`ios/OakApp/Support/CameraPicker.swift\`: a UIImagePickerController wrapper (UIViewControllerRepresentable, camera source) — the one allowed UIKit use.
- Wire \`PhotosPicker\` (PhotosUI) + the camera picker + thumbnail/remove UI + permission prompts into \`ComposerView.swift\` (SHARED — additive). An image-only turn (empty text) is valid. Surface a backend image rejection with a specific message.
- Make ChatService actually encode [UIImage] via ImageEncoder now (update the P6 pass-through).
TESTS (\`ios/OakAppTests/Image/\`): ImageEncoder cap logic → typed rejection for each reason; raw base64 (no prefix); image-only turn valid. (Camera/permission flows are a human device follow-up.)`,
  },
  {
    id: 'p9',
    title: 'P9 History',
    codebase: 'ios',
    deps: ['p5', 'p6', 'p7'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/App/AppState.swift'],
    docs: ['component-design.md', 'requirements/history-and-teams.md', 'api-design.md (Conversations)', 'conventions.md'],
    reqRefs: ['M-HIST-US-1', 'M-HIST-US-2', 'M-HIST-US-3', 'M-BR-H1', 'M-BR-H2', 'M-BR-H3', 'M-BR-H4', 'M-ACCT-US-4', 'M-UI-US-4'],
    task: `PHASE P9 — CHAT HISTORY (signed-in).
- \`ios/OakApp/Services/HistoryService.swift\`: \`protocol HistoryService: Sendable\` (list(query,format)->[ConversationSummary] ([] for guests); get(id)->ConversationDetail; rename(id,title); setPinned(id,pinned); setActiveTeam(id,teamId:String?); delete(id); importGuestThread(sessionId,championsMode,turns:[ChatTurn])->String?) + LiveHistoryService over OakAPIClient (GET/PATCH/DELETE /api/conversations, POST /api/conversations/import). setActiveTeam PATCHes active_team_id.
- \`ios/OakApp/Features/History/HistoryListViewModel.swift\` + \`HistoryListView.swift\`: search (?q=), format filter (?format=), pin/rename/delete via swipe + context menu, pull-to-refresh.
- \`ios/OakApp/Features/History/HistoryDetailViewModel.swift\`: resume → set session_id = conversation id and hand off to ChatViewModel so earlier turns render (via AnswerCard) and follow-ups carry context.
- Guest→sign-in: in AppState (SHARED — additive), after verify, if a guest thread exists call importGuestThread with the in-memory turns; the returned id becomes the active conversation; failure is non-fatal (keep the on-screen thread).
TESTS (\`ios/OakAppTests/History/\`): VM list/search/filter/mutations against a FakeHistoryService; resume sets session_id; guest import maps in-memory turns to the import payload.`,
  },
  {
    id: 'p10',
    title: 'P10 Teams',
    codebase: 'ios',
    deps: ['p5', 'p7'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/Features/Chat/AnswerCard/TeamBlocksView.swift'],
    docs: ['component-design.md', 'requirements/history-and-teams.md', 'api-design.md (Teams)', 'data-model.md (Team)', 'conventions.md'],
    reqRefs: ['M-TEAM-US-1', 'M-TEAM-US-2', 'M-TEAM-US-3', 'M-TEAM-US-4', 'M-TEAM-US-5', 'M-TEAM-US-6', 'M-BR-T1', 'M-BR-T2', 'M-BR-T3', 'M-BR-T4', 'M-BR-T5', 'M-BR-T6', 'M-UI-US-5'],
    task: `PHASE P10 — TEAM BUILDER (signed-in).
- \`ios/OakApp/Services/TeamService.swift\`: \`protocol TeamService: Sendable\` (list(format)->[Team]; get(id)->(Team,TeamValidationResult); create(format,name?,members?)->(Team,TeamValidationResult); update(id,name?,members?)->(Team,TeamValidationResult); delete(id); duplicate(id)->(Team,TeamValidationResult); importPaste(format,paste)->(Team,TeamValidationResult,[ImportNote]); exportPaste(id)->String) + LiveTeamService over the /api/teams routes. Define ImportNote per /api/teams/import notes.
- \`ios/OakApp/Features/Teams/TeamsListViewModel.swift\` + \`TeamsListView.swift\` (library, format filter).
- \`ios/OakApp/Features/Teams/TeamEditorViewModel.swift\` + \`TeamEditorView.swift\`: full-set editor via NATIVE inputs — species/ability/item (search/pickers), 4 moves, nature, EVs/IVs (steppers), Tera, level. Warn-but-allow: render warnings but NEVER block save.
- \`ios/OakApp/Features/Teams/ShowdownImportView.swift\`: paste→import; export via the share sheet.
- Apply-proposed-team: wire TeamBlocksView's "Apply" (SHARED — surgical) to create a saved team from a proposed_team (POST /api/teams). Active-team binding: setting active team persists on the conversation (HistoryService.setActiveTeam) and rides the next chat request via the server context.
TESTS (\`ios/OakAppTests/Teams/\`): VM CRUD vs a FakeTeamService; warnings render but never block save; Showdown export→import round-trips; apply proposed creates a saved team; active-team set persists.`,
  },
  {
    id: 'p11',
    title: 'P11 Artifact',
    codebase: 'ios',
    deps: ['p3', 'p7'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/Features/Chat/AnswerCard/AnswerCardView.swift'],
    docs: ['component-design.md', 'requirements/artifact-viewer.md', 'api-design.md (entity/sprites)', 'conventions.md'],
    reqRefs: ['M-ART-US-1', 'M-ART-US-2', 'M-ART-US-3', 'M-ART-US-4', 'M-BR-ART-1', 'M-BR-ART-2', 'M-BR-ART-3', 'M-BR-ART-4', 'M-BR-ART-5', 'M-UI-US-6'],
    task: `PHASE P11 — ARTIFACT VIEWER (bottom sheet over chat).
- \`ios/OakApp/Services/ArtifactService.swift\`: \`protocol ArtifactService: Sendable\` (entity(kind,q,format)->EntityArtifact?; savedTeam(id)->(Team,TeamValidationResult)?). NEVER throws — returns nil on not_found/unavailable/transport (the viewer must never break). + LiveArtifactService over GET /api/entity (+ /api/sprites as needed).
- \`ios/OakApp/Features/Artifact/ArtifactViewModel.swift\` (@MainActor @Observable): a back-stack of artifacts — push(entity)/back()/dismiss(); only ONE artifact visible at a time.
- \`ios/OakApp/Features/Artifact/ArtifactSheetView.swift\`: a draggable bottom sheet (presentationDetents) over the chat; swipe-down dismisses.
- \`ios/OakApp/Features/Artifact/EntityDetailView.swift\`: pokemon/move/ability/item/type profiles (format-aware), using SpriteImage/TypeBadge; render matchups + movepool for pokemon.
- Make entities/blocks in AnswerCard tappable (SHARED AnswerCardView — surgical) to push artifacts. Team artifacts use the inline proposed_team (NO fetch); saved-team + entity artifacts fetch via ArtifactService.
TESTS (\`ios/OakAppTests/Artifact/\`): back-stack push/back/dismiss; one-at-a-time; nil-graceful entity fetch (not-found/unavailable doesn't break the sheet); team artifact uses inline data (no fetch).`,
  },
  {
    id: 'p12',
    title: 'P12 Account & Polish',
    codebase: 'ios',
    deps: ['p5', 'p2'],
    gate: iosTest,
    sharedFiles: ['ios/OakApp/Resources/Info.plist', 'ios/OakApp/Resources/Assets.xcassets'],
    securityReview: `Deletion correctness + privacy. Confirm: account deletion calls DELETE /api/auth/account, then clears the Keychain token and returns the app to guest; the confirm flow can't fire accidentally; no PII beyond the token is persisted on device; privacy strings present.`,
    docs: ['component-design.md', 'requirements/accounts-and-access.md (M-ACCT-US-6)', 'requirements/platform-and-operational.md', 'requirements/ui-and-experience.md', 'deployment.md (App Store prereqs)', 'conventions.md'],
    reqRefs: ['M-ACCT-US-6', 'M-NFR-6', 'M-NFR-7', 'M-NFR-8', 'M-NFR-9', 'M-NFR-10', 'M-NFR-11', 'M-NFR-14', 'M-NFR-15', 'M-UI-US-7', 'M-UI-US-9'],
    task: `PHASE P12 — ACCOUNT, DELETION & APP-STORE POLISH.
- \`ios/OakApp/Features/Account/AccountViewModel.swift\` + \`AccountView.swift\`: sign in/out, tier/limit indication (guest vs signed-in), and the ACCOUNT DELETION confirm flow (destructive confirm → AuthService.deleteAccount → token cleared → back to guest).
- \`ios/OakApp/UI/ConnectionStateView.swift\`: offline / retry surface (M-AC-NFR1.1) — a clean state, never a hang or raw error; reusable where the app needs it.
- Accessibility pass: VoiceOver labels on key controls; Dynamic Type holds at the largest sizes; sufficient contrast; color never the sole carrier (audit existing views, fix where cheap).
- Info.plist (SHARED — additive): finalize NSCameraUsageDescription / NSPhotoLibraryUsageDescription honest strings; ATS. Assets.xcassets (SHARED): app icon + brand/accent colors (placeholders are fine but present). Add privacy-policy / about links (URLs can be placeholders, noted).
TESTS (\`ios/OakAppTests/Account/\`): deletion confirm → returns to guest + token cleared (FakeAuthService); offline → retry surface (no crash); a VoiceOver/Dynamic-Type smoke where unit-testable. (Real VoiceOver + privacy-label submission are human follow-ups.)`,
  },
  {
    id: 'p13',
    title: 'P13 Integration & E2E',
    codebase: 'ios',
    deps: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12'],
    gate: iosUITestBuild,
    docs: ['testing-strategy.md', 'implementation-plan.md (P13 + Integration Checkpoints)', 'requirements/overview.md (success criteria)'],
    reqRefs: ['M-SUCCESS-1', 'M-SUCCESS-2', 'M-SUCCESS-3', 'M-NFR-2', 'M-NFR-3', 'M-NFR-4', 'M-UI-US-2', 'M-UI-US-8'],
    task: `PHASE P13 — INTEGRATION & E2E (XCUITest CODE; live runs are deferred to humans).
- \`ios/OakAppUITests/\`: write the XCUITest critical path (launch → ask a question → tool activity + streamed answer renders) and cross-feature scenarios (guest→sign-in→history; active-team→chat→artifact; offline→retry surface no crash). These are written to run against staging on a device/sim with a live backend — but THIS gate only BUILDS them (build-for-testing), it does not execute them live (no staging backend/keys here). Use launch arguments / a mock seam where a live backend is unavailable so the suite at least builds and the offline/error scenarios can run hermetically if feasible.
- Add a brief \`ios/README.md\` documenting: how to generate+open the project (xcodegen), run unit tests (the iPhone 17 sim), the staging/prod BaseURL switch, and the DEFERRED human checkpoints (CP1/CP2/CP4 live integration, CP5 device E2E, signing/TestFlight, IP review).
Gate = build-for-testing succeeds (the UITest target compiles). Note in your return that live E2E (CP5) is a human follow-up.`,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function header(ph) {
  return `${COMMON}

=== PHASE ${ph.id.toUpperCase()} — ${ph.title} ===
Docs to read first (under docs/features/iphone-app/): ${(ph.docs || []).join(', ')}
Requirement refs: ${(ph.reqRefs || []).join(', ')}
${ph.sharedFiles && ph.sharedFiles.length ? `SHARED files you may edit surgically (do not break other phases): ${ph.sharedFiles.join(', ')}` : ''}`
}

function verifyPrompt(ph) {
  return `You are the BUILD VERIFIER for phase ${ph.id.toUpperCase()} (${ph.title}).
Run EXACTLY this command from the repo root (it can take several minutes — call Bash with timeout 600000):

    ${ph.gate} ; echo "OAK_EXIT=$?"

Capture combined stdout+stderr. ${ph.verifyNotes || ''}
Determine pass/fail from the OAK_EXIT line (0 = pass). If it FAILED, extract the most relevant compiler/test errors — grep for lines containing "error:", "FAIL", "failing", "❌", "✗", "Testing failed", "Build input", "cannot find", "Undefined symbol" plus a little surrounding context — and return up to ~120 lines as errorTail (trim noise; keep the actionable errors). If it PASSED, errorTail is "".
Do NOT modify any files. Do NOT try to fix anything. Return {passed, errorTail, summary}.`
}

async function runImplementers(ph) {
  if (ph.fanout) {
    const intro = `${header(ph)}

${ph.fanoutIntro}`
    // Wave 1: independent files, in parallel (disjoint paths, shared module).
    await parallel(
      ph.fanout.map((sub) => () =>
        agent(
          `${intro}

YOUR FILE: ${sub.files}
SPEC: ${sub.detail}

Create ONLY this file (plus, if strictly necessary, a tiny supporting extension in the SAME file). Match the conventions. Do not run the build.`,
          { label: `${ph.id}:impl:${sub.label}`, phase: ph.title, schema: IMPL_SCHEMA },
        ),
      ),
    )
    // Wave 2: the integrator/tests, sees all fanned-out files.
    if (ph.post) {
      await agent(`${header(ph)}

${ph.post}`, { label: `${ph.id}:impl:integrate`, phase: ph.title, schema: IMPL_SCHEMA })
    }
  } else {
    await agent(`${header(ph)}

${ph.task}`, { label: `${ph.id}:impl`, phase: ph.title, schema: IMPL_SCHEMA })
  }
}

function canRepair(tries) {
  if (tries >= MAX_REPAIR) return false
  if (budget.total && budget.remaining() < REPAIR_FLOOR) return false
  return true
}

async function buildPhase(ph) {
  log(`▶ ${ph.title} — implementing`)
  await runImplementers(ph)

  let verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify`, phase: ph.title, schema: VERIFY_SCHEMA })
  let tries = 0
  while ((!verdict || !verdict.passed) && canRepair(tries)) {
    tries++
    const errs = (verdict && verdict.errorTail) || 'gate produced no structured output (treat as failed)'
    log(`✗ ${ph.title} gate failed — repair attempt ${tries}/${MAX_REPAIR}`)
    await agent(
      `${header(ph)}

The gate for this phase FAILED. Gate command:
    ${ph.gate}
Error tail:
-----
${errs}
-----
FIX the phase's files in place (Read then Edit/Write) so the gate passes. Honor the conventions (Swift 6 strict concurrency, Sendable, actor isolation, explicit CodingKeys, in-domain-failures-are-values). Common Swift fixes: add Sendable/Equatable conformance, resolve actor-isolation/@MainActor, correct CodingKeys vs the wire names, fix optionals, define/rename missing symbols, add files to the right target via project.yml globs. Do NOT run xcodebuild/xcodegen yourself. Return {filesWritten (the ones you changed), notes}.`,
      { label: `${ph.id}:repair:${tries}`, phase: ph.title, schema: IMPL_SCHEMA },
    )
    verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify:${tries}`, phase: ph.title, schema: VERIFY_SCHEMA })
  }

  const passed = !!(verdict && verdict.passed)

  // Security / design review (advisory; one repair pass on real issues).
  let review = null
  if (ph.securityReview && passed) {
    log(`🔒 ${ph.title} — security review`)
    review = await agent(
      `${header(ph)}

SECURITY REVIEW for this phase. Inspect the changed files (use \`cd ${ROOT} && git diff --stat\` and read the relevant files). Focus: ${ph.securityReview}
Report ONLY real, exploitable or correctness-affecting issues (no style nits). Return {issues, summary}.`,
      { label: `${ph.id}:secreview`, phase: ph.title, schema: REVIEW_SCHEMA, effort: 'high' },
    )
    const blocking = review && review.issues ? review.issues.filter((i) => i.severity === 'critical' || i.severity === 'high') : []
    if (blocking.length) {
      log(`🔒 ${ph.title} — ${blocking.length} blocking security issue(s); applying fix`)
      await agent(
        `${header(ph)}

A security review of this phase found issues that must be fixed:
${blocking.map((i) => `- [${i.severity}] ${i.file}: ${i.detail}`).join('\n')}
Fix them in place without breaking the build or existing tests. Return {filesWritten, notes}.`,
        { label: `${ph.id}:secfix`, phase: ph.title, schema: IMPL_SCHEMA },
      )
      verdict = await agent(verifyPrompt(ph), { label: `${ph.id}:verify:sec`, phase: ph.title, schema: VERIFY_SCHEMA })
    }
  }

  const finalPassed = !!(verdict && verdict.passed)
  log(`${finalPassed ? '✓' : '⚠'} ${ph.title} — ${finalPassed ? 'gate green' : `gate NOT green after ${tries} repair attempt(s)`}`)
  return {
    id: ph.id,
    title: ph.title,
    passed: finalPassed,
    repairs: tries,
    summary: (verdict && verdict.summary) || '',
    securityIssues: review && review.issues ? review.issues.length : 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive the DAG
// ─────────────────────────────────────────────────────────────────────────────
const want = !args || args === 'all' ? null : Array.isArray(args) ? args : [args]
const selected = (id) => !want || want.includes(id)
const byId = (id) => PHASES.find((p) => p.id === id)

log(`Building Oak iOS — ${want ? `phases: ${want.join(', ')}` : 'full DAG P1–P13 (+ P2 backend)'} · sim ${SIM} · repo ${ROOT}`)

const results = []

// P1 (scaffold) ∥ P2 (backend) — disjoint trees, safe to run concurrently.
phase('P1 Scaffold')
const seedThunks = []
if (selected('p1')) seedThunks.push(() => buildPhase(byId('p1')))
if (selected('p2')) seedThunks.push(() => buildPhase(byId('p2')))
if (seedThunks.length) {
  const seeded = await parallel(seedThunks)
  for (const r of seeded) if (r) results.push(r)
}

// P3 → P13 serially on the iOS tree (each phase's gate compiles the whole project;
// concurrent iOS phases would race the shared build). Intra-phase fan-out is inside buildPhase.
const SERIAL = ['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13']
for (const id of SERIAL) {
  if (!selected(id)) continue
  const ph = byId(id)
  phase(ph.title)
  // If a hard build dependency hasn't passed in THIS run and we're doing the full DAG, warn but continue
  // (deps may already exist on disk from a prior run).
  const r = await buildPhase(ph)
  results.push(r)
  if (!r.passed) log(`⚠ ${ph.title} did not reach a green gate; later phases may surface follow-on errors.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize
// ─────────────────────────────────────────────────────────────────────────────
phase('Finalize')
const green = results.filter((r) => r && r.passed).map((r) => r.id)
const red = results.filter((r) => r && !r.passed).map((r) => r.id)
log(`Gates green: ${green.join(', ') || 'none'}`)
if (red.length) log(`Gates NOT green: ${red.join(', ')}`)
log(
  `Fixture note: P3 fixtures are schema-derived (validated against web/'s zod oakAnswerSchema), not live-captured — no recorded /api/chat fixtures exist on this machine.`,
)
log(
  `DEFERRED human follow-ups (NOT done by this run): deploy web/ (Bearer + deletion) to staging; live integration checkpoints CP1/CP2/CP4 + device E2E CP5; code signing / TestFlight / App Store submission; IP-trademark review (decisions.md Unresolved). Phase 2 Vitest needs a Docker daemon.`,
)

return {
  selected: want || 'all',
  results,
  greenGates: green,
  redGates: red,
  parity:
    'Per requirement M-SUCCESS-1, the autonomously-buildable surface for chat (guest+signed-in), streaming, AnswerCard fidelity, history, teams, artifacts, images, account+deletion was built and compile/test-gated. Live parity verification (CP-series) is a human follow-up.',
}
