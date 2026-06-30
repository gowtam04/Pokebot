import Foundation

/// The team-builder seam (component-design.md "Services layer"; history-and-teams.md
/// B. — M-TEAM-US-1…6, M-BR-T1…T6). View models depend on this **protocol** (never
/// `LiveTeamService`) so they unit-test against `FakeTeamService`.
///
/// Teams are **signed-in only** (M-BR-T1): every call attaches the Bearer token, and
/// the routes return `401` (``OakError/unauthorized``) for a guest — the app gates the
/// Teams surface behind a sign-in prompt rather than surfacing the error. Each method
/// is `async throws` and surfaces failures as the single typed ``OakError``; in-domain
/// results (validation warnings, import notes) ride back as normal values, never thrown
/// (warn-but-allow, M-BR-T3).
///
/// Contract-fidelity note (the TS source wins, CLAUDE.md): the list route
/// (`GET /api/teams`) returns the repo's **`TeamSummary`** projection
/// (`web/src/data/repos/team-repo.ts` — id/name/format/memberCount/incomplete/species/
/// updatedAt), NOT the full `Team` with members. So ``list(format:)`` returns
/// `[TeamSummary]` (a deliberate divergence from component-design.md's `[Team]`, which
/// can't decode the summary wire); the full team + members is fetched on demand via
/// ``get(id:)`` when the editor opens.
protocol TeamService: Sendable {
  /// Lists the account's teams, most-recently-edited first
  /// (`GET /api/teams?format=`). `format` filters by data scope (`nil` = all).
  /// Returns the cheap completeness summaries the library list renders (M-TEAM-US-6).
  func list(format: Format?) async throws -> [TeamSummary]

  /// Loads one full team with its members + computed warnings
  /// (`GET /api/teams/{id}`, M-AC-T1.2/AC-T5.4). Throws `.http(404)` for a missing /
  /// not-owned team (isolation, M-BR-T1).
  func get(id: String) async throws -> (team: Team, validation: TeamValidationResult)

  /// Creates a team (`POST /api/teams`, M-TEAM-US-1). Also the "apply a proposed team
  /// as a new saved team" path (M-TEAM-US-4 / M-BR-T4). `name == nil` ⇒ server default;
  /// `members == nil` ⇒ an empty team (a partial/empty team is valid, M-BR-T4).
  /// Returns the created team and its warn-but-allow validation.
  func create(
    format: Format,
    name: String?,
    members: [TeamMember]?
  ) async throws -> (team: Team, validation: TeamValidationResult)

  /// Replaces a team's name and/or members (`PUT /api/teams/{id}`, M-TEAM-US-1). At
  /// least one of `name`/`members` must be non-nil. The format is fixed for a team's
  /// life (M-BR-T2) and is never changed here. Returns the updated team + validation.
  func update(
    id: String,
    name: String?,
    members: [TeamMember]?
  ) async throws -> (team: Team, validation: TeamValidationResult)

  /// Permanently deletes a team (`DELETE /api/teams/{id}`, M-TEAM-US-6). A `404`
  /// (already gone / not owned) is treated as success by the caller for idempotent UX.
  func delete(id: String) async throws

  /// Clones a team into a fresh, independent copy named "<name> copy"
  /// (`POST /api/teams/{id}/duplicate`, M-TEAM-US-6). Returns the new team + validation.
  func duplicate(id: String) async throws -> (team: Team, validation: TeamValidationResult)

  /// Imports a Showdown paste into a new saved team (`POST /api/teams/import`,
  /// M-TEAM-US-2). Never aborts wholesale: whatever resolves becomes the team; the rest
  /// comes back as ``ImportNote``s (resolve-or-clarify). Returns the team, its
  /// validation, and the import notes.
  func importPaste(
    format: Format,
    paste: String
  ) async throws -> (team: Team, validation: TeamValidationResult, notes: [ImportNote])

