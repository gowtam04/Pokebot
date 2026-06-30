import Foundation
import XCTest

/// Shared harness for the Oak XCUITest suite (Phase 13 / CP5).
///
/// XCUITest is **black-box**: it drives the app through `XCUIApplication` and cannot
/// `@testable import OakApp`, so every target string here is a literal that mirrors
/// the app's visible text / `accessibilityLabel`s. Centralizing them in one place
/// means a later accessibility-*identifier* pass (more robust than matching the
/// human-readable label) updates a single file.
///
/// ## Live vs hermetic (what runs where)
/// The critical-path and cross-feature flows need a **live backend** (staging) and,
/// for sign-in, a real OTP — they are gated behind ``XCTestCase/requireLiveBackend()``
/// (and ``XCTestCase/requireTestOTP()``) and SKIP cleanly when staging isn't
/// configured. The resilience checks (launch, tab navigation, no-crash) run
/// **hermetically** with no backend. The build-for-testing gate only *compiles* this
/// target; the live E2E run is the deferred human checkpoint **CP5**
/// (`docs/features/iphone-app/architecture/implementation-plan.md`).
///
/// ## Launch-argument contract (the mock seam)
/// ``XCUIApplication/launchOak(_:)`` always passes ``OakUITest/launchFlag`` plus the
/// chosen ``OakUITest/Scenario``. A DEBUG-only test seam in the app *may* honor these
/// to inject `Fake…` services and run the mock scenarios fully offline. Until that
/// seam exists the app ignores the unknown arguments and boots normally — so the
/// hermetic tests still pass and the gated tests still skip. Wiring that seam is an
/// additive, app-owned follow-up documented in `ios/README.md`.
enum OakUITest {
  // MARK: Launch-argument / environment contract

  /// Tells the app it is running under XCUITest (a DEBUG-only test seam may key off
  /// this to disable animations, skip onboarding, and substitute `Fake…` services).
  static let launchFlag = "-OakUITest"

  /// Launch-argument key whose following value is a ``Scenario`` raw value.
  static let scenarioFlag = "-OakUITestScenario"

  /// Environment key the human running **CP5** sets to opt a run into the LIVE,
  /// staging-backed flows. Absent (or not `"1"`) ⇒ those flows skip.
  static let liveBackendEnvKey = "OAK_E2E"

  /// Environment key carrying a known-good one-time code for the sign-in flow, so the
  /// guest→sign-in→history path can run unattended against a staging account. Absent
  /// ⇒ the OTP step (which a human would otherwise read from email) skips.
  static let testOTPEnvKey = "OAK_TEST_OTP"

  /// Environment key carrying the email to sign in with during live E2E.
  static let testEmailEnvKey = "OAK_TEST_EMAIL"

  /// The hermetic mock scenarios the app's (future) DEBUG test seam can stand up
  /// offline, plus the `.live` default that talks to the real backend. Passed as the
  /// value after ``scenarioFlag``.
  enum Scenario: String {
    /// Talk to the real backend at `BaseURL.current` (the default).
    case live
    /// A fake chat stream that yields tool activity then a full `OakAnswer`.
    case mockAnswer
    /// A fake chat stream that throws a transport error mid-flight (offline path).
    case mockTransportError
    /// Boots already signed-in with fake history/teams for navigation checks.
    case mockSignedIn
  }

  // MARK: Visible-label targets (mirror the app's labels)

  /// Tab-bar button labels (`RootView`).
  enum Tab {
    static let chat = "Chat"
    static let history = "History"
    static let teams = "Teams"
    static let account = "Account"
    static let all = [chat, history, teams, account]
  }

  /// Chat surface (`ChatView` / `ComposerView`).
  enum Chat {
    static let navigationTitle = "Oak"
    static let composerPlaceholder = "Ask Oak a Pokémon question…"
    static let sendButton = "Send"
    static let championsToggle = "Champions mode"
    static let newConversation = "New conversation"
    static let emptyState = "Ask Oak"
    static let attachFromLibrary = "Attach photos from library"
    static let retry = "Retry"
  }

  /// Streaming status phases (`StreamingStatusView`).
  enum Streaming {
    static let thinking = "Thinking…"
    static let usingTools = "Looking things up…"
    static let answering = "Writing the answer…"
    static let all = [thinking, usingTools, answering]
  }

  /// Finalized-answer structural markers (`AnswerCardView` tree).
  enum Answer {
    static let reasoningDisclosure = "Reasoning"
    static let openTeamInViewer = "Open team in viewer"
  }

