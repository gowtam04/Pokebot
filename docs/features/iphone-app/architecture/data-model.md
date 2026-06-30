# Data Model

The iOS app owns **no business data** — the backend (Postgres) remains the single
source of truth. The client's "data model" is therefore three things: (1) **Codable
DTOs** that mirror the wire contracts, (2) a small amount of **on-device state**, and
(3) two **backend schema touchpoints** for the additive changes.

> **Fidelity rule:** the Swift DTOs are a faithful mirror of the TypeScript/Zod
> contracts. The TS files are authoritative; if they change, the Swift mirrors must
> change. A round-trip decode test (Phase 2) guards drift. Field names are sent/received
> in the wire's `snake_case`; map to Swift `camelCase` with `CodingKeys` (do **not**
> rely on `.convertFromSnakeCase` globally — some payloads use mixed conventions, e.g.
> `dex_number` vs `mimeType`).

## A. Wire DTOs (Codable mirrors)

Group under `Models/Wire/`. All are `Codable`, `Sendable`, value types (`struct`/`enum`).

### Chat request (`POST /api/chat` body) — mirrors `sse-types.ts`
```swift
struct ChatRequest: Encodable, Sendable {
  let sessionId: String          // session_id — client UUID; == conversationId on resume
  let message: String            // 0–2000 chars; may be "" iff images present
  let images: [ChatImage]?       // ≤4
  let championsMode: Bool?        // champions_mode
  // ⚠️ REMOVED (web change, 2026-06): no `active_team_id`. Saved teams are
  // referenced by NAME in chat (the agent calls list_teams → get_team), so the
  // client sends no team id. Do NOT add this field back.
}
struct ChatImage: Encodable, Sendable {
  let mimeType: String           // best-effort; server re-sniffs by magic bytes
  let data: String               // RAW base64, no "data:" prefix
}
```

### SSE events — mirrors `SseEventName` in `sse-types.ts`
```swift
enum SSEEvent: Sendable {                 // decoded from `event:`/`data:` frames
  case toolActivity(tool: String, label: String)   // "tool_activity"
  case answerStart                                  // "answer_start" (re-emit reset)
  case answerDelta(text: String)                    // "answer_delta"
  case answer(OakAnswer)                            // "answer" — terminal, authoritative
  case error(code: String, message: String, status: Int?) // "error" — transport faults only
}
```
The `: keep-alive` SSE comment (every 15s) is ignored by the parser.

### OakAnswer — mirrors `oakAnswerSchema` in `schemas.ts` (the field-by-field render target)
```swift
struct OakAnswer: Codable, Sendable, Equatable {
  enum Status: String, Codable { case answered, clarificationNeeded = "clarification_needed",
                                       resolutionFailed = "resolution_failed",
                                       insufficientData = "insufficient_data" }
  let status: Status
  let answerMarkdown: String          // answer_markdown
  let reasoningMarkdown: String       // reasoning_markdown
  let citations: [Citation]
  let inferences: [Inference]
  let generationBasis: GenerationBasis // generation_basis
  // optional, render-if-present:
  let subjects: [Subject]?
  let candidates: Candidates?
  let damageCalc: DamageCalc?          // damage_calc
  let suggestions: [String]?
  let question: ClarifyQuestion?
  let uncertaintyFlags: [String]?      // uncertainty_flags
  // team-builder fields (server-stamped):
  let proposedTeam: ProposedTeam?      // proposed_team
  let savedTeam: SavedTeamRef?         // saved_team
  let proposedTeamWarnings: [TeamWarning]? // proposed_team_warnings
}

struct Citation: Codable, Sendable, Equatable { let source: String; let detail: String; let endpointUrl: String? }
struct Inference: Codable, Sendable, Equatable {
  enum Confidence: String, Codable { case high, medium, low }
  let claim: String; let confidence: Confidence; let note: String?
}
struct GenerationBasis: Codable, Sendable, Equatable { let generation: String; let fallback: Bool; let note: String? }
struct Subject: Codable, Sendable, Equatable {
  let name: String; let dexNumber: Int?; let spriteUrl: String
  let types: [String]; let isFallback: Bool; let sourceGeneration: String?
}
struct Candidates: Codable, Sendable, Equatable {
  let totalCount: Int; let truncated: Bool; let sort: String?; let shown: [CandidateRow]
}
struct CandidateRow: Codable, Sendable, Equatable {
  let name: String; let dexNumber: Int?; let spriteUrl: String?; let types: [String]
  let baseStats: BaseStats?; let keyStats: [String: JSONScalar]?; let ability: String?
}
struct BaseStats: Codable, Sendable, Equatable { let hp, atk, def, spa, spd, spe: Int }
struct DamageCalc: Codable, Sendable, Equatable {
  let assumptions: [String: JSONScalar]; let result: [String: JSONScalar]
  let isEstimate: Bool; let breakdown: String?     // is_estimate always true
}
struct ClarifyQuestion: Codable, Sendable, Equatable { let options: [ClarifyOption] }
struct ClarifyOption: Codable, Sendable, Equatable { let label: String; let description: String? }
struct ProposedTeam: Codable, Sendable, Equatable { let name: String; let format: Format; let members: [TeamMember] }
struct SavedTeamRef: Codable, Sendable, Equatable { let id: String; let name: String; let format: Format }
```

`JSONScalar` is a small `Codable` enum wrapping `string | number | bool | null` for the
free-form `key_stats` / `assumptions` / `result` maps (the server types them as
`Record<string, scalar>`). It must round-trip unknown scalar shapes without loss.

