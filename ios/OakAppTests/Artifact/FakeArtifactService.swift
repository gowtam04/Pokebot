import Foundation

@testable import OakApp

/// In-memory ``ArtifactService`` test double (testing-strategy.md "Mocking policy": service
/// protocols are faked for view-model unit tests). It returns canned results and records the
/// calls so tests can assert both the resolved state and the request shape — in particular that a
/// **proposed-team** artifact makes NO fetch (M-AC-A4.1) while entity/saved-team artifacts do.
///
/// Mirrors the real ``ArtifactService`` contract: methods are `async` and **never throw** — a
/// miss/transport fault is modeled by returning `nil` (or a `not_found`/`unavailable`
/// ``EntityArtifact`` value).
///
/// `@unchecked Sendable`: the recording state is mutable, but every test drives it serially from
/// the main actor and `await`s each call, so there is no concurrent access (matches the other
/// `Fake…` services).
final class FakeArtifactService: ArtifactService, @unchecked Sendable {
  /// Returned by the next ``entity(kind:q:format:)``. `nil` models a transport/HTTP fault.
  var entityResult: EntityArtifact?
  /// Returned by the next ``savedTeam(id:)``. `nil` models "couldn't load".
  var savedTeamResult: (team: Team, validation: TeamValidationResult)?

  private(set) var entityCallCount = 0
  private(set) var lastEntityKind: EntityKind?
  private(set) var lastEntityQuery: String?
  private(set) var lastEntityFormat: Format?

  private(set) var savedTeamCallCount = 0
  private(set) var lastSavedTeamId: String?

  init(
    entityResult: EntityArtifact? = nil,
    savedTeamResult: (team: Team, validation: TeamValidationResult)? = nil
  ) {
    self.entityResult = entityResult
    self.savedTeamResult = savedTeamResult
  }

  func entity(kind: EntityKind, q: String, format: Format) async -> EntityArtifact? {
    entityCallCount += 1
    lastEntityKind = kind
    lastEntityQuery = q
    lastEntityFormat = format
    return entityResult
  }

  func savedTeam(id: String) async -> (team: Team, validation: TeamValidationResult)? {
    savedTeamCallCount += 1
    lastSavedTeamId = id
    return savedTeamResult
  }
}
