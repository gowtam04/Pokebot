import Foundation

@testable import OakApp

/// In-memory ``AuthService`` test double (testing-strategy.md "Mocking policy":
/// service protocols are faked for view-model unit tests). Each method's outcome is
/// configurable, and calls are recorded so tests can assert behavior — including a
/// `storedToken` field that models the Keychain so "verify stores a token" /
/// "signOut clears it" are observable without touching the real Keychain.
///
/// `@unchecked Sendable`: the recording/config state is mutable, but every test
/// drives it serially from the main actor and `await`s each call, so there is no
/// concurrent access. This is the standard pattern for a test fake.
final class FakeAuthService: AuthService, @unchecked Sendable {
  // MARK: Configurable outcomes

  var requestCodeResult: Result<Void, OakError> = .success(())
  var verifyResult: Result<Account, OakError> = .success(Account(email: "ash@pallet.town", created: false))
  var meResult: Result<AuthState, OakError> = .success(.guest)
  /// Thrown (if set) by ``signOut()`` *after* the local token is cleared, modeling
  /// a failed server revoke that must not block returning to guest.
  var signOutError: OakError?
  var deleteResult: Result<Void, OakError> = .success(())

  // MARK: Recording

  private(set) var requestCodeCount = 0
  private(set) var verifyCount = 0
  private(set) var meCount = 0
  private(set) var signOutCount = 0
  private(set) var deleteCount = 0
  private(set) var lastRequestedEmail: String?
  private(set) var lastVerifiedEmail: String?
  private(set) var lastVerifiedCode: String?

  /// Models the Keychain token: set by a successful ``verify`` (or seeded by a
  /// test to model an already-signed-in device), cleared by ``signOut`` /
  /// ``deleteAccount``.
  var storedToken: String?

  // MARK: AuthService

  func requestCode(email: String) async throws {
    requestCodeCount += 1
    lastRequestedEmail = email
    try requestCodeResult.get()
  }

  func verify(email: String, code: String) async throws -> Account {
    verifyCount += 1
    lastVerifiedEmail = email
    lastVerifiedCode = code
    let account = try verifyResult.get()
    storedToken = "fake-session-token"
    return account
  }

  func me() async throws -> AuthState {
    meCount += 1
    return try meResult.get()
  }

  func signOut() async throws {
    signOutCount += 1
    storedToken = nil
    if let signOutError {
      throw signOutError
    }
  }

  func deleteAccount() async throws {
    deleteCount += 1
    try deleteResult.get()
    storedToken = nil
  }
}