### Team model — mirrors `team-schema.ts`
```swift
enum Format: String, Codable, Sendable, CaseIterable { case scarletViolet = "scarlet-violet", champions }

struct TeamMember: Codable, Sendable, Equatable {
  let species: String?; let ability: String?; let item: String?
  let moves: [String]                 // 0…4
  let nature: String?
  let evs: StatSpread; let ivs: StatSpread
  let teraType: String?               // tera_type
  let level: Int                      // 1…100, default 50
  let nickname: String?; let gender: Gender?; let shiny: Bool?
  enum Gender: String, Codable { case male = "M", female = "F", neutral = "N" }
}
struct StatSpread: Codable, Sendable, Equatable { let hp, atk, def, spa, spd, spe: Int }

struct TeamWarning: Codable, Sendable, Equatable {
  enum Code: String, Codable {
    case incomplete, evTotalExceeded = "ev_total_exceeded", evStatExceeded = "ev_stat_exceeded",
         ivOutOfRange = "iv_out_of_range", speciesIllegal = "species_illegal",
         abilityNotForSpecies = "ability_not_for_species", itemIllegal = "item_illegal",
         moveNotInLearnset = "move_not_in_learnset", duplicateSpecies = "duplicate_species",
         duplicateItem = "duplicate_item"
  }
  let code: Code; let message: String; let slot: Int?; let field: String?
}
struct TeamValidationResult: Codable, Sendable, Equatable { let warnings: [TeamWarning] /* mirror server shape */ }
```

### Response envelopes (one per endpoint group; see `api-design.md` for full list)
```swift
struct AuthVerifyResponse: Decodable { let ok: Bool; let email: String; let created: Bool; let token: String } // token is the NEW field
struct MeResponse: Decodable { let signedIn: Bool; let email: String? }
struct ConversationSummary: Decodable, Sendable, Identifiable {
  let id: String; let title: String; let format: Format; let pinned: Bool
  let createdAt: Int64; let updatedAt: Int64           // epoch ms
}
struct ConversationDetail: Decodable, Sendable {
  let id: String; let title: String; let format: Format; let pinned: Bool
  let turns: [ChatTurn]
  // ⚠️ REMOVED (web change, 2026-06): GET no longer returns `active_team_id`.
}
enum ChatTurn: Decodable, Sendable, Identifiable {     // discriminated on "role"
  case user(id: String, content: String)
  case assistant(id: String, answer: OakAnswer)
}
struct Team: Decodable, Sendable, Identifiable {
  let id: String; let name: String; let format: Format; let members: [TeamMember]
  let createdAt: Int64; let updatedAt: Int64
}
struct EntityArtifact: Decodable, Sendable { /* discriminatedUnion on "kind"; see api-design.md */ }
struct APIErrorBody: Decodable, Sendable { let code: String; let message: String; let status: Int? }
```

## B. On-device state (no durable business cache — online-only, M-OOS-6)

| State | Store | Notes |
|---|---|---|
| Session token | **Keychain** (`kSecClassGenericPassword`, service `us.optiwise.oak`, account `session-token`) | Written on verify, read on every request, deleted on signout/account-deletion. `kSecAttrAccessibleAfterFirstUnlock`. |
| Signed-in email (display) | Keychain or UserDefaults | Convenience for the account screen; cleared with the token. |
| Champions-mode default | `UserDefaults` | The toggle's persisted default; per-conversation mode still derives from the conversation's format on resume. |
| Current guest session id | `UserDefaults` (or in-memory) | A client UUID for the active guest thread; rotated on "new conversation"/signout. |
| Guest thread turns | **In-memory only** (`@Observable` AppState) | Never persisted; used for the guest→sign-in `import` payload. Mirrors web guest behavior. |
| Last-used model / scope | n/a | Model is operator-controlled server-side; not stored or exposed (M-BR-CHAT-2). |

No Core Data / SwiftData / on-disk conversation or team cache in v1. History and teams
are always fetched live; offline shows a connection state (M-NFR-1).

## C. Backend schema touchpoints (existing Postgres — `web/src/data/schema.ts`)

No new tables. Two touchpoints:

1. **Account deletion cascade** (`DELETE /api/auth/account`). Within one transaction,
   delete rows for the signed-in `account.id`, in FK-safe order:
   `message` → `conversation` → `team` → `auth_session` → `otp_code` (if present) →
   `account`. Add a `deleteAccount(accountId)` to `accounts-repo.ts` (the audit found
   none exists). Verify FK definitions; prefer `ON DELETE CASCADE` where already
   present, otherwise delete explicitly in order. Idempotent.

2. **Bearer token reuse** (no schema change). The existing `auth_session` table already
   stores a `token_hash` (SHA-256 of a 256-bit token). The Bearer adaptation reuses the
   exact same token/lifecycle — the only change is *where the client carries it*
   (`Authorization` header vs `Cookie`). `verify` returns the already-generated raw
   token in its body; the resolver hashes a Bearer token identically to a cookie token.
   See ADR-2.

## ERD

The client holds no relational data; see `web/`'s existing schema for the server ERD.
Client-side, the only "relationship" is reference-by-id over the wire:
`ChatRequest.sessionId == Conversation.id` (on resume), resolved by the backend.

> ⚠️ The former `Conversation.activeTeamId → Team.id` link was **removed** (web
> change, 2026-06): the `conversation.active_team_id` column is dropped and saved
> teams are referenced by name in chat. No client-held team id remains.

## Migrations / Schema Notes

- The deletion cascade may need a Drizzle migration only if FK `ON DELETE` actions are
  added; if deletes are done explicitly in repo code, no migration is required.
- Re-deploy + (no) re-ingest: these changes don't touch the `@pkmn` index, so no
  re-ingest is needed — just `db:migrate` (if a migration is added) and `fly deploy`.