  /// Renders a saved team as Showdown paste text (`GET /api/teams/{id}/export`,
  /// M-TEAM-US-2). Round-trips through ``importPaste(format:paste:)`` (M-BR-T5).
  func exportPaste(id: String) async throws -> String
}

// MARK: - List projection

/// The list-view projection of a saved team — `GET /api/teams`
/// (`{ teams: TeamSummary[] }`). A faithful mirror of the repo `TeamSummary`
/// (`web/src/data/repos/team-repo.ts`): no full members, just a cheap completeness
/// summary for the library list (name, format, the filled-slot species, a member
/// count, and an `incomplete` flag). All keys match the wire 1:1 (the `json` helper
/// stringifies the camelCase repo object verbatim), so no `CodingKeys` are needed.
struct TeamSummary: Decodable, Sendable, Equatable, Identifiable {
  /// The team's id (stable; the editor/duplicate/delete key).
  let id: String
  /// The user-facing team name.
  let name: String
  /// The team's fixed data-scope format (M-BR-T2).
  let format: Format
  /// How many member slots are filled (0…6).
  let memberCount: Int
  /// `true` when the team has <6 members or any slot is missing a species / its 4th
  /// move — surfaced as a glanceable "incomplete" hint (informational, M-BR-T4).
  let incomplete: Bool
  /// Species slugs of the filled slots (empty slots omitted; order follows the slots).
  let species: [String]
  /// Epoch-ms of the last edit (camelCase wire key). Used for the "edited" stamp.
  let updatedAt: Int64
}

// MARK: - Import notes (resolve-or-clarify)

/// One resolve-or-clarify note surfaced after a Showdown import
/// (`POST /api/teams/import` → `notes`). A faithful mirror of `ImportNote` in
/// `web/src/server/teams/import-export.ts`: a paste entry that did not resolve to a
/// known slug (the matching member field was left empty / the move dropped) — never an
/// error, just advisory (M-AC-T2.1). All keys match the wire 1:1.
struct ImportNote: Decodable, Sendable, Equatable, Identifiable {
  /// What kind of name failed to resolve.
  enum Kind: String, Decodable, Sendable, Equatable {
    case pokemon
    case move
    case ability
    case item
    case nature
    case tera
  }

  /// 0-based slot the note applies to.
  let slot: Int
  /// Which field on that slot the note concerns.
  let kind: Kind
  /// The raw text that was in the paste.
  let raw: String
  /// The slug it was fuzzily resolved to, when resolution still succeeded (else `nil`).
  let resolvedTo: String?
  /// Human-readable explanation to show the user.
  let message: String

  /// A stable identity for `ForEach` (slot + kind + raw is unique within one import).
  var id: String { "\(slot)-\(kind.rawValue)-\(raw)" }
}

// MARK: - Live implementation

/// Production ``TeamService`` over ``OakAPIClient``. A value type holding one
/// immutable actor reference, so it is `Sendable` without ceremony. Wire shapes are
/// decoded into the team DTOs (`Team`/`TeamMember`/`TeamWarning`); error mapping
/// happens inside ``OakAPIClient``.
struct LiveTeamService: TeamService {
  private let apiClient: OakAPIClient

  init(apiClient: OakAPIClient) {
    self.apiClient = apiClient
  }

  func list(format: Format?) async throws -> [TeamSummary] {
    var queryItems: [URLQueryItem] = []
    if let format {
      queryItems.append(URLQueryItem(name: "format", value: format.rawValue))
    }
    let endpoint = Endpoint(
      method: .get,
      path: "/api/teams",
      queryItems: queryItems,
      requiresAuth: true
    )
    return try await apiClient.send(endpoint, as: TeamsListEnvelope.self).teams
  }

  func get(id: String) async throws -> (team: Team, validation: TeamValidationResult) {
    let endpoint = Endpoint(
      method: .get,
      path: "/api/teams/\(id)",
      requiresAuth: true
    )
    let envelope = try await apiClient.send(endpoint, as: TeamEnvelope.self)
    return (envelope.team, envelope.validation)
  }