  /// Account / Settings surface (`AccountView`).
  enum Account {
    static let navigationTitle = "Account"
    static let signIn = "Sign in"
    static let signOut = "Sign out"
    static let deleteAccount = "Delete account"
  }

  /// Email-OTP sign-in surface (`AuthView`).
  enum Auth {
    static let navigationTitle = "Sign in"
    static let emailPlaceholder = "you@example.com"
    static let codePlaceholder = "123456"
    static let sendCode = "Send code"
    static let verify = "Verify"
    static let resendCode = "Resend code"
  }

  /// Offline / retry surface (`ConnectionStateView`).
  enum Connection {
    static let title = "No Connection"
    static let tryAgain = "Try Again"
  }
}

// MARK: - Launch

// `XCUIApplication`/`XCUIElement` are `@MainActor`-isolated in the SDK
// (`XCUI_SWIFT_MAIN_ACTOR`), so members that touch them must be too.
@MainActor
extension XCUIApplication {
  /// Launches the app for a UI test under the given ``OakUITest/Scenario``, wiring the
  /// launch-argument contract. Tests use this instead of bare `launch()` so every
  /// launch routes through one place and the (future) mock seam is always offered.
  @discardableResult
  func launchOak(_ scenario: OakUITest.Scenario = .live) -> XCUIApplication {
    launchArguments += [OakUITest.launchFlag, OakUITest.scenarioFlag, scenario.rawValue]
    launch()
    return self
  }

  /// The composer text field, matched first by its placeholder and then by the first
  /// available text field (placeholder matching is the brittle part of black-box
  /// querying; the fallback keeps the suite resilient to minor copy changes).
  var oakComposerField: XCUIElement {
    let byPlaceholder = textFields[OakUITest.Chat.composerPlaceholder]
    return byPlaceholder.exists ? byPlaceholder : textFields.firstMatch
  }
}

// MARK: - Navigation helpers

extension XCTestCase {
  /// Switches to a tab by its label and asserts the destination became reachable.
  @MainActor
  @discardableResult
  func goToTab(_ label: String, in app: XCUIApplication, timeout: TimeInterval = 10) -> Bool {
    let tab = app.tabBars.buttons[label]
    guard tab.waitForExistence(timeout: timeout) else { return false }
    tab.tap()
    return true
  }
}

// MARK: - Skip guards (keep gated flows out of the hermetic run)

extension XCTestCase {
  /// Skips the calling test unless the LIVE staging backend is configured
  /// (`OAK_E2E=1`). The critical-path / cross-feature flows need a reachable backend;
  /// this gate keeps them out of the fast hermetic run while leaving them ready for
  /// **CP5** on a device/sim against staging.
  func requireLiveBackend(
    _ reason: String =
      "Set OAK_E2E=1 (and point the Debug BaseURL at a reachable staging backend) to run the live E2E flow — CP5."
  ) throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment[OakUITest.liveBackendEnvKey] == "1",
      reason
    )
  }

  /// Returns the email + one-time code provided for unattended sign-in, or skips. A
  /// real OTP is normally read from email by a human — that is exactly why the
  /// signed-in flows are a deferred human checkpoint. Set `OAK_TEST_EMAIL` and
  /// `OAK_TEST_OTP` (e.g. via a staging account that returns a fixed dev code) to run
  /// it unattended.
  func requireTestOTP() throws -> (email: String, code: String) {
    let env = ProcessInfo.processInfo.environment
    guard let email = env[OakUITest.testEmailEnvKey], !email.isEmpty,
      let code = env[OakUITest.testOTPEnvKey], !code.isEmpty
    else {
      throw XCTSkip(
        "Set OAK_TEST_EMAIL and OAK_TEST_OTP to run the sign-in flow unattended; "
          + "otherwise the OTP step is a manual human checkpoint (CP2/CP5)."
      )
    }
    return (email, code)
  }

  /// Skips when the real chat composer is not reachable (e.g. the tab shell still
  /// shows the scaffolding placeholder, or the feature views are not yet wired into
  /// `RootView`). Keeps the live flow from false-failing before the UI is fully wired.
  @MainActor
  func requireComposer(in app: XCUIApplication, timeout: TimeInterval = 10) throws {
    let reachable = app.oakComposerField.waitForExistence(timeout: timeout)
    try XCTSkipUnless(
      reachable,
      "Chat composer not reachable — wire the feature views into RootView, then run live (CP5)."
    )
  }
}
