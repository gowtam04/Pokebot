import Foundation

/// The artifact-viewer data seam (component-design.md "Services layer"; artifact-viewer.md
/// M-ART-US-1/3, M-BR-ART-4). The bottom-sheet viewer reads entity profiles and saved-team
/// detail through this **protocol** so ``ArtifactViewModel`` unit-tests against
/// ``FakeArtifactService``.
///
/// The one deliberate exception to the app's error policy (conventions.md "Error handling",
/// ADR-8): every method **returns `nil` instead of throwing**. A missing or unreachable
/// artifact must never break the viewer — there is no place to surface a thrown `OakError`
/// inside a co-visible sheet, so transport/HTTP faults collapse to `nil` and the viewer shows
/// an honest "couldn't load" state (M-BR-ART-5: the sheet must never block the conversation).
///
/// In-domain misses ride back as **values, not nil** where the wire models them: the entity
/// endpoint returns all of `ok` / `not_found` / `unavailable` as a 200, so ``entity(kind:q:format:)``
/// returns the decoded ``EntityArtifact`` (any of the three arms) and reserves `nil` for a real
/// transport/HTTP/decode fault. ``ArtifactViewModel`` renders the full entity for `ok` and a
/// graceful miss for `not_found`/`unavailable`/`nil` alike — so the sheet survives every outcome.
protocol ArtifactService: Sendable {
  /// Fetches one entity's full profile for the active format (`GET /api/entity`, M-BR-ART-4).
  /// Returns the decoded ``EntityArtifact`` (`ok`/`not_found`/`unavailable`) on a 200, or `nil`
  /// on a transport/HTTP/decode fault. Never throws.
  func entity(kind: EntityKind, q: String, format: Format) async -> EntityArtifact?

  /// Loads one saved team with its members + computed warnings (`GET /api/teams/{id}`) for a
  /// saved-team artifact. Returns `nil` when the team can't be loaded (guest 401, not-owned 404,
  /// transport). Never throws.
  func savedTeam(id: String) async -> (team: Team, validation: TeamValidationResult)?
}

// MARK: - Live implementation

/// Production ``ArtifactService`` over ``OakAPIClient``. A value type holding one immutable
/// actor reference, so it is `Sendable` without ceremony. It catches every ``OakError`` the
/// client throws and maps it to `nil`, logging only a non-sensitive label (never the query,
/// token, or payload — conventions.md "Logging").
struct LiveArtifactService: ArtifactService {
  private let apiClient: OakAPIClient

  init(apiClient: OakAPIClient) {
    self.apiClient = apiClient
  }

  func entity(kind: EntityKind, q: String, format: Format) async -> EntityArtifact? {
    let endpoint = Endpoint(
      method: .get,
      path: "/api/entity",
      queryItems: [
        URLQueryItem(name: "kind", value: kind.rawValue),
        URLQueryItem(name: "q", value: q),
        URLQueryItem(name: "format", value: format.rawValue),
      ],
      requiresAuth: false
    )
    do {
      return try await apiClient.send(endpoint, as: EntityArtifact.self)
    } catch {
      Log.network.error("entity artifact unavailable (kind \(kind.rawValue, privacy: .public))")
      return nil
    }
  }

  func savedTeam(id: String) async -> (team: Team, validation: TeamValidationResult)? {
    let endpoint = Endpoint(
      method: .get,
      path: "/api/teams/\(id)",
      requiresAuth: true
    )
    do {
      let envelope = try await apiClient.send(endpoint, as: SavedTeamEnvelope.self)
      return (envelope.team, envelope.validation)
    } catch {
      Log.network.error("saved-team artifact unavailable")
      return nil
    }
  }
}

// MARK: - Wire envelope (private to the service)

/// The `{ team, validation }` envelope returned by `GET /api/teams/{id}`. `validation` decodes a
/// bare `TeamWarning[]` via ``TeamValidationResult``'s single-value container.
private struct SavedTeamEnvelope: Decodable, Sendable {
  let team: Team
  let validation: TeamValidationResult
}
