import XCTest

/// Live end-to-end guard for the SSE blank-line framing fix (`ByteLineSplitter` /
/// `SSEClient`). A guest sends the exact message that previously failed with
/// "Something went wrong. Please try again." and the streamed answer must render —
/// proving the real `URLSession.AsyncBytes` → split → `SSEParser` path now works.
///
/// This talks to the LIVE backend (`BaseURL.current`) and is intended to be run
/// on-demand as a verification, not in the hermetic gate.
@MainActor
final class ChatStreamFixVerificationTests: XCTestCase {

  func testGuestChatStreamRendersAnswer() throws {
    // Live, opt-in (OAK_E2E=1) — talks to the real backend; skips in the hermetic gate.
    try requireLiveBackend()

    let app = XCUIApplication()
    app.launchOak(.live)

    // Guest opens straight into the chat thread; the composer is present.
    let composer = app.oakComposerField
    XCTAssertTrue(composer.waitForExistence(timeout: 20), "composer not reachable")
    composer.tap()
    composer.typeText("Does fake out work on farigiraf?")

    let send = app.buttons[OakUITest.Chat.sendButton]
    XCTAssertTrue(send.waitForExistence(timeout: 5), "send button not found")
    send.tap()

    // Success = a finalized answer card renders (its "Reasoning" disclosure appears).
    // Failure (the bug) = the recoverable error banner shows.
    let reasoningButton = app.buttons[OakUITest.Answer.reasoningDisclosure]
    let reasoningText = app.staticTexts[OakUITest.Answer.reasoningDisclosure]
    let errorBanner = app.staticTexts["Something went wrong. Please try again."]

    let deadline = Date().addingTimeInterval(120)
    var rendered = false
    var failed = false
    while Date() < deadline {
      if reasoningButton.exists || reasoningText.exists { rendered = true; break }
      if errorBanner.exists { failed = true; break }
      Thread.sleep(forTimeInterval: 1)
    }

    XCTAssertFalse(failed, "chat stream still failed — the error banner appeared")
    XCTAssertTrue(rendered, "no answer card rendered within 120s")
  }
}
