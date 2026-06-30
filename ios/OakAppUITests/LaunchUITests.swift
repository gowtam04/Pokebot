import XCTest

/// Launch smoke (hermetic — no backend). The app boots to the four-tab shell with
/// Chat as the default surface (M-AC-UI2.1). Runs in any environment; it is the
/// floor the rest of the suite builds on. The full critical path (ask → streamed
/// answer) lives in ``ChatCriticalPathUITests`` and runs live (CP5).
final class LaunchUITests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  @MainActor
  func testLaunchShowsTabShell() {
    let app = XCUIApplication().launchOak()

    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "App did not reach the foreground after launch."
    )
    XCTAssertTrue(
      app.tabBars.firstMatch.waitForExistence(timeout: 15),
      "Expected the root tab shell to render on launch."
    )
  }

  /// Every parity surface is reachable from the tab bar (M-UI-US-2 / M-AC-UI2.2):
  /// Chat, History, Teams, Account are all present.
  @MainActor
  func testAllParityTabsPresent() {
    let app = XCUIApplication().launchOak()
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))

    for label in OakUITest.Tab.all {
      XCTAssertTrue(
        app.tabBars.buttons[label].waitForExistence(timeout: 5),
        "Expected the \(label) tab to be reachable from the tab shell."
      )
    }
  }
}
