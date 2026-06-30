import Foundation
import Observation

/// The conversation-detail / resume view model (history-and-teams.md M-HIST-US-3;
/// component-design.md "HistoryDetailViewModel (resume → ChatView)"). It loads a
/// saved conversation's full, rehydrated turns so the earlier answers re-render
/// through the normal ``AnswerCardView`` tree (M-AC-H3.2), and **resumes** the
/// conversation by making it the live thread.
///
/// `@MainActor @Observable` — UI state mutates on the main actor. It depends on the
/// ``HistoryService`` **protocol** (never `LiveHistoryService`) so it unit-tests
/// against `FakeHistoryService`.
///
/// Resume hand-off: ``resume()`` sets ``AppState/activeConversationId`` to this
/// conversation's id, which a freshly-constructed `ChatViewModel` reads as its
/// `session_id`. Sending under that id makes the backend treat it as the live
/// thread, so a context-dependent follow-up reflects the conversation's earlier
/// turns (M-AC-H3.1). The earlier turns themselves render from ``turns`` (the loaded
/// detail), not from the chat reducer.
@MainActor
@Observable
final class HistoryDetailViewModel {

  /// The list-row summary this detail was opened from — its `title`/`format` show
  /// immediately while the full detail loads.
  let summary: ConversationSummary

  /// The loaded conversation with its rehydrated turns, or `nil` before ``load()``.
  private(set) var detail: ConversationDetail?

  /// `true` while the detail fetch is in flight.
  private(set) var isLoading: Bool = false

  /// A user-facing error message for a failed load, or `nil` when clear.
  private(set) var errorMessage: String?

  private let history: any HistoryService
  private let appState: AppState

  init(summary: ConversationSummary, history: any HistoryService, appState: AppState) {
    self.summary = summary
    self.history = history
    self.appState = appState
  }

  // MARK: Derived

  /// The conversation id (stable from the summary, before the detail loads).
  var id: String { summary.id }

  /// The best title available: the loaded detail's, falling back to the summary's.
  var title: String { detail?.title ?? summary.title }

  /// The rehydrated turns to render (empty until ``load()`` completes).
  var turns: [ChatTurn] { detail?.turns ?? [] }

  /// The conversation's bound active team id, once loaded (M-TEAM-US-5). Exposed for
  /// the resume hand-off to restore the composer's active-team selector (wired with
  /// the team picker in a later phase); `nil` = none bound.
  var activeTeamId: String? { detail?.activeTeamId }

  // MARK: Actions

  /// Loads the full conversation (`GET /api/conversations/{id}`) so its earlier
  /// answers re-render with full fidelity. Never throws: a failure surfaces as
  /// ``errorMessage``.
  func load() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      detail = try await history.get(id: summary.id)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
    } catch {
      errorMessage = Self.genericMessage
    }
  }

  /// Makes this conversation the live thread (M-AC-H3.1): binds its id as the app's
  /// active conversation so a subsequently-constructed `ChatViewModel` adopts it as
  /// `session_id`. Returns the resumed conversation id.
  @discardableResult
  func resume() -> String {
    let id = detail?.id ?? summary.id
    appState.activeConversationId = id
    return id
  }

  // MARK: Error copy (static so tests can assert exact strings)

  static let connectionMessage = "No connection. Check your network and try again."
  static let sessionExpiredMessage = "Your session expired. Please sign in again."
  static let notAvailableMessage = "This conversation is no longer available."
  static let genericMessage = "Something went wrong. Please try again."

  /// Maps an ``OakError`` to a user-facing message (a `404` means the conversation
  /// is gone or not owned — isolation, M-BR-H2).
  static func message(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited:
      return "You're going too fast. Please wait a moment and try again."
    case .unauthorized:
      return sessionExpiredMessage
    case let .http(status, _, message):
      if status == 404 { return notAvailableMessage }
      return message.isEmpty ? genericMessage : message
    case .decoding, .imageRejected:
      return genericMessage
    }
  }
}
