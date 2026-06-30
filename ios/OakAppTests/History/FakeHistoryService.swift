import Foundation

@testable import OakApp

/// In-memory ``HistoryService`` test double (testing-strategy.md "Mocking policy":
/// service protocols are faked for view-model unit tests). Each method's outcome is
/// configurable, and calls are recorded so tests can assert the request shape — the
/// search `query`/`format`, the mutation arguments, and the guest-import payload.
///
/// `@unchecked Sendable`: the recording/config state is mutable, but every test
/// drives it serially from the main actor and `await`s each call, so there is no
/// concurrent access — the standard test-fake pattern.
final class FakeHistoryService: HistoryService, @unchecked Sendable {
  // MARK: Configurable outcomes

  var listResult: Result<[ConversationSummary], OakError> = .success([])
  /// `nil` ⇒ ``get(id:)`` throws a 404 (models a missing/not-owned conversation).
  var getResult: Result<ConversationDetail, OakError>?
  var renameError: OakError?
  var setPinnedError: OakError?
  var deleteError: OakError?
  var importResult: Result<String?, OakError> = .success("imported_conv_id")

  // MARK: Recording

  private(set) var listCount = 0
  private(set) var lastListQuery: String?
  private(set) var lastListFormat: Format?

  private(set) var getCount = 0
  private(set) var lastGetId: String?

  private(set) var renameCount = 0
  private(set) var lastRenamedId: String?
  private(set) var lastRenamedTitle: String?

  private(set) var setPinnedCount = 0
  private(set) var lastPinnedId: String?
  private(set) var lastPinnedValue: Bool?

  private(set) var deleteCount = 0
  private(set) var lastDeletedId: String?

  private(set) var importCount = 0
  private(set) var lastImportSessionId: String?
  private(set) var lastImportChampionsMode: Bool?
  private(set) var lastImportTurns: [ChatTurn]?

  // MARK: HistoryService

  func list(query: String?, format: Format?) async throws -> [ConversationSummary] {
    listCount += 1
    lastListQuery = query
    lastListFormat = format
    return try listResult.get()
  }

  func get(id: String) async throws -> ConversationDetail {
    getCount += 1
    lastGetId = id
    guard let getResult else {
      throw OakError.http(status: 404, code: "not_found", message: "Conversation not found.")
    }
    return try getResult.get()
  }

  func rename(id: String, title: String) async throws {
    renameCount += 1
    lastRenamedId = id
    lastRenamedTitle = title
    if let renameError { throw renameError }
  }

  func setPinned(id: String, pinned: Bool) async throws {
    setPinnedCount += 1
    lastPinnedId = id
    lastPinnedValue = pinned
    if let setPinnedError { throw setPinnedError }
  }

  func delete(id: String) async throws {
    deleteCount += 1
    lastDeletedId = id
    if let deleteError { throw deleteError }
  }

  func importGuestThread(
    sessionId: String,
    championsMode: Bool,
    turns: [ChatTurn]
  ) async throws -> String? {
    importCount += 1
    lastImportSessionId = sessionId
    lastImportChampionsMode = championsMode
    lastImportTurns = turns
    return try importResult.get()
  }
}
