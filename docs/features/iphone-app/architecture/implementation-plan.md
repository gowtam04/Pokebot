# Implementation Plan

> **⚠️ Updated — "active team" removed (web change, 2026-06).** Saved teams are now
> referenced **by name in chat** (`list_teams` → `get_team`). Drop the active-team
> chip, `setActiveTeam`, and any `active_team_id`/active-team scoping from the phases
> below (M-TEAM-US-5 is retired); team CRUD + agent-assisted apply remain. Inline
> "active team" mentions below are superseded by this note.

Build-order phases for the native iOS client plus the two additive backend changes.
The backend phase (P2) is in a **different codebase** (`web/`, TypeScript) and runs in
parallel with early iOS work. Requirement IDs are the `M-`-prefixed IDs from
`docs/features/iphone-app/requirements/`.

---

## Phase 1: iOS Scaffolding
- **What gets built:** Xcode project under `ios/` (app + Swift Testing + XCUITest
  targets); Swift 6 strict-concurrency on; build schemes (Debug→staging URL,
  Release→prod URL) via `BaseURL.swift`; `Info.plist` (camera/photo usage strings,
  ATS); `Theme.swift` brand skeleton (light/dark, Dynamic Type); `OSLog` categories;
  `RootView` `TabView` shell (Chat/History/Teams/Account placeholders); CI build job.
- **Depends on:** nothing.
- **Produces:** a launchable empty app, service-injection scaffolding
  (`Environment+Services`, `AppState` stub), green CI build.
- **Parallel opportunities:** Theme, Info.plist, CI config independent.
- **Test focus:** project builds; app launches to the tab shell; a trivial smoke test runs.
- **Requirement refs:** M-CON-1, M-CON-2, M-NFR-5, M-UI-US-1 (M-AC-UI1.3/1.4 scaffolding).
- **Success criteria:** `xcodebuild` builds Debug+Release; app launches in simulator to a
  4-tab shell in light & dark; Dynamic Type doesn't clip the shell.
- **Review checklist / test split:** unit only (smoke). Gate: strict concurrency compiles
  with no warnings-as-errors suppressed.

## Phase 2: Backend additive changes (`web/`)
- **What gets built:** (a) `DELETE /api/auth/account` route +
  `deleteAccount(accountId)` cascade in `accounts-repo.ts`; (b) Bearer adaptation —
  `verify` returns `token` in body; session resolver (`current-user.ts`/`sessions.ts`)
  accepts `Authorization: Bearer` as a fallback to the cookie.
- **Depends on:** nothing (parallel with P1). Different repo/skillset.
- **Produces:** the auth + deletion surface the client needs; web behavior unchanged.
- **Parallel opportunities:** deletion route and Bearer adaptation are independent.
- **Test focus:** Vitest — Bearer resolves identity identically to cookie; cookie path
  unchanged; deletion cascades all account-scoped rows in one txn and is FK-safe.
- **Requirement refs:** M-NFR-6, M-ACCT-US-6, M-BR-ACCT-5, M-BR-ACCT-6, M-ACCT-US-2,
  M-BR-PLAT-1, M-BR-PLAT-3.
- **Success criteria:** existing web auth tests stay green; a Bearer-auth request to
  `/api/conversations` returns the same as the cookie path; after deletion the account +
  all its conversations/teams/sessions are gone and the token 401s.
- **Review checklist / test split:** integration tests against the Testcontainers
  Postgres (real DB). Gates: code review + **security review** (auth path + cascade
  correctness / no cross-account deletion).

## Phase 3: Wire DTOs + contract tests (`ios/`)
- **What gets built:** all `Models/Wire/` types (`OakAnswer` + sub-structs, `Team`,
  `Conversation`, `EntityArtifact`, `ChatWire`, `JSONScalar`, auth DTOs) with
  `CodingKeys` for snake_case fields.
