# Component Design

> **⚠️ Updated — "active team" removed (web change, 2026-06).** Saved teams are now
> referenced **by name in chat** (`list_teams` → `get_team`). The composer has no
> active-team chip, `ChatService.send` carries no `activeTeamId`, `HistoryService`
> has no `setActiveTeam`, and `ConversationDetail` has no `activeTeamId`. The
> `ComposerView` also folds the photo-library + camera triggers into one attach menu.
> Inline mentions of those below are superseded by this note.

Layered MVVM: **Views** (SwiftUI) → **ViewModels** (`@Observable`, `@MainActor`) →
**Services** (domain operations) → **Networking** (`OakAPIClient` + `SSEClient` +
DTOs). Lower layers never import upper layers. Services are protocol-typed so ViewModels
can be unit-tested against fakes.

## Components

### Networking layer (`Networking/`)
- **`OakAPIClient`** *(actor)* — owns the `URLSession`, base URL, JSON encode/decode, and
  attaches `Authorization: Bearer` from the `TokenStore`. Exposes typed async methods per
  endpoint; maps responses → DTO or throws `OakError`. Depends on: `TokenStore`, DTOs.
- **`SSEClient`** — runs `POST /api/chat` via `URLSession.bytes(for:)`, parses the SSE
  byte stream into an `AsyncThrowingStream<SSEEvent>`. Depends on: `OakAPIClient` (for
  auth header + base URL), `SSEParser`.
- **`SSEParser`** *(pure)* — incremental line parser: accumulates `event:`/`data:` lines,
  emits one `SSEEvent` per blank-line-terminated frame, ignores `:`-comment heartbeats.
  No I/O — unit-tested against recorded fixtures.
- **`TokenStore`** *(actor)* — Keychain read/write/delete of the session token. The only
  component that touches Keychain.

### Services layer (`Services/`) — each is a `protocol` + a concrete impl
- **`AuthService`** — `requestCode`, `verify` (stores token), `me`, `signOut` (clears
  token + calls endpoint), `deleteAccount`. Owns sign-in state transitions.
- **`ChatService`** — turns a user turn (text + images + mode + activeTeam) into an
  `AsyncThrowingStream<SSEEvent>` via `SSEClient`; encodes images to base64 with caps.
- **`HistoryService`** — list/get/patch/delete conversations; `importGuestThread`.
- **`TeamService`** — teams CRUD, import (Showdown), export, duplicate.
- **`ArtifactService`** — fetch entity artifact (`/api/entity`) and saved-team detail;
  returns `nil` on not-found/unavailable/transport (never throws) for the viewer.
- **`ImageEncoder`** *(pure)* — `UIImage` → validated `ChatImage` (re-encode JPEG/PNG,
  enforce per-image/total byte caps before send; surfaces a typed reason on reject).

### App / session state (`App/`)
- **`AppState`** *(@Observable, @MainActor)* — the root session model: current auth
  state (`guest` / `signedIn(email)`), the active conversation id, the in-memory guest
  thread, and the Champions-mode default. Injected via `@Environment`. Coordinates the
  guest→sign-in handoff (calls `HistoryService.importGuestThread`).

### ViewModels (`Features/*/`) — `@Observable`, `@MainActor`
- **`ChatViewModel`** — holds the visible turns, the in-progress streaming state
  (tool-activity items, streamed text buffer), composer state (text + attached images +
  mode + active team). Consumes the `SSEEvent` stream, applies `answer_start` resets,
  appends `answer_delta`, finalizes on terminal `answer`. Maps errors to a recoverable
  banner.
- **`AuthViewModel`** — email/code entry, resend cooldown, error surfacing, OTP autofill.
- **`HistoryListViewModel`** / **`HistoryDetailViewModel`** — list (search/filter/pin/
  rename/delete via swipe/context menus); detail loads `ConversationDetail` and hands off
  to `ChatViewModel` to resume.
