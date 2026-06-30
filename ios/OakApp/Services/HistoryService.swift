import Foundation

/// The durable chat-history seam (component-design.md "Services layer";
/// history-and-teams.md A. — M-HIST-US-1/2/3, M-BR-H1…H4). View models depend on
/// this **protocol** (never `LiveHistoryService`) so they unit-test against
/// `FakeHistoryService`.
///
/// History is **signed-in only** (M-BR-H1): every call attaches the Bearer token
/// when present. The list route is graceful — a guest (no token) gets an empty
/// list, never an error — so ``list(query:format:)`` returns `[]` for guests; the
/// per-conversation reads/writes return `401` (``OakError/unauthorized``) for a
/// guest and the app gates them behind a sign-in prompt. Every method is
/// `async throws` and surfaces failures as the single typed ``OakError`` — except
/// the in-domain "nothing to import" case, which is a normal `nil` result.
protocol HistoryService: Sendable {
  /// Lists the signed-in account's conversations, pinned first then most-recent
  /// (`GET /api/conversations`). `query` filters by title/message text (`?q=`),
  /// `format` filters by data scope (`?format=`). Returns `[]` for guests
  /// (M-BR-H1) — the route answers a guest with `{ conversations: [] }` (200).
  func list(query: String?, format: Format?) async throws -> [ConversationSummary]

  /// Loads one full conversation with its rehydrated turns
  /// (`GET /api/conversations/{id}`), so earlier answers re-render with full
  /// fidelity (M-AC-H3.2). Throws `.unauthorized` for a guest and `.http(404)` for
  /// a conversation that is missing or not owned (isolation, M-BR-H2).
  func get(id: String) async throws -> ConversationDetail

  /// Renames a conversation (`PATCH /api/conversations/{id}` with `{ title }`,
  /// M-AC-H2.4). The server trims + bounds the title (1–120 chars).
  func rename(id: String, title: String) async throws

  /// Pins or unpins a conversation (`PATCH …` with `{ pinned }`, M-AC-H2.4).
  func setPinned(id: String, pinned: Bool) async throws

  /// Binds (or clears) the conversation's active team (`PATCH …` with
  /// `{ active_team_id }`, M-TEAM-US-5 / reconciliation #1). `teamId == nil`
  /// clears it; a non-nil id is validated server-side (ownership + format match)
  /// and silently ignored if invalid — never an error (warn-but-allow).
  func setActiveTeam(id: String, teamId: String?) async throws

  /// Permanently deletes a conversation (`DELETE /api/conversations/{id}`,
  /// M-AC-H2.4). The server returns `404` for an already-gone or not-owned id; the
  /// caller (the list view model) treats that as success for idempotent UX.
  func delete(id: String) async throws

  /// The guest→sign-in bulk save (`POST /api/conversations/import`, M-ACCT-US-4).
  /// Uploads the in-memory guest thread's turns under `sessionId`; the returned id
  /// becomes the active conversation. An empty thread imports nothing and returns
  /// `nil` (a normal value, not an error).
  func importGuestThread(
    sessionId: String,
    championsMode: Bool,
    turns: [ChatTurn]
  ) async throws -> String?
}

/// Production ``HistoryService`` over ``OakAPIClient``. A value type holding one
/// immutable actor reference, so it is `Sendable` without ceremony. Wire shapes are
/// decoded into the conversation DTOs in `Conversation.swift`; error mapping happens
/// inside ``OakAPIClient``.
struct LiveHistoryService: HistoryService {
  private let apiClient: OakAPIClient

  init(apiClient: OakAPIClient) {
    self.apiClient = apiClient
  }

