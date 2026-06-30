import Foundation
import Testing

@testable import OakApp

/// `AppState.importGuestThread(using:)` against `FakeHistoryService` (P9 AppState
/// extension; M-ACCT-US-4 / component-design.md "Guest→sign-in"): the in-memory
/// guest thread maps to the import payload, the returned id becomes the active
/// conversation, and a failure (or empty thread) is non-fatal. `AppState` is
/// `@MainActor`, so the suite is too.
@MainActor
struct AppStateGuestImportTests {

  @Test
  func importMapsInMemoryTurnsToPayload() async {
    let state = AppState()
    state.guestThread = [
      GuestTurn(role: .user, text: "What's the fastest dragon?"),
      GuestTurn(role: .assistant, text: "Dragapult, at 142 base Speed."),
    ]
    let fake = FakeHistoryService()
    fake.importResult = .success("conv_new")

    let id = await state.importGuestThread(using: fake)

    #expect(id == "conv_new")
    #expect(state.activeConversationId == "conv_new")  // becomes the active conversation
    #expect(fake.importCount == 1)

    let turns = fake.lastImportTurns
    #expect(turns?.count == 2)

    guard let first = turns?.first, case let .user(_, content) = first else {
      Issue.record("first imported turn should be a user turn")
      return
    }
    #expect(content == "What's the fastest dragon?")

    guard let last = turns?.last, case let .assistant(_, answer) = last else {
      Issue.record("second imported turn should be an assistant answer")
      return
    }
    // The assistant turn round-trips its prose inside a minimal, schema-valid answer.
    #expect(answer.answerMarkdown == "Dragapult, at 142 base Speed.")
    #expect(answer.status == .answered)
    #expect(answer.citations.isEmpty)
  }

  @Test
  func importForwardsChampionsModeAndSessionId() async {
    let state = AppState()
    state.championsMode = true
    state.activeConversationId = "existing_session"  // reused as the import session id
    state.guestThread = [GuestTurn(role: .user, text: "hi")]
    let fake = FakeHistoryService()
    fake.importResult = .success("existing_session")

    _ = await state.importGuestThread(using: fake)

    #expect(fake.lastImportChampionsMode == true)
    #expect(fake.lastImportSessionId == "existing_session")
  }

  @Test
  func emptyGuestThreadImportsNothing() async {
    let state = AppState()  // guestThread defaults to []
    let fake = FakeHistoryService()

    let id = await state.importGuestThread(using: fake)

    #expect(id == nil)
    #expect(fake.importCount == 0)
    #expect(state.activeConversationId == nil)
  }

  @Test
  func importFailureIsNonFatalAndKeepsThread() async {
    let state = AppState()
    state.guestThread = [GuestTurn(role: .user, text: "hi")]
    let fake = FakeHistoryService()
    fake.importResult = .failure(.transport(underlying: "URLError.-1009"))

    let id = await state.importGuestThread(using: fake)

    #expect(id == nil)
    #expect(state.activeConversationId == nil)        // unchanged on failure
    #expect(state.guestThread.count == 1)             // on-screen thread preserved (M-AC-4.1)
  }
}
