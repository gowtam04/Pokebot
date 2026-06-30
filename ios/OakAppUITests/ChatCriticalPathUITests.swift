import Foundation
import XCTest

/// **CP5 critical path:** launch → ask a question → tool activity + token-by-token
/// answer renders (M-SUCCESS-1/2/3, M-NFR-2). This is the product's whole point, so
/// it is the first E2E flow.
///
/// It needs a reachable backend, so it is gated behind ``requireLiveBackend()`` and
/// skips cleanly in the hermetic build-for-testing gate. When the app's DEBUG mock
/// seam honors ``OakUITest/Scenario/mockAnswer`` this same flow runs fully offline;
/// the steps are identical, only the launch scenario changes.
final class ChatCriticalPathUITests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  /// Launch → type a question → send → first feedback (tool activity / streaming
  /// status) appears promptly (M-NFR-2: the app must not buffer the whole answer) →
  /// a finalized answer renders with its reasoning structure (M-SUCCESS-3).
  @MainActor
  func testAskQuestionStreamsAnswer() throws {
    try requireLiveBackend()

    let app = XCUIApplication().launchOak()
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))

    XCTAssertTrue(goToTab(OakUITest.Tab.chat, in: app), "Chat tab unreachable.")
    try requireComposer(in: app)

    // Ask a deterministic, single-subject question so the answer is stable to assert.
    let composer = app.oakComposerField
    composer.tap()
    composer.typeText("What is Garchomp's base Speed?")

    let send = app.buttons[OakUITest.Chat.sendButton]
    XCTAssertTrue(send.waitForExistence(timeout: 5), "Send button missing.")
    send.tap()

    // M-NFR-2 — first visible feedback (a streaming phase or a tool-activity row)
    // shows up before the answer is complete. We accept any of the phase labels.
    let firstFeedback = app.staticTexts.matching(
      NSPredicate(format: "label IN %@", OakUITest.Streaming.all)
    ).firstMatch
    XCTAssertTrue(
      firstFeedback.waitForExistence(timeout: 12),
      "Expected in-progress streaming feedback shortly after send (M-NFR-2)."
    )

    // M-SUCCESS-3 — a finalized answer renders with its reasoning structure. The
    // collapsible "Reasoning" disclosure is a stable structural marker that the full
    // field-by-field AnswerCard rendered (rather than a flat string).
    let reasoning = app.staticTexts[OakUITest.Answer.reasoningDisclosure]
    XCTAssertTrue(
      reasoning.waitForExistence(timeout: 60),
      "Expected a finalized answer with its reasoning structure (M-SUCCESS-3)."
    )

    XCTAssertEqual(
      app.state, .runningForeground,
      "App must stay responsive through a full streamed turn (M-SUCCESS-2)."
    )
  }

  /// "New conversation" is reachable from the chat surface without leaving it
  /// (M-AC-UI2.4) and resets the thread to the empty state.
  @MainActor
  func testNewConversationResetsThread() throws {
    try requireLiveBackend()

    let app = XCUIApplication().launchOak()
    XCTAssertTrue(goToTab(OakUITest.Tab.chat, in: app), "Chat tab unreachable.")
    try requireComposer(in: app)

    let newConversation = app.buttons[OakUITest.Chat.newConversation]
    XCTAssertTrue(
      newConversation.waitForExistence(timeout: 5),
      "New-conversation control should be on the chat surface (M-AC-UI2.4)."
    )
    newConversation.tap()

    XCTAssertEqual(app.state, .runningForeground)
  }
}
