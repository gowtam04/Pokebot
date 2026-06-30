import Testing
@testable import OakApp

/// P1 smoke tests: prove the unit target builds against the app module, Swift
/// Testing runs, and the scaffolding defaults are sane. Deeper coverage arrives
/// with the layers each later phase adds.
struct SmokeTests {
  @Test
  func arithmeticSanity() {
    #expect(2 + 2 == 4)
  }

  @MainActor
  @Test
  func appStateStartsAsGuest() {
    let state = AppState()
    #expect(state.authState == .guest)
    #expect(state.activeConversationId == nil)
    #expect(state.guestThread.isEmpty)
    #expect(state.championsMode == false)
  }

  @Test
  func baseURLUsesHTTPS() {
    #expect(BaseURL.current.scheme == "https")
  }

  @Test
  func typeColorFallsBackToNormalForUnknownName() {
    // Known and unknown names both resolve to a usable color (no crash / no nil).
    _ = Theme.type("fire")
    _ = Theme.type("definitely-not-a-type")
  }
}
