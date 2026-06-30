import Foundation
import Testing

@testable import OakApp

/// `ChatViewModel` — the SSE reducer — against `FakeChatService` and the committed
/// `.sse` fixtures (testing-strategy.md "ViewModels"; chat-experience.md
/// M-CHAT-US-1/3/4/6). Two layers of coverage:
///   * the reducer transitions applied directly (`apply(_:)`) — deltas append,
///     `answer_start` resets the buffer but keeps tool history, the terminal answer
///     finalizes, an `error` event becomes a banner;
///   * the end-to-end `send` path over the real fixtures parsed by the production
///     `SSEParser`, plus the request-shape checks (Champions flag) and the in-domain
///     non-`answered` rendering.
///
/// The view model is `@MainActor`, so the suite is too.
@MainActor
struct ChatViewModelTests {

  // MARK: Helpers

  private func makeViewModel(
    fake: FakeChatService,
    appState: AppState = AppState()
  ) -> ChatViewModel {
    ChatViewModel(chat: fake, appState: appState)
  }

  /// Parse a committed `.sse` fixture into events through the PRODUCTION parser, so
  /// these tests also exercise `SSEParser`'s frame splitting + decoding.
  private func events(fromSSE name: String) throws -> [SSEEvent] {
    let body = try Fixtures.string(name)
    var parser = SSEParser()
    var out: [SSEEvent] = []
    for line in body.components(separatedBy: "\n") {
      out += try parser.consume(line: line)
    }
    out += try parser.finish()
    return out
  }

  // MARK: Reducer transitions (apply directly)

  @Test
  func deltasAppendToTheBuffer() {
    let vm = makeViewModel(fake: FakeChatService())
    vm.apply(.answerStart)
    vm.apply(.answerDelta(text: "Garchomp "))
    vm.apply(.answerDelta(text: "is fast."))
    #expect(vm.streamingText == "Garchomp is fast.")
  }

  @Test
  func answerStartResetsBufferButKeepsToolHistory() {
    let vm = makeViewModel(fake: FakeChatService())
    vm.apply(.toolActivity(tool: "resolve_entity", label: "Resolving \"Garchomp\""))
    vm.apply(.answerDelta(text: "partial draft"))
    // A fresh submit_answer begins streaming (validate-and-re-emit): the buffer
    // clears, the tool-activity history stays.
    vm.apply(.answerStart)
    #expect(vm.streamingText == "")
    #expect(vm.toolActivities.count == 1)
    #expect(vm.toolActivities.first?.label == "Resolving \"Garchomp\"")
  }

  @Test
  func terminalAnswerFinalizesTheTurn() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_answered_full.json")
    let vm = makeViewModel(fake: FakeChatService())

    vm.apply(.toolActivity(tool: "get_pokemon", label: "Looking up Garchomp"))
    vm.apply(.answerDelta(text: "streaming…"))
    vm.apply(.answer(answer))

