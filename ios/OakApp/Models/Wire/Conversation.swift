import Foundation

// Conversation & saved-team wire DTOs — Decodable mirrors of the conversations /
// teams route responses.
//
// Contract fidelity (CLAUDE.md "the TS source wins"): field names below were
// confirmed against the ACTUAL route output, not data-model.md. The `json`
// helper (web/src/app/api/auth/_lib/http.ts) `JSON.stringify`s the repo objects
// verbatim — it does NOT snake-case keys — so the wire keys are whatever the
// repos emit. Two divergences from data-model.md, taken from the TS source:
//   - GET /api/conversations returns the repo `ConversationSummary`
//     ({ id, title, format, pinned, updatedAt }) — `updatedAt` is camelCase and
//     there is NO `created_at` field, so `ConversationSummary` has only
//     `updatedAt` (no `createdAt`).
//   - The `team` envelope (GET /api/teams/{id}, etc.) emits camelCase
//     `createdAt`/`updatedAt` (repo `Team`), not snake_case.
//
// `Format`, `OakAnswer`, and `TeamMember` live in sibling files in this same
// module (no import needed).

/// List-view projection of a saved conversation — `GET /api/conversations`
/// (`{ conversations: ConversationSummary[] }`). Mirrors the repo
/// `ConversationSummary` (web/src/data/repos/conversation-repo.ts): no full
/// turns, and **no `created_at`** — the list only carries `updatedAt`.
///
/// `Hashable` so a summary can ride a `NavigationStack` path as the value that
/// identifies which saved conversation to open (the Chat tab's `existing` route).
/// `Format` is an associated-value-free enum and so is already `Hashable`, which
/// lets the struct synthesize `Hashable` from its stored fields.
struct ConversationSummary: Decodable, Sendable, Identifiable, Hashable {
  let id: String
  let title: String
  let format: Format
  let pinned: Bool
  /// Epoch-ms of last activity. Wire key is camelCase `updatedAt`.
  let updatedAt: Int64

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case format
    case pinned
    case updatedAt
  }
}

/// A full conversation with rehydrated turns — `GET /api/conversations/{id}`
/// (`{ id, title, format, pinned, turns }`).
struct ConversationDetail: Decodable, Sendable {
  let id: String
  let title: String
  let format: Format
  let pinned: Bool
  let turns: [ChatTurn]

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case format
    case pinned
    case turns
  }
}

/// One entry in a rehydrated conversation thread, discriminated on `role`.
/// A user turn carries its raw text; an assistant turn carries the full
/// `OakAnswer` so it re-renders through the normal answer-card tree.
enum ChatTurn: Decodable, Sendable, Identifiable {
  case user(id: String, content: String)
  case assistant(id: String, answer: OakAnswer)

  /// Stable per-turn id (the stored message id) for `ForEach` / diffing.
  var id: String {
    switch self {
    case let .user(id, _): return id
    case let .assistant(id, _): return id
    }
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case role
    case content
    case answer
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let id = try container.decode(String.self, forKey: .id)
    let role = try container.decode(String.self, forKey: .role)
    switch role {
    case "user":
      let content = try container.decode(String.self, forKey: .content)
      self = .user(id: id, content: content)
    case "assistant":
      let answer = try container.decode(OakAnswer.self, forKey: .answer)
      self = .assistant(id: id, answer: answer)
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .role,
        in: container,
        debugDescription: "Unknown ChatTurn role \"\(role)\"."
      )
    }
  }
}

/// A saved team with its full members — the `team` envelope returned by the
/// teams routes (`{ team, validation }`, `{ teams: Team[] }`). Mirrors the repo
/// `Team` (web/src/data/repos/team-repo.ts); its extra `accountId` wire field is
/// intentionally not decoded. `createdAt`/`updatedAt` are camelCase epoch-ms.
struct Team: Decodable, Sendable, Identifiable {
  let id: String
  let name: String
  let format: Format
  let members: [TeamMember]
  let createdAt: Int64
  let updatedAt: Int64

  enum CodingKeys: String, CodingKey {
    case id
    case name
    case format
    case members
    case createdAt
    case updatedAt
  }
}
