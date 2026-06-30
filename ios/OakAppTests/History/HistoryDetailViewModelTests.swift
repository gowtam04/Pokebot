import Foundation
import Testing

@testable import OakApp

/// `HistoryDetailViewModel` against `FakeHistoryService` (history-and-teams.md
/// M-HIST-US-3): loading a conversation's rehydrated turns and the resume hand-off
/// (set `session_id` = conversation id so follow-ups carry context). The view model
/// is `@MainActor`, so the suite is too.
@MainActor
struct HistoryDetailViewModelTests {

  // MARK: Helpers

  private func summary(id: String, title: String = "Saved chat") -> ConversationSummary {
    ConversationSummary(id: id, title: title, format: .scarletViolet, pinned: false, updatedAt: 1_000)
  }

  // MARK: Load

  @Test
  func loadFetchesDetailWithRehydratedTurns() async throws {
    // Reuse the committed detail fixture: user turn (msg_1) + full-fidelity
    // assistant answer (msg_2), so earlier answers re-render via the answer card
    // tree (M-AC-H3.2), not a flattened string.
    let detail = try Fixtures.decode(ConversationDetail.self, from: "conversation_detail.json")
    let fake = FakeHistoryService()
    fake.getResult = .success(detail)
    let vm = HistoryDetailViewModel(summary: summary(id: "conv_1"), history: fake, appState: AppState())

    await vm.load()

    #expect(fake.lastGetId == "conv_1")
    #expect(vm.title == detail.title)
    #expect(vm.turns.count == 2)

    guard case .user = vm.turns[0] else {
      Issue.record("first turn should be a user turn")
      return
    }
    guard case let .assistant(_, answer) = vm.turns[1] else {
      Issue.record("second turn should be a full-fidelity assistant answer")
      return
    }
    #expect(answer.status == .answered)
  }

  @Test
  func loadSurfaces404AsNotAvailable() async {
    let fake = FakeHistoryService()
    fake.getResult = nil  // models a missing / not-owned conversation → 404
    let vm = HistoryDetailViewModel(summary: summary(id: "missing"), history: fake, appState: AppState())

    await vm.load()

    #expect(vm.detail == nil)
    #expect(vm.errorMessage == HistoryDetailViewModel.notAvailableMessage)
  }

  // MARK: Resume

  @Test
  func resumeSetsSessionIdForFollowUps() async {
    let appState = AppState()
    let detail = ConversationDetail(
      id: "conv_42",
      title: "Resumed",
      format: .scarletViolet,
      pinned: false,
      turns: []
    )
    let fake = FakeHistoryService()
    fake.getResult = .success(detail)
    let vm = HistoryDetailViewModel(summary: summary(id: "conv_42"), history: fake, appState: appState)
    await vm.load()

    let resumed = vm.resume()

    #expect(resumed == "conv_42")
    #expect(appState.activeConversationId == "conv_42")
    // A ChatViewModel built for the resumed thread adopts the conversation id as
    // its session_id, so a context-dependent follow-up reflects the earlier turns.
    let chat = ChatViewModel(chat: FakeChatService(), appState: appState)
    #expect(chat.sessionId == "conv_42")
  }

  @Test
  func resumeBeforeLoadUsesSummaryId() {
    let appState = AppState()
    let fake = FakeHistoryService()
    let vm = HistoryDetailViewModel(summary: summary(id: "conv_7"), history: fake, appState: appState)

    let resumed = vm.resume()

    #expect(resumed == "conv_7")
    #expect(appState.activeConversationId == "conv_7")
  }
}