- **`TeamsListViewModel`** / **`TeamEditorViewModel`** — library + full-set editor
  (pickers/steppers/search), import/export (share sheet + paste), warn-but-allow warnings,
  apply-proposed-team.
- **`ArtifactViewModel`** — the bottom-sheet back-stack of artifacts; `push(entity)`,
  `back()`, `dismiss()`.
- **`AccountViewModel`** — sign-in/out, tier display, account deletion (confirm flow).

### Views (`Features/*/` + `UI/`)
- Chat thread + composer; streaming/tool-activity views; `AnswerCardView` tree (one
  subview per OakAnswer field — answer, reasoning, citations, inferences, generation
  basis, subjects, candidates table, damage calc, suggestions, clarify question,
  uncertainty flags, team blocks); History list/detail; Teams list/editor; Artifact
  bottom sheet; Account/Settings; shared `UI/` (markdown text, sprite image, type badges,
  brand theme).

## File Structure

Xcode project under `ios/` (sibling to `web/`). `OakApp` is the app target;
`OakAppTests` (Swift Testing) and `OakAppUITests` (XCUITest) are the test targets.

```
ios/OakApp/
├── App/
│   ├── OakApp.swift                  — @main App; injects AppState + services; root scene
│   ├── AppState.swift                — @Observable session/root state (auth, active conv, guest thread, mode default)
│   ├── RootView.swift                — top-level nav (TabView: Chat / History / Teams / Account)
│   └── Environment+Services.swift    — @Environment keys for service injection
├── Networking/
│   ├── OakAPIClient.swift            — actor; URLSession; typed endpoint methods; Bearer header; error mapping
│   ├── Endpoint.swift                — request builder (path, method, query, body, auth flag)
│   ├── SSEClient.swift               — POST /api/chat → AsyncThrowingStream<SSEEvent>
│   ├── SSEParser.swift               — pure incremental SSE frame parser
│   ├── TokenStore.swift             — actor; Keychain CRUD for the session token
│   ├── OakError.swift                — typed error domain + HTTP→OakError mapping
│   └── BaseURL.swift                 — per-scheme base URL config
├── Models/Wire/
│   ├── ChatWire.swift                — ChatRequest, ChatImage, SSEEvent
│   ├── OakAnswer.swift               — OakAnswer + all sub-structs (render target)
│   ├── JSONScalar.swift              — Codable scalar wrapper for free-form maps
│   ├── Team.swift                    — Format, TeamMember, StatSpread, TeamWarning, TeamValidationResult
│   ├── Conversation.swift            — ConversationSummary, ConversationDetail, ChatTurn
│   ├── EntityArtifact.swift          — entity discriminated union DTO (+ sprites refs)
│   └── AuthDTOs.swift                — AuthVerifyResponse, MeResponse, APIErrorBody
├── Services/
│   ├── AuthService.swift             — protocol + LiveAuthService
│   ├── ChatService.swift             — protocol + LiveChatService
│   ├── HistoryService.swift          — protocol + LiveHistoryService
│   ├── TeamService.swift             — protocol + LiveTeamService
│   ├── ArtifactService.swift         — protocol + LiveArtifactService
│   └── ImageEncoder.swift            — pure UIImage → ChatImage with caps
├── Features/
│   ├── Chat/
│   │   ├── ChatViewModel.swift
│   │   ├── ChatView.swift            — thread + composer
│   │   ├── ComposerView.swift        — text, attach/camera, send, image thumbnails, mode toggle, active-team chip
│   │   ├── StreamingStatusView.swift — tool-activity ticker + "thinking" state
│   │   └── AnswerCard/
│   │       ├── AnswerCardView.swift  — orchestrates field-by-field rendering
│   │       ├── CitationsView.swift   ├── InferencesView.swift  ├── GenerationBasisView.swift
│   │       ├── SubjectsView.swift    ├── CandidatesTableView.swift ├── DamageCalcView.swift
│   │       ├── ClarifyQuestionView.swift ├── SuggestionsView.swift ├── UncertaintyFlagsView.swift
│   │       └── TeamBlocksView.swift  — proposed_team / saved_team / warnings + "Apply" action
│   ├── Auth/
│   │   ├── AuthViewModel.swift  └── AuthView.swift   — email → OTP (autofill), resend cooldown
│   ├── History/
│   │   ├── HistoryListViewModel.swift └── HistoryListView.swift  — search/filter/pin/rename/delete
│   │   └── HistoryDetailViewModel.swift (resume → ChatView)
│   ├── Teams/
│   │   ├── TeamsListViewModel.swift  └── TeamsListView.swift
│   │   ├── TeamEditorViewModel.swift └── TeamEditorView.swift    — full-set editor
│   │   └── ShowdownImportView.swift  — paste import; export via share sheet
│   ├── Artifact/
│   │   ├── ArtifactViewModel.swift   └── ArtifactSheetView.swift — draggable bottom sheet + back stack
│   │   └── EntityDetailView.swift    — pokemon/move/ability/item/type profiles
│   └── Account/
│       ├── AccountViewModel.swift    └── AccountView.swift       — sign in/out, tier, DELETE account
├── UI/
│   ├── Theme.swift                   — Oak brand colors/type over iOS (light+dark, Dynamic Type)
│   ├── MarkdownText.swift            — AttributedString(markdown:) wrapper
│   ├── SpriteImage.swift             — AsyncImage with placeholder/failure
│   ├── TypeBadge.swift               — Pokémon type chip (color + label, not color-only)
│   └── ConnectionStateView.swift     — offline / retry surface
├── Support/
│   ├── Logging.swift                 — OSLog Logger categories
│   └── CameraPicker.swift            — UIImagePickerController wrapper (camera source)
└── Resources/
    ├── Assets.xcassets               — app icon, brand colors
    └── Info.plist                    — NSCameraUsageDescription, NSPhotoLibraryUsageDescription, ATS

ios/OakAppTests/         — Swift Testing: SSEParser, DTO decode/round-trip, ViewModels (fake services), ImageEncoder caps
ios/OakAppUITests/       — XCUITest: launch → ask question → streamed answer renders
```