  func create(
    format: Format,
    name: String?,
    members: [TeamMember]?
  ) async throws -> (team: Team, validation: TeamValidationResult) {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/teams",
      body: CreateTeamBody(format: format, name: name, members: members),
      requiresAuth: true
    )
    let envelope = try await apiClient.send(endpoint, as: TeamEnvelope.self)
    return (envelope.team, envelope.validation)
  }

  func update(
    id: String,
    name: String?,
    members: [TeamMember]?
  ) async throws -> (team: Team, validation: TeamValidationResult) {
    let endpoint = Endpoint(
      method: .put,
      path: "/api/teams/\(id)",
      body: UpdateTeamBody(name: name, members: members),
      requiresAuth: true
    )
    let envelope = try await apiClient.send(endpoint, as: TeamEnvelope.self)
    return (envelope.team, envelope.validation)
  }

  func delete(id: String) async throws {
    let endpoint = Endpoint(
      method: .delete,
      path: "/api/teams/\(id)",
      requiresAuth: true
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func duplicate(id: String) async throws -> (team: Team, validation: TeamValidationResult) {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/teams/\(id)/duplicate",
      requiresAuth: true
    )
    let envelope = try await apiClient.send(endpoint, as: TeamEnvelope.self)
    return (envelope.team, envelope.validation)
  }

  func importPaste(
    format: Format,
    paste: String
  ) async throws -> (team: Team, validation: TeamValidationResult, notes: [ImportNote]) {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/teams/import",
      body: ImportBody(format: format, paste: paste),
      requiresAuth: true
    )
    let envelope = try await apiClient.send(endpoint, as: ImportEnvelope.self)
    return (envelope.team, envelope.validation, envelope.notes)
  }

  func exportPaste(id: String) async throws -> String {
    let endpoint = Endpoint(
      method: .get,
      path: "/api/teams/\(id)/export",
      requiresAuth: true
    )
    return try await apiClient.send(endpoint, as: ExportEnvelope.self).paste
  }
}

// MARK: - Wire bodies & envelopes (private to the service)

/// `GET /api/teams` → `{ teams: TeamSummary[] }`.
private struct TeamsListEnvelope: Decodable, Sendable {
  let teams: [TeamSummary]
}

/// The `{ team, validation }` envelope returned by create / get / update / duplicate.
/// `validation` decodes a bare `TeamWarning[]` via ``TeamValidationResult``'s
/// single-value container.
private struct TeamEnvelope: Decodable, Sendable {
  let team: Team
  let validation: TeamValidationResult
}

/// `POST /api/teams/import` → `{ team, validation, notes }`.
private struct ImportEnvelope: Decodable, Sendable {
  let team: Team
  let validation: TeamValidationResult
  let notes: [ImportNote]
}

/// `GET /api/teams/{id}/export` → `{ paste }`.
private struct ExportEnvelope: Decodable, Sendable {
  let paste: String
}

/// `POST /api/teams` body (`{ format, name?, members? }`). `name`/`members` are
/// `.optional()` server-side, so the synthesized `encode(to:)` (which `encodeIfPresent`s
/// optionals) is correct here — an absent `name` defaults server-side and absent
/// `members` becomes an empty team. `format` is always sent. `TeamMember` carries its
/// own wire-faithful `encode(to:)`.
private struct CreateTeamBody: Encodable, Sendable {
  let format: Format
  let name: String?
  let members: [TeamMember]?
}

/// `PUT /api/teams/{id}` body (`{ name?, members? }`, at least one). Synthesized
/// `encodeIfPresent` omits the untouched field so a name-only or members-only update
/// sends just that field.
private struct UpdateTeamBody: Encodable, Sendable {
  let name: String?
  let members: [TeamMember]?
}

/// `POST /api/teams/import` body (`{ format, paste }`).
private struct ImportBody: Encodable, Sendable {
  let format: Format
  let paste: String
}