- **Depends on:** P1.
- **Produces:** the typed contract every service/VM/view uses.
- **Parallel opportunities:** each model file is independent; split across builders.
- **Test focus:** decode **recorded backend fixtures** (capture real JSON from a running
  backend / the web tests' fixtures) for every endpoint and every OakAnswer status;
  round-trip encode/decode for request bodies and `JSONScalar`.
- **Requirement refs:** M-AC-1.2, M-AC-1.4, M-SUCCESS-3, M-BR-CHAT-5.
- **Success criteria:** every fixture decodes with no data loss; an OakAnswer with all
  optional fields present decodes fully; unknown `JSONScalar` shapes round-trip.
- **Review checklist / test split:** unit only, real fixtures (no mocks). Gate: fixtures
  are committed and traceable to the TS source shapes (drift guard).

## Phase 4: Networking core (`ios/`)
- **What gets built:** `OakAPIClient` (actor, Bearer injection, JSON, error mapping),
  `Endpoint`, `OakError` + HTTP mapping, `TokenStore` (Keychain), `SSEParser` (pure),
  `SSEClient`.
- **Depends on:** P3 (DTOs). Bearer end-to-end also needs P2.
- **Produces:** a typed client + the chat event stream all services build on.
- **Parallel opportunities:** `SSEParser`/`SSEClient` vs the REST client vs `TokenStore`
  are independent.
- **Test focus:** `SSEParser` against recorded SSE byte streams (multi-frame, heartbeat
  comments, single-delta Grok case, terminal `answer` and `error`); error mapping
  (429+Retry-After, 401, 4xx/5xx envelopes, transport); Keychain CRUD.
- **Requirement refs:** M-NFR-2, M-NFR-12, M-NFR-13, M-BR-CHAT-4, M-AC-4.4, M-NFR-1.
- **Success criteria:** parser reconstructs the exact event sequence from fixtures;
  Keychain token survives a relaunch and is removed on clear; pre-stream HTTP errors
  throw the right `OakError`.
- **Review checklist / test split:** unit (parser, mapping, Keychain) + one integration
  test hitting staging `/api/health` & `/api/entity`. Gate: code review.

## Phase 5: Auth & session (`ios/`)
- **What gets built:** `AuthService` (request/verify/me/signout/deleteAccount),
  `AppState` auth transitions, `AuthViewModel` + `AuthView` (email→OTP, resend cooldown,
  OTP autofill, error surfacing).
- **Depends on:** P4, P2.
- **Produces:** sign-in/out, token persistence, guest↔signed-in state for the app.
- **Parallel opportunities:** AuthView UI vs AuthService logic.
- **Test focus:** VM against a fake `AuthService` — happy path, invalid/expired code,
  resend cooldown, rate-limit message, sign-out clears token, expiry→guest.
- **Requirement refs:** M-ACCT-US-1, M-ACCT-US-2 (M-AC-2.1–2.5), M-ACCT-US-3,
  M-ACCT-US-5, M-BR-ACCT-1, M-BR-ACCT-2, M-BR-ACCT-5.
- **Success criteria:** a real device can request a code, verify, and land signed-in with
  the token in Keychain; relaunch stays signed in; sign-out returns to guest. OTP autofill
  works from Messages.
- **Review checklist / test split:** unit (VM+fakes) + manual device check of OTP
  autofill. Gate: code review + **security review** (token storage/handling).

## Phase 6: Chat core + streaming (`ios/`)
- **What gets built:** `ChatService`, `ChatViewModel` (SSE reducer), `ChatView` thread,
  `ComposerView` (text + mode toggle + active-team chip; images come in P8),
  `StreamingStatusView`, and a **minimal** answer view (status + `answer_markdown`).
- **Depends on:** P4. (Guest chat needs no auth.)
- **Produces:** working guest chat with token-by-token streaming + tool activity.
- **Parallel opportunities:** StreamingStatusView vs ComposerView vs the reducer.
- **Test focus:** the reducer over fixture event streams (deltas append; `answer_start`
  resets buffer; terminal `answer` finalizes; `error` → banner); Champions toggle flows
  into the request; in-domain non-`answered` statuses render (not error).
- **Requirement refs:** M-CHAT-US-1 (M-AC-1.1/1.3), M-CHAT-US-2, M-CHAT-US-3,
  M-CHAT-US-4 (M-AC-4.1–4.4), M-CHAT-US-6, M-BR-CHAT-1, M-BR-CHAT-2.
- **Success criteria:** ask a question as guest → tool-activity shows, text streams,
  terminal answer renders; new-conversation resets context; Champions toggle changes
  scope and the answer's format tag reflects it.
- **Review checklist / test split:** unit (reducer, fakes) + an integration test against
  staging chat. Gate: code review.

## Phase 7: AnswerCard field-by-field rendering (`ios/`)
- **What gets built:** the full `AnswerCard/` tree — citations, inferences, generation
  basis, subjects, candidates table, damage calc, clarify question, suggestions,
  uncertainty flags, team blocks (proposed/saved + warnings + "Apply"); `MarkdownText`,
  `SpriteImage`, `TypeBadge`.
- **Depends on:** P3 (DTOs), P6 (host thread).
- **Produces:** full-fidelity answer rendering (M-SUCCESS-3).
- **Parallel opportunities:** **high** — every field subview is independent.
- **Test focus:** snapshot/structure tests per subview over fixtures with that field
  present and absent; tables wrap/scroll legibly; color is not the sole flag carrier.
- **Requirement refs:** M-AC-1.2, M-AC-1.4, M-SUCCESS-3, M-AC-6.2, M-UI-US-1
  (M-AC-UI1.2), M-UI-US-9 (M-AC-UI9.3).
- **Success criteria:** an answer with all fields populated renders each field correctly
  in light/dark at large Dynamic Type without clipping; the "Apply" action on a
  `proposed_team` is present (wired in P10).
- **Review checklist / test split:** unit + snapshot. Gate: code review + design review
  (brand fidelity).

## Phase 8: Image input (camera + library) (`ios/`)
- **What gets built:** `ImageEncoder` (caps + re-encode), `CameraPicker` wrapper,
  `PhotosPicker` integration in `ComposerView`, thumbnail/remove UI, permission prompts.
- **Depends on:** P6.
- **Produces:** image-attached turns (the native version of web vision input).
- **Parallel opportunities:** camera vs library pickers; encoder is independent.
- **Test focus:** `ImageEncoder` cap logic (≤4, per-image ≤3.75 MiB, total ≤10 MiB,
  type) → typed rejection; base64 has no `data:` prefix; image-only (empty text) turn is
  valid; backend rejection surfaces a specific message.
- **Requirement refs:** M-CHAT-US-5 (M-AC-5.1–5.6).
- **Success criteria:** take/pick up to 4 images, see thumbnails, remove one, send (with
  or without text); a too-large/too-many attempt is blocked with a clear message;
  permission-denied explains how to enable and keeps other input methods.
- **Review checklist / test split:** unit (encoder) + manual device check (camera,
  permissions). Gate: code review.

## Phase 9: Chat history (`ios/`)
- **What gets built:** `HistoryService`, `HistoryListViewModel`/`HistoryListView`
  (search, format filter, pin/rename/delete via swipe + context menu, pull-to-refresh),
  `HistoryDetailViewModel` (resume → ChatView), guest→sign-in `importGuestThread`.
- **Depends on:** P5 (auth), P6, P7 (render resumed answers).
- **Produces:** durable, cross-device history browse/resume for signed-in users.
- **Parallel opportunities:** list vs detail/resume vs import handoff.
- **Test focus:** VM list/search/filter/mutations against a fake service; resume sets
  `session_id` = conversation id and earlier turns render; import on sign-in maps the
  in-memory guest thread to the import payload.
- **Requirement refs:** M-HIST-US-1 (M-AC-H1.1/1.2), M-HIST-US-2, M-HIST-US-3,
  M-BR-H1–H4, M-ACCT-US-4 (M-AC-4.1/4.2), M-UI-US-4.
- **Success criteria:** a signed-in user sees conversations (incl. ones made on web),
  searches/filters/pins/renames/deletes, reopens one and a context-dependent follow-up
  reflects earlier turns; a guest who signs in mid-thread finds it saved.
- **Review checklist / test split:** unit (VM+fakes) + integration (real backend list/
  get/patch/delete round-trip). Gate: code review.

## Phase 10: Team builder (`ios/`)
- **What gets built:** `TeamService`, `TeamsListViewModel`/`View`, `TeamEditorViewModel`/
  `View` (full-set editor: species/ability/item/4 moves/nature/EVs/IVs/Tera/level via
  native inputs), `ShowdownImportView` (paste import; export via share sheet), warn-but-
  allow warning display, apply-proposed-team (from AnswerCard), active-team binding.
- **Depends on:** P5, P7 (team blocks render).
- **Produces:** full team library + agent-assisted apply + active-team scoping.
- **Parallel opportunities:** list vs editor vs import/export.
- **Test focus:** VM CRUD against a fake service; warnings render but never block save;
  Showdown export round-trips through import; "Apply" a `proposed_team` creates a saved
  team; setting active team persists on the conversation and rides the next chat request.
- **Requirement refs:** M-TEAM-US-1–6, M-BR-T1–T6, M-UI-US-5.
- **Success criteria:** build/save/reopen a 6-mon team; paste→save→export round-trips;
  an EV-over-508 team still saves with a clear warning; with an active team, a "weak to
  X?" question reasons against the saved sets.
- **Review checklist / test split:** unit (VM+fakes) + integration (create/update/import/
  export/duplicate/delete round-trip). Gate: code review.

## Phase 11: Artifact viewer (`ios/`)
- **What gets built:** `ArtifactService`, `ArtifactSheetView` (draggable bottom sheet +
  detents), `ArtifactViewModel` (back stack), `EntityDetailView` (pokemon/move/ability/
  item/type), tappable entities/blocks in `AnswerCard` that push artifacts.
- **Depends on:** P7 (entities appear in structured answer parts), P3.
- **Produces:** co-visible, drill-down artifact browsing over chat.
- **Parallel opportunities:** entity-detail rendering vs the sheet/back-stack mechanics.
- **Test focus:** back-stack push/back/dismiss; one artifact at a time; entity fetch
  returns nil gracefully (not-found/unavailable) without breaking the sheet; team
  artifact uses inline `proposed_team` (no fetch).
- **Requirement refs:** M-ART-US-1–4, M-BR-ART-1–5, M-UI-US-6, M-UI-US-8 (M-AC-UI8.4).
- **Success criteria:** tapping an entity in a structured answer opens the bottom sheet
  over the chat; drilling pushes/back works; swipe-down dismisses to chat; format-aware
  profiles.
- **Review checklist / test split:** unit (VM) + snapshot (entity views) + manual gesture
  check. Gate: code review.

## Phase 12: Account, deletion & App Store polish (`ios/`)
- **What gets built:** `AccountView`/VM (sign in/out, tier/limit indication,
  **account deletion** confirm flow), `ConnectionStateView` (offline/retry), full
  accessibility pass (VoiceOver labels, Dynamic Type, contrast), privacy policy/about
  links, app icon + brand assets, App Store privacy label prep.
- **Depends on:** P5, P2 (deletion endpoint).
- **Produces:** App-Store-submittable build.
- **Parallel opportunities:** a11y pass vs account/deletion vs assets/metadata.
- **Test focus:** deletion confirm → returns to guest + token cleared; offline shows a
  retry surface (no crash); VoiceOver reaches key controls; layouts hold at largest
  Dynamic Type.
- **Requirement refs:** M-ACCT-US-6 (M-AC-6.1–6.3), M-NFR-6–11, M-NFR-14/15, M-UI-US-7,
  M-UI-US-9 (M-AC-UI9.1–9.3), M-NFR-1 (M-AC-NFR1.1).
- **Success criteria:** account deletion works end-to-end; privacy strings + nutrition
  label accurate; passes an internal accessibility audit; airplane-mode shows a clean
  state.
- **Review checklist / test split:** unit + manual (deletion, VoiceOver, offline). Gate:
  code review + **security/privacy review** (deletion correctness, privacy label).

## Phase 13: Integration & E2E
- **What gets built:** XCUITest critical path (launch → ask → streamed answer renders);
  cross-feature checks (guest→sign-in→history; active-team→chat→artifact); error/edge
  states; performance pass (scroll, sheet, streaming smoothness).
- **Depends on:** all prior.
- **Produces:** the verified, shippable v1.
- **Parallel opportunities:** independent E2E scenarios.
- **Test focus:** end-to-end flows on device against staging; resilience (well-formed
  error responses never crash); streaming responsiveness.
- **Requirement refs:** M-SUCCESS-1, M-SUCCESS-2, M-SUCCESS-3, M-NFR-2, M-NFR-3,
  M-NFR-4, M-UI-US-2, M-UI-US-8.
- **Success criteria:** the XCUITest passes in CI against staging; the parity checklist
  (every web capability reachable) is green; no crash on any in-domain error.
- **Review checklist / test split:** integration/E2E (real backend) + manual device pass.
  Gate: final review.

---

## Integration Checkpoints

- **CP1 — Networking ⇄ backend (after P4, needs P2 deployed to staging):** a smoke run
  decodes `/api/health`, `/api/entity`, and a real SSE chat stream end-to-end; Bearer
  header authenticates. Verifies DTOs match live responses and the SSE parser handles the
  real stream.
- **CP2 — Auth end-to-end (after P5):** request code → verify returns token → Bearer call
  to `/api/conversations` succeeds → sign-out → token gone. Verifies the Bearer
  adaptation across the whole authed surface.
- **CP3 — Chat full-fidelity (after P7):** a question that exercises subjects + candidates
  + citations + inferences renders every field correctly. Verifies render fidelity
  (M-SUCCESS-3).
- **CP4 — Signed-in data round-trip (after P9 + P10):** create a team, set it active, ask
  a team question, confirm the conversation is saved and resumable on a fresh launch /
  the web app. Verifies cross-device parity + active-team scoping.
- **CP5 — Release E2E (after P13):** full XCUITest on device against staging + manual
  parity/accessibility/offline pass before App Store submission.

---

## Build Manifest

```yaml
commands:
  # iOS (run from ios/) — exact destination/scheme set during P1 scaffolding
  test: "xcodebuild test -scheme OakApp -destination 'platform=iOS Simulator,name=iPhone 16'"
  test_one: "xcodebuild test -scheme OakApp -only-testing:OakAppTests/<Suite>/<test> -destination 'platform=iOS Simulator,name=iPhone 16'"
  typecheck: "xcodebuild build -scheme OakApp -destination 'platform=iOS Simulator,name=iPhone 16'"  # Swift has no separate typecheck; build is it
  build: "xcodebuild -scheme OakApp -configuration Release build"
  # backend (run from web/) for Phase 2
  backend_test: "npm test"
  backend_typecheck: "npm run typecheck"
phases:
  - id: p1
    name: iOS Scaffolding
    depends_on: []
    owns: ["ios/OakApp/App/**", "ios/OakApp/UI/Theme.swift", "ios/OakApp/Support/Logging.swift",
            "ios/OakApp/Networking/BaseURL.swift", "ios/OakApp/Resources/**", "ios/*.xcodeproj/**", "ios/ci/**"]
    shared: []
    requirement_refs: [M-CON-1, M-CON-2, M-NFR-5, M-UI-US-1]
    test_focus: "builds; launches to tab shell; light/dark + Dynamic Type shell"
    flags: [scaffold, ui]
  - id: p2
    name: Backend additive changes
    depends_on: []
    owns: ["web/src/app/api/auth/account/**", "web/src/data/repos/accounts-repo.ts"]
    shared: ["web/src/app/api/auth/verify/route.ts", "web/src/server/auth/current-user.ts", "web/src/server/auth/sessions.ts"]
    requirement_refs: [M-NFR-6, M-ACCT-US-6, M-BR-ACCT-5, M-BR-ACCT-6, M-ACCT-US-2, M-BR-PLAT-3]
    test_focus: "Bearer == cookie identity; cookie path unchanged; deletion cascade FK-safe in one txn"
    flags: []
  - id: p3
    name: Wire DTOs + contract tests
    depends_on: [p1]
    owns: ["ios/OakApp/Models/Wire/**", "ios/OakAppTests/Fixtures/**", "ios/OakAppTests/Decoding/**"]
    shared: []
    requirement_refs: [M-AC-1.2, M-AC-1.4, M-SUCCESS-3, M-BR-CHAT-5]
    test_focus: "decode real fixtures for every endpoint + every OakAnswer status; JSONScalar round-trip"
    flags: []
  - id: p4
    name: Networking core
    depends_on: [p3]
    owns: ["ios/OakApp/Networking/OakAPIClient.swift", "ios/OakApp/Networking/Endpoint.swift",
            "ios/OakApp/Networking/SSEClient.swift", "ios/OakApp/Networking/SSEParser.swift",
            "ios/OakApp/Networking/TokenStore.swift", "ios/OakApp/Networking/OakError.swift",
            "ios/OakAppTests/Networking/**"]
    shared: []
    requirement_refs: [M-NFR-2, M-NFR-12, M-NFR-13, M-BR-CHAT-4, M-AC-4.4, M-NFR-1]
    test_focus: "SSE parser over recorded streams; error mapping; Keychain CRUD"
    flags: []
  - id: p5
    name: Auth & session
    depends_on: [p4, p2]
    owns: ["ios/OakApp/Services/AuthService.swift", "ios/OakApp/Features/Auth/**", "ios/OakAppTests/Auth/**"]
    shared: ["ios/OakApp/App/AppState.swift"]
    requirement_refs: [M-ACCT-US-1, M-ACCT-US-2, M-ACCT-US-3, M-ACCT-US-5, M-BR-ACCT-1, M-BR-ACCT-2, M-BR-ACCT-5]
    test_focus: "VM happy/invalid/expired/cooldown/rate-limit; signout clears token; expiry→guest"
    flags: []
  - id: p6
    name: Chat core + streaming
    depends_on: [p4]
    owns: ["ios/OakApp/Services/ChatService.swift", "ios/OakApp/Features/Chat/ChatViewModel.swift",
            "ios/OakApp/Features/Chat/ChatView.swift", "ios/OakApp/Features/Chat/ComposerView.swift",
            "ios/OakApp/Features/Chat/StreamingStatusView.swift", "ios/OakAppTests/Chat/**"]
    shared: ["ios/OakApp/App/AppState.swift"]
    requirement_refs: [M-CHAT-US-1, M-CHAT-US-2, M-CHAT-US-3, M-CHAT-US-4, M-CHAT-US-6, M-BR-CHAT-1, M-BR-CHAT-2]
    test_focus: "stream reducer (delta/start/answer/error); champions toggle in request; non-answered statuses render"
    flags: [ui]
  - id: p7
    name: AnswerCard rendering
    depends_on: [p3, p6]
    owns: ["ios/OakApp/Features/Chat/AnswerCard/**", "ios/OakApp/UI/MarkdownText.swift",
            "ios/OakApp/UI/SpriteImage.swift", "ios/OakApp/UI/TypeBadge.swift", "ios/OakAppTests/AnswerCard/**"]
    shared: []
    requirement_refs: [M-AC-1.2, M-AC-1.4, M-SUCCESS-3, M-AC-6.2, M-UI-US-1, M-UI-US-9]
    test_focus: "per-field render present/absent; tables legible; flags not color-only"
    flags: [ui]
  - id: p8
    name: Image input
    depends_on: [p6]
    owns: ["ios/OakApp/Services/ImageEncoder.swift", "ios/OakApp/Support/CameraPicker.swift", "ios/OakAppTests/Image/**"]
    shared: ["ios/OakApp/Features/Chat/ComposerView.swift"]
    requirement_refs: [M-CHAT-US-5]
    test_focus: "cap logic + typed rejection; raw base64; image-only turn valid"
    flags: [ui]
  - id: p9
    name: Chat history
    depends_on: [p5, p6, p7]
    owns: ["ios/OakApp/Services/HistoryService.swift", "ios/OakApp/Features/History/**", "ios/OakAppTests/History/**"]
    shared: ["ios/OakApp/App/AppState.swift"]
    requirement_refs: [M-HIST-US-1, M-HIST-US-2, M-HIST-US-3, M-BR-H1, M-BR-H2, M-BR-H3, M-BR-H4, M-ACCT-US-4, M-UI-US-4]
    test_focus: "list/search/filter/mutations; resume sets session_id; guest import on sign-in"
    flags: [ui]
  - id: p10
    name: Team builder
    depends_on: [p5, p7]
    owns: ["ios/OakApp/Services/TeamService.swift", "ios/OakApp/Features/Teams/**", "ios/OakAppTests/Teams/**"]
    shared: ["ios/OakApp/Features/Chat/AnswerCard/TeamBlocksView.swift"]
    requirement_refs: [M-TEAM-US-1, M-TEAM-US-2, M-TEAM-US-3, M-TEAM-US-4, M-TEAM-US-5, M-TEAM-US-6, M-BR-T1, M-BR-T2, M-BR-T3, M-BR-T4, M-BR-T5, M-BR-T6, M-UI-US-5]
    test_focus: "CRUD; warn-but-allow; Showdown round-trip; apply proposed; active-team binding rides chat"
    flags: [ui]
  - id: p11
    name: Artifact viewer
    depends_on: [p3, p7]
    owns: ["ios/OakApp/Services/ArtifactService.swift", "ios/OakApp/Features/Artifact/**", "ios/OakAppTests/Artifact/**"]
    shared: ["ios/OakApp/Features/Chat/AnswerCard/AnswerCardView.swift"]
    requirement_refs: [M-ART-US-1, M-ART-US-2, M-ART-US-3, M-ART-US-4, M-BR-ART-1, M-BR-ART-2, M-BR-ART-3, M-BR-ART-4, M-BR-ART-5, M-UI-US-6]
    test_focus: "back-stack; one-at-a-time; nil-graceful entity fetch; inline team artifact"
    flags: [ui]
  - id: p12
    name: Account, deletion & polish
    depends_on: [p5, p2]
    owns: ["ios/OakApp/Features/Account/**", "ios/OakApp/UI/ConnectionStateView.swift", "ios/OakAppTests/Account/**"]
    shared: ["ios/OakApp/Resources/Info.plist", "ios/OakApp/Resources/Assets.xcassets"]
    requirement_refs: [M-ACCT-US-6, M-NFR-6, M-NFR-7, M-NFR-8, M-NFR-9, M-NFR-10, M-NFR-11, M-NFR-14, M-NFR-15, M-UI-US-7, M-UI-US-9]
    test_focus: "deletion→guest+token cleared; offline retry surface; VoiceOver/Dynamic Type"
    flags: [ui]
  - id: p13
    name: Integration & E2E
    depends_on: [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12]
    owns: ["ios/OakAppUITests/**"]
    shared: []
    requirement_refs: [M-SUCCESS-1, M-SUCCESS-2, M-SUCCESS-3, M-NFR-2, M-NFR-3, M-NFR-4, M-UI-US-2, M-UI-US-8]
    test_focus: "E2E critical path on device vs staging; resilience; parity checklist"
    flags: []
integration_checkpoints:
  - after: [p4, p2]
    name: networking-backend-smoke
    verifies: "DTOs decode live responses; Bearer auth; SSE parser handles the real stream"
  - after: [p5]
    name: auth-e2e
    verifies: "code→verify(token)→Bearer authed call→signout across the whole authed surface"
  - after: [p7]
    name: chat-full-fidelity
    verifies: "an answer with subjects+candidates+citations+inferences renders every field"
  - after: [p9, p10]
    name: signed-in-roundtrip
    verifies: "team create+active+team question; conversation saved + resumable cross-launch/web"
  - after: [p13]
    name: release-e2e
    verifies: "XCUITest on device vs staging + manual parity/a11y/offline before submission"
```

**Parallelization summary:** P1 and P2 start together (different codebases). After P3,
P4 unlocks; P5 (auth) and P6 (chat, guest) can proceed largely in parallel once P4 lands.
P7's field subviews are the widest parallel fan-out. P8/P9/P10/P11 are mostly independent
feature tracks once P5+P7 exist and can run concurrently across builders, converging at
CP4 and P13.