Ownership rule: one purpose per file; the AnswerCard is split per-field so the
field-by-field renderer can be built in parallel. No two phases' `owns` globs overlap
(see Build Manifest).

## Interface Definitions

High detail (Developer mode + autonomous-builder bias). Service protocols are the seams
ViewModels build against and tests fake.

```swift
// OakError — the one error domain (Networking/OakError.swift)
enum OakError: Error, Equatable {
  case transport(underlying: String)          // no connection / URLSession failure
  case http(status: Int, code: String, message: String)
  case rateLimited(retryAfter: TimeInterval?)  // 429
  case unauthorized                            // 401 on an authed call
  case decoding(String)                        // DTO mismatch (should not happen)
  case imageRejected(reason: ImageRejectReason)
}
enum ImageRejectReason: Equatable { case tooMany, perImageTooLarge, totalTooLarge, unsupportedType }

// OakAPIClient (actor) — representative typed methods
actor OakAPIClient {
  init(baseURL: URL, tokenStore: TokenStore, session: URLSession = .shared)
  // Generic typed request used by services; attaches Bearer when endpoint.requiresAuth.
  func send<Response: Decodable>(_ endpoint: Endpoint, as: Response.Type) async throws -> Response
  func sendNoContent(_ endpoint: Endpoint) async throws            // for { ok: true } / 204-style
  // SSE handled separately by SSEClient (streaming, not a single Decodable).
}

// SSEClient — the chat stream
struct SSEClient {
  init(apiClient: OakAPIClient)
  /// Opens POST /api/chat and yields events until the terminal `answer`/`error` or completion.
  /// Throws OakError for PRE-stream HTTP failures (rate limit, payload too large, 503…);
  /// once the stream is open, transport drops surface as a thrown error mid-stream, and an
  /// SSE `error` event is yielded as `.error(...)` then the stream finishes.
  func stream(_ request: ChatRequest) -> AsyncThrowingStream<SSEEvent, Error>
}

// AuthService — sign-in lifecycle
protocol AuthService: Sendable {
  func requestCode(email: String) async throws                          // maps invalid_email/rate_limited
  func verify(email: String, code: String) async throws -> Account      // stores token in Keychain on success
  func me() async throws -> AuthState                                    // .guest / .signedIn(email)
  func signOut() async throws                                           // clears Keychain + calls endpoint (idempotent)
  func deleteAccount() async throws                                     // DELETE /api/auth/account, then clears token
}
struct Account: Equatable, Sendable { let email: String; let created: Bool }
enum AuthState: Equatable, Sendable { case guest; case signedIn(email: String) }

// ChatService — one turn → event stream
protocol ChatService: Sendable {
  func send(sessionId: String, message: String, images: [UIImage],
            championsMode: Bool, activeTeamId: String?) -> AsyncThrowingStream<SSEEvent, Error>
  // Encodes images via ImageEncoder; throws .imageRejected(...) before opening the stream if caps fail.
}

// HistoryService
protocol HistoryService: Sendable {
  func list(query: String?, format: Format?) async throws -> [ConversationSummary]   // [] for guests
  func get(id: String) async throws -> ConversationDetail
  func rename(id: String, title: String) async throws
  func setPinned(id: String, pinned: Bool) async throws
  func setActiveTeam(id: String, teamId: String?) async throws
  func delete(id: String) async throws
  func importGuestThread(sessionId: String, championsMode: Bool, turns: [ChatTurn]) async throws -> String?
}

// TeamService
protocol TeamService: Sendable {
  func list(format: Format?) async throws -> [Team]
  func get(id: String) async throws -> (team: Team, validation: TeamValidationResult)
  func create(format: Format, name: String?, members: [TeamMember]?) async throws -> (Team, TeamValidationResult)
  func update(id: String, name: String?, members: [TeamMember]?) async throws -> (Team, TeamValidationResult)
  func delete(id: String) async throws
  func duplicate(id: String) async throws -> (Team, TeamValidationResult)
  func importPaste(format: Format, paste: String) async throws -> (Team, TeamValidationResult, [ImportNote])
  func exportPaste(id: String) async throws -> String
}

// ArtifactService — viewer data (never throws; nil = not available)
protocol ArtifactService: Sendable {
  func entity(kind: EntityKind, q: String, format: Format) async -> EntityArtifact?
  func savedTeam(id: String) async -> (Team, TeamValidationResult)?
}
enum EntityKind: String, Sendable { case pokemon, move, ability, item, type }

// TokenStore (actor)
actor TokenStore {
  func token() -> String?
  func set(_ token: String)
  func clear()
}
```

Behavioral notes the builder must honor:
- **Streaming reducer (`ChatViewModel`):** on `answer_start`, clear the streamed-text
  buffer (re-emit reset) but keep tool-activity history; on `answer_delta`, append; on
  terminal `answer`, replace the buffer with the authoritative `OakAnswer` and stop. Grok
  delivers the answer markdown in a single `answer_delta`, so don't assume many deltas.
- **Guest→sign-in:** after `verify`, if a guest thread exists in `AppState`, call
  `importGuestThread` with the in-memory turns; the returned id becomes the active
  conversation. Failure is non-fatal (keep the on-screen thread).
- **`activeTeamId` on chat:** the composer's active team is sent on the `ChatRequest`
  *and* persisted on the conversation via `setActiveTeam` so it survives resume.
- **Artifacts from on-screen data:** team artifacts use `proposed_team` already in the
  answer (no fetch); saved-team and entity artifacts fetch via `ArtifactService`
  (M-AC-A4.1 — instant for data already present).
