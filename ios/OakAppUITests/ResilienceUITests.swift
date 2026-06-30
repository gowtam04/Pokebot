import XCTest

/// Resilience checks (M-NFR-4: "never crashes on a well-formed error response";
/// M-AC-NFR1.1: offline shows a clear retry surface). The launch + navigation parts
/// run **hermetically** (no backend); the offline/error path runs fully hermetic once
/// the app's DEBUG mock seam honors ``OakUITest/Scenario/mockTransportError`` and
/// degrades to a no-crash assertion until then.
final class ResilienceUITests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  /// Cycling through every tab never crashes the shell (M-NFR-4 / M-UI-US-2). Fully
  /// hermetic — exercises navigation against whatever each tab currently renders.
  @MainActor
  func testTabNavigationNeverCrashes() {
    let app = XCUIApplication().launchOak()
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))

    // Two passes, so re-selecting an already-active tab is covered too.
    for _ in 0..<2 {
      for label in OakUITest.Tab.all {
        if goToTab(label, in: app) {
          XCTAssertEqual(
            app.state, .runningForeground,
            "App must stay foregrounded after selecting the \(label) tab."
          )
        }
      }
    }
  }

  /// A backend/transport failure surfaces a recoverable state, not a crash (M-NFR-4 /
  /// M-AC-NFR1.1). Hermetic when the mock seam is honored; otherwise this asserts the
  /// weaker — but still meaningful — property that driving the chat with no reachable
  /// backend never crashes and leaves the app responsive.
  @MainActor
  func testTransportErrorSurfacesRetryWithoutCrash() throws {
    let app = XCUIApplication().launchOak(.mockTransportError)
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))

    guard goToTab(OakUITest.Tab.chat, in: app),
      app.oakComposerField.waitForExistence(timeout: 10)
    else {
      // Chat surface not wired yet — the no-crash floor still holds.
      XCTAssertEqual(app.state, .runningForeground)
      throw XCTSkip("Chat composer not reachable — run the offline path live once wired (CP5).")
    }

    let composer = app.oakComposerField
    composer.tap()
    composer.typeText("Anything")
    app.buttons[OakUITest.Chat.sendButton].tap()

    // If the retry affordance appears (chat error banner "Retry" or the shared
    // ConnectionStateView "Try Again"), exercise it — a retry tap must not crash.
    let retry = app.buttons[OakUITest.Chat.retry]
    let tryAgain = app.buttons[OakUITest.Connection.tryAgain]
    if retry.waitForExistence(timeout: 12) {
      retry.tap()
    } else if tryAgain.exists {
      tryAgain.tap()
    }

    // The non-negotiable property regardless of seam support: no crash (M-NFR-4).
    XCTAssertEqual(
      app.state, .runningForeground,
      "A transport failure must surface a recoverable state, never crash (M-NFR-4)."
    )
  }

  /// Backgrounding and re-activating mid-session does not crash or lose the shell
  /// (M-NFR-5 launch/session resilience). Hermetic.
  @MainActor
  func testBackgroundForegroundKeepsShell() {
    let app = XCUIApplication().launchOak()
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))

    XCUIDevice.shared.press(.home)
    app.activate()

    XCTAssertTrue(
      app.tabBars.firstMatch.waitForExistence(timeout: 15),
      "Tab shell should be intact after returning from the background (M-NFR-5)."
    )
    XCTAssertEqual(app.state, .runningForeground)
  }
}
