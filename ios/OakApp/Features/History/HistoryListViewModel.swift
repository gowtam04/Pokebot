import Foundation
import Observation

/// The history list's view model (history-and-teams.md M-HIST-US-2;
/// component-design.md "HistoryListViewModel"). Holds the conversation list and the
/// search/format-filter state, and drives the list mutations (pin / rename /
/// delete) with optimistic updates so the UI feels instant.
///
/// `@MainActor @Observable` — all state mutates on the main actor and views observe
/// it directly. It depends on the ``HistoryService`` **protocol** (never
/// `LiveHistoryService`) so it unit-tests against `FakeHistoryService`.
///
/// Search (`?q=`) and the format filter (`?format=`) are applied **server-side**:
/// changing either re-fetches via ``reload()`` (the route returns pinned-first,
/// most-recent order). Guests get an empty list from the route, so this surface is
/// empty for them (M-BR-H1) — the view shows a sign-in prompt.
@MainActor
@Observable
final class HistoryListViewModel {

  // MARK: List state

  /// The visible conversations, in the server's pinned-first / most-recent order.
  private(set) var conversations: [ConversationSummary] = []

  /// `true` while a list fetch is in flight (drives the refresh spinner).
  private(set) var isLoading: Bool = false

  /// A user-facing error message for the last failed operation, or `nil` when clear.
  private(set) var errorMessage: String?

  // MARK: Filter state (two-way bound)

  /// The search text (M-AC-H2.2). Applied server-side via `?q=` on ``reload()``.
  var searchQuery: String = ""

  /// The active format filter (M-AC-H2.3); `nil` = all formats. Applied server-side
  /// via `?format=`.
  private(set) var formatFilter: Format?

  // MARK: Dependencies

  private let history: any HistoryService

  init(history: any HistoryService) {
    self.history = history
  }

  // MARK: Loading

  /// (Re)loads the conversation list with the current search + filter — the initial
  /// load, pull-to-refresh (M-AC-H2.5), and the re-fetch after a search/filter
  /// change all route through here. Never throws: a failure surfaces as
  /// ``errorMessage`` and leaves the prior list in place.
  func reload() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      conversations = try await history.list(query: trimmedQuery, format: formatFilter)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
    } catch {
      errorMessage = Self.genericMessage
    }
  }

  /// Applies a search query and re-fetches (M-AC-H2.2). The view calls this on
  /// submit / debounced change; a no-op-safe wrapper over ``reload()``.
  func search() async {
    await reload()
  }

  /// Switches the format filter and re-fetches (M-AC-H2.3). A no-op when unchanged.
  func setFormatFilter(_ format: Format?) async {
    guard format != formatFilter else { return }
    formatFilter = format
    await reload()
  }

  /// The trimmed search text, or `nil` when blank (so an empty field sends no `?q=`).
  private var trimmedQuery: String? {
    let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  // MARK: Mutations (optimistic)

  /// Pins or unpins a conversation (M-AC-H2.4). Optimistically flips the flag and
  /// re-sorts (pinned first), then persists; a failure reverts and surfaces an error.
  func togglePin(_ summary: ConversationSummary) async {
    let newPinned = !summary.pinned
    replaceLocal(summary.withPinned(newPinned))
    do {
      try await history.setPinned(id: summary.id, pinned: newPinned)
    } catch let error as OakError {
      replaceLocal(summary)
      errorMessage = Self.message(for: error)
    } catch {
      replaceLocal(summary)
      errorMessage = Self.genericMessage
    }
  }

  /// Renames a conversation (M-AC-H2.4). Trims the title and ignores an empty or
  /// unchanged value; otherwise optimistically updates, then persists (the server
  /// bounds the length). A failure reverts and surfaces an error.
  func rename(_ summary: ConversationSummary, to newTitle: String) async {
    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != summary.title else { return }
    replaceLocal(summary.withTitle(title))
    do {
      try await history.rename(id: summary.id, title: title)
    } catch let error as OakError {
      replaceLocal(summary)
      errorMessage = Self.message(for: error)
    } catch {
      replaceLocal(summary)
      errorMessage = Self.genericMessage
    }
  }

  /// Deletes a conversation (M-AC-H2.4). Optimistically removes the row, then
  /// persists. A `404` is treated as success (the conversation was already gone —
  /// idempotent UX, api-design.md); any other failure restores the row and surfaces
  /// an error.
  func delete(_ summary: ConversationSummary) async {
    let snapshot = conversations
    conversations.removeAll { $0.id == summary.id }
    do {
      try await history.delete(id: summary.id)
    } catch OakError.http(let status, _, _) where status == 404 {
      // Already deleted on the server — keep it removed (idempotent).
    } catch let error as OakError {
      conversations = snapshot
      errorMessage = Self.message(for: error)
    } catch {
      conversations = snapshot
      errorMessage = Self.genericMessage
    }
  }

  /// Clears the current error banner.
  func dismissError() {
    errorMessage = nil
  }

  // MARK: Local list edits

  /// Replaces the conversation with the same id and re-sorts (pinned first, then
  /// most-recently-active) so an optimistic pin moves the row immediately.
  private func replaceLocal(_ updated: ConversationSummary) {
    guard let index = conversations.firstIndex(where: { $0.id == updated.id }) else { return }
    conversations[index] = updated
    conversations.sort { lhs, rhs in
      if lhs.pinned != rhs.pinned { return lhs.pinned }
      return lhs.updatedAt > rhs.updatedAt
    }
  }

  // MARK: Error copy (static so tests can assert exact strings)

  static let connectionMessage = "No connection. Check your network and try again."
  static let sessionExpiredMessage = "Your session expired. Please sign in again."
  static let genericMessage = "Something went wrong. Please try again."

  /// Maps an ``OakError`` to a user-facing message.
  static func message(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited:
      return "You're going too fast. Please wait a moment and try again."
    case .unauthorized:
      return sessionExpiredMessage
    case let .http(_, _, message):
      return message.isEmpty ? genericMessage : message
    case .decoding, .imageRejected:
      return genericMessage
    }
  }
}

// MARK: - Local copy helpers

private extension ConversationSummary {
  /// A copy with a new `pinned` flag (the DTO's stored fields are immutable).
  func withPinned(_ pinned: Bool) -> ConversationSummary {
    ConversationSummary(id: id, title: title, format: format, pinned: pinned, updatedAt: updatedAt)
  }

  /// A copy with a new `title`.
  func withTitle(_ title: String) -> ConversationSummary {
    ConversationSummary(id: id, title: title, format: format, pinned: pinned, updatedAt: updatedAt)
  }
}