    #expect(vm.turns.count == 1)
    if case let .assistant(rendered) = vm.turns.last?.content {
      #expect(rendered.status == .answered)
    } else {
      Issue.record("expected an assistant turn")
    }
    #expect(vm.streamingText == "")          // buffer replaced by the authoritative answer
    #expect(vm.toolActivities.isEmpty)        // in-progress activity cleared
    #expect(vm.isStreaming == false)
    #expect(vm.errorBanner == nil)
  }

  @Test
  func errorEventBecomesARecoverableBanner() {
    let vm = makeViewModel(fake: FakeChatService())
    vm.apply(.answerDelta(text: "half an answer"))
    vm.apply(.error(code: "model_unavailable", message: "down", status: 503))

    #expect(vm.errorBanner != nil)
    #expect(vm.errorBanner?.isRetryable == true)
    #expect(vm.streamingText == "")           // no half-rendered answer left behind
    #expect(vm.isStreaming == false)
  }

  // MARK: End-to-end over the .sse fixtures

  @Test
  func answeredFullStreamRendersUserThenAnswer() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_answered_full.sse")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "Tell me about Garchomp"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.turns.count == 2)              // user + assistant
    if case let .user(text, _) = vm.turns.first?.content {
      #expect(text == "Tell me about Garchomp")
    } else {
      Issue.record("expected a user turn first")
    }
    if case let .assistant(answer) = vm.turns.last?.content {
      #expect(answer.status == .answered)
      #expect(answer.subjects?.first?.name == "Garchomp")
    } else {
      Issue.record("expected an assistant turn last")
    }
    #expect(vm.streamingText == "")
    #expect(vm.toolActivities.isEmpty)
    #expect(vm.isStreaming == false)
    #expect(vm.errorBanner == nil)
    #expect(vm.composerText == "")            // composer cleared on send
  }

  @Test
  func grokSingleDeltaStreamStillFinalizes() async throws {
    // Grok delivers the whole answer in ONE delta — the reducer must not assume many.
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_single_delta_grok.sse")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "Fastest Dragon type?"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.turns.count == 2)
    if case let .assistant(answer) = vm.turns.last?.content {
      #expect(answer.status == .answered)
    } else {
      Issue.record("expected an assistant turn")
    }
    #expect(vm.isStreaming == false)
  }

  @Test
  func heartbeatStreamFinalizesIgnoringComments() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_heartbeat.sse")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "hi"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.turns.count == 2)
    if case let .assistant(answer) = vm.turns.last?.content {
      #expect(answer.status == .answered)
    } else {
      Issue.record("expected an assistant turn")
    }
  }

  @Test
  func inBandErrorStreamKeepsUserTurnAndShowsBanner() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_error.sse")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "Tell me about Garchomp"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.turns.count == 1)              // only the user turn — no half answer
    if case .user = vm.turns.first?.content {} else {
      Issue.record("expected the user turn to remain")
    }
    #expect(vm.errorBanner != nil)
    #expect(vm.streamingText == "")
    #expect(vm.isStreaming == false)
  }

  @Test
  func thrownTransportFaultBecomesConnectionBanner() async {
    let fake = FakeChatService()
    fake.thrownError = OakError.transport(underlying: "URLError.-1009")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "anything"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.errorBanner?.message == ChatViewModel.connectionMessage)
    #expect(vm.errorBanner?.isRetryable == true)
    #expect(vm.isStreaming == false)
  }

  // MARK: In-domain non-answered statuses render (NOT as errors)

  @Test
  func insufficientDataRendersAsAnAnswerNotAnError() async throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_insufficient_data.json")
    let fake = FakeChatService()
    fake.scriptedEvents = [.answerStart, .answerDelta(text: answer.answerMarkdown), .answer(answer)]
    let vm = makeViewModel(fake: fake)

    vm.composerText = "obscure question"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.errorBanner == nil)            // an in-domain failure is NOT an error
    if case let .assistant(rendered) = vm.turns.last?.content {
      #expect(rendered.status == .insufficientData)
    } else {
      Issue.record("expected an assistant turn with the insufficient_data status")
    }
  }

  @Test
  func clarificationRendersAsAnAnswerNotAnError() async throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_clarification.json")
    let fake = FakeChatService()
    fake.scriptedEvents = [.answer(answer)]
    let vm = makeViewModel(fake: fake)

    vm.composerText = "ambiguous"
    vm.send()
    await vm.streamTask?.value

    #expect(vm.errorBanner == nil)
    if case let .assistant(rendered) = vm.turns.last?.content {
      #expect(rendered.status == .clarificationNeeded)
    } else {
      Issue.record("expected an assistant turn with the clarification_needed status")
    }
  }

  // MARK: Champions toggle flows into the request

  @Test
  func championsToggleIsSentOnTheRequest() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_answered_full.sse")
    let vm = makeViewModel(fake: fake)

    vm.setChampionsMode(true)
    vm.composerText = "champions scope question"
    vm.send()
    await vm.streamTask?.value

    #expect(fake.lastChampionsMode == true)
  }

  @Test
  func standardModeSendsChampionsFalse() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_answered_full.sse")
    let vm = makeViewModel(fake: fake)

    vm.composerText = "standard scope question"
    vm.send()
    await vm.streamTask?.value

    #expect(fake.lastChampionsMode == false)
  }

  @Test
  func championsModeSeedsFromAppStateDefaultAndPersistsBack() {
    let appState = AppState()
    appState.championsMode = true
    let vm = makeViewModel(fake: FakeChatService(), appState: appState)

    #expect(vm.championsMode == true)         // seeded from the app-wide default

    vm.setChampionsMode(false)
    #expect(vm.championsMode == false)
    #expect(appState.championsMode == false)  // written back as the new default
  }

  // MARK: Composer + conversation lifecycle

  @Test
  func canSendRequiresTextAndNotStreaming() {
    let vm = makeViewModel(fake: FakeChatService())
    #expect(vm.canSend == false)              // empty composer

    vm.composerText = "   "
    #expect(vm.canSend == false)              // whitespace only

    vm.composerText = "real question"
    #expect(vm.canSend == true)
  }

  @Test
  func emptyMessageDoesNotSend() {
    let fake = FakeChatService()
    let vm = makeViewModel(fake: fake)
    vm.composerText = "   "
    vm.send()
    #expect(fake.sendCount == 0)
    #expect(vm.turns.isEmpty)
  }

  @Test
  func startNewConversationClearsThreadAndRotatesSession() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_answered_full.sse")
    let appState = AppState()
    let vm = makeViewModel(fake: fake, appState: appState)
    let firstSession = vm.sessionId

    vm.composerText = "first question"
    vm.send()
    await vm.streamTask?.value
    #expect(vm.turns.count == 2)
    #expect(appState.guestThread.isEmpty == false)   // guest thread mirrored

    vm.startNewConversation()

    #expect(vm.turns.isEmpty)
    #expect(vm.sessionId != firstSession)            // rotated → no prior context
    #expect(appState.guestThread.isEmpty)            // guest thread reset
    #expect(appState.activeConversationId == nil)
  }

  @Test
  func guestTurnsAreMirroredIntoAppState() async throws {
    let fake = FakeChatService()
    fake.scriptedEvents = try events(fromSSE: "chat_answered_full.sse")
    let appState = AppState()                          // defaults to .guest
    let vm = makeViewModel(fake: fake, appState: appState)

    vm.composerText = "Tell me about Garchomp"
    vm.send()
    await vm.streamTask?.value

    #expect(appState.guestThread.count == 2)
    #expect(appState.guestThread.first?.role == .user)
    #expect(appState.guestThread.last?.role == .assistant)
  }

  // MARK: Streaming phase (the "working vs done" signal)

  @Test
  func streamingPhaseReflectsProgress() {
    let vm = makeViewModel(fake: FakeChatService())
    #expect(vm.streamingPhase == .idle)

    vm.composerText = "q"
    vm.send()                                          // isStreaming → true, no events yet
    #expect(vm.streamingPhase == .thinking)

    vm.apply(.toolActivity(tool: "t", label: "looking up"))
    #expect(vm.streamingPhase == .usingTools)

    vm.apply(.answerStart)
    vm.apply(.answerDelta(text: "answer"))
    #expect(vm.streamingPhase == .answering)
  }
}
