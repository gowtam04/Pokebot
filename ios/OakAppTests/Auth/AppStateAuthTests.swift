import Foundation
import Testing

@testable import OakApp

/// `AppState` auth transitions against `FakeAuthService` (P5 AppState extension):
/// launch restore, sign-out clears the token, a 401 returns to guest, and account
/// deletion. `AppState` is `@MainActor`, so the suite is too.
@MainActor
struct AppStateAuthTests {

  // MARK: Restore on launch

  @Test
  func restoreSessionSignsInWithValidToken() async {
    let fake = FakeAuthService()
    fake.meResult = .success(.signedIn(email: "ash@pallet.town"))
    let state = AppState()

    await state.restoreSession(using: fake)

    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
    #expect(fake.meCount == 1)
  }

  @Test
  func restoreSessionStaysGuestWithoutToken() async {
    let fake = FakeAuthService()
    fake.meResult = .success(.guest)
    let state = AppState()

    await state.restoreSession(using: fake)

    #expect(state.authState == .guest)
  }

  @Test
  func restoreSessionTransportFailureRemainsGuest() async {
    let fake = FakeAuthService()
    fake.meResult = .failure(.transport(underlying: "URLError.-1009"))
    let state = AppState()

    await state.restoreSession(using: fake)

    #expect(state.authState == .guest)  // never throws; keeps the launch default
  }

  // MARK: Sign out

  @Test
  func signOutClearsTokenAndReturnsToGuest() async {
    let fake = FakeAuthService()
    fake.storedToken = "fake-session-token"  // model a signed-in device
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")
    state.activeConversationId = "conv-1"

    await state.signOut(using: fake)

    #expect(fake.signOutCount == 1)
    #expect(fake.storedToken == nil)  // credentials removed from the device
    #expect(state.authState == .guest)
    #expect(state.activeConversationId == nil)
  }

  @Test
  func signOutReturnsToGuestEvenWhenEndpointFails() async {
    let fake = FakeAuthService()
    fake.storedToken = "fake-session-token"
    fake.signOutError = .transport(underlying: "URLError.-1009")
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")

    await state.signOut(using: fake)

    #expect(fake.storedToken == nil)  // cleared before the (swallowed) revoke error
    #expect(state.authState == .guest)
  }

  // MARK: Expiry / 401

  @Test
  func unauthorizedDropsTokenAndReturnsToGuest() async {
    let fake = FakeAuthService()
    fake.storedToken = "stale-token"
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")
    state.activeConversationId = "conv-1"

    await state.handleUnauthorized(using: fake)

    #expect(state.authState == .guest)  // expiry → guest
    #expect(fake.storedToken == nil)
    #expect(state.activeConversationId == nil)
  }

  // MARK: Account deletion

  @Test
  func deleteAccountReturnsToGuestOnSuccess() async throws {
    let fake = FakeAuthService()
    fake.storedToken = "fake-session-token"
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")

    try await state.deleteAccount(using: fake)

    #expect(fake.deleteCount == 1)
    #expect(fake.storedToken == nil)
    #expect(state.authState == .guest)
  }

  @Test
  func deleteAccountFailurePropagatesAndStaysSignedIn() async {
    let fake = FakeAuthService()
    fake.storedToken = "fake-session-token"
    fake.deleteResult = .failure(.transport(underlying: "URLError.-1009"))
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")

    await #expect(throws: OakError.self) {
      try await state.deleteAccount(using: fake)
    }

    // The server delete failed → token intact, still signed in (no false success).
    #expect(fake.storedToken == "fake-session-token")
    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
  }
}