  func list(query: String?, format: Format?) async throws -> [ConversationSummary] {
    var queryItems: [URLQueryItem] = []
    if let query {
      let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        queryItems.append(URLQueryItem(name: "q", value: trimmed))
      }
    }
    if let format {
      queryItems.append(URLQueryItem(name: "format", value: format.rawValue))
    }
    let endpoint = Endpoint(
      method: .get,
      path: "/api/conversations",
      queryItems: queryItems,
      requiresAuth: true
    )
    let response = try await apiClient.send(endpoint, as: ConversationListResponse.self)
    return response.conversations
  }

  func get(id: String) async throws -> ConversationDetail {
    let endpoint = Endpoint(
      method: .get,
      path: "/api/conversations/\(id)",
      requiresAuth: true
    )
    return try await apiClient.send(endpoint, as: ConversationDetail.self)
  }

  func rename(id: String, title: String) async throws {
    let endpoint = Endpoint(
      method: .patch,
      path: "/api/conversations/\(id)",
      body: RenameBody(title: title),
      requiresAuth: true
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func setPinned(id: String, pinned: Bool) async throws {
    let endpoint = Endpoint(
      method: .patch,
      path: "/api/conversations/\(id)",
      body: PinnedBody(pinned: pinned),
      requiresAuth: true
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func setActiveTeam(id: String, teamId: String?) async throws {
    let endpoint = Endpoint(
      method: .patch,
      path: "/api/conversations/\(id)",
      body: ActiveTeamBody(activeTeamId: teamId),
      requiresAuth: true
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func delete(id: String) async throws {
    let endpoint = Endpoint(
      method: .delete,
      path: "/api/conversations/\(id)",
      requiresAuth: true
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func importGuestThread(
    sessionId: String,
    championsMode: Bool,
    turns: [ChatTurn]
  ) async throws -> String? {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/conversations/import",
      body: ImportRequestBody(
        sessionId: sessionId,
        championsMode: championsMode,
        turns: turns.map(ImportTurn.init)
      ),
      requiresAuth: true
    )
    let response = try await apiClient.send(endpoint, as: ImportResponse.self)
    return response.id
  }
}

// MARK: - Wire bodies & envelopes (private to the service)

/// `GET /api/conversations` → `{ conversations: ConversationSummary[] }`.
private struct ConversationListResponse: Decodable, Sendable {
  let conversations: [ConversationSummary]
}

/// `POST /api/conversations/import` → `{ id: string | null }`.
private struct ImportResponse: Decodable, Sendable {
  let id: String?
}

/// `PATCH …` body for a rename (`{ title }`). `title` is identical on the wire.
private struct RenameBody: Encodable, Sendable {
  let title: String
}

/// `PATCH …` body for a pin toggle (`{ pinned }`). `pinned` is identical on the wire.
private struct PinnedBody: Encodable, Sendable {
  let pinned: Bool
}

/// `PATCH …` body for setting/clearing the active team. `active_team_id` must be
/// PRESENT on the wire as either a string (select) or explicit `null` (clear) — the
/// route distinguishes "clear" (null) from "no change" (key absent). Swift's
/// synthesized `encode` would `encodeIfPresent` (omitting nil), which would send an
/// empty body and 400, so `encode(to:)` is hand-written to emit null when nil.
private struct ActiveTeamBody: Encodable, Sendable {
  let activeTeamId: String?

  enum CodingKeys: String, CodingKey {
    case activeTeamId = "active_team_id"
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(activeTeamId, forKey: .activeTeamId)
  }
}

/// `POST /api/conversations/import` body (`{ session_id, champions_mode, turns }`).
private struct ImportRequestBody: Encodable, Sendable {
  let sessionId: String
  let championsMode: Bool
  let turns: [ImportTurn]

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case championsMode = "champions_mode"
    case turns
  }
}

/// One import turn on the wire, discriminated by `role`: a user turn carries its
/// raw `content`; an assistant turn carries the full `answer` (an ``OakAnswer``,
/// validated server-side against `oakAnswerSchema`). The wire ``ChatTurn`` is
/// decode-only, so this is the dedicated **encode** mirror (kept out of the shared
/// DTO file so `Conversation.swift` stays a pure decode target).
private struct ImportTurn: Encodable, Sendable {
  let turn: ChatTurn

  init(_ turn: ChatTurn) {
    self.turn = turn
  }

  enum CodingKeys: String, CodingKey {
    case id
    case role
    case content
    case answer
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch turn {
    case let .user(id, content):
      try container.encode(id, forKey: .id)
      try container.encode("user", forKey: .role)
      try container.encode(content, forKey: .content)
    case let .assistant(id, answer):
      try container.encode(id, forKey: .id)
      try container.encode("assistant", forKey: .role)
      try container.encode(answer, forKey: .answer)
    }
  }
}
