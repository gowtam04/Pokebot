import Foundation
import Observation

/// Drives the Account / Settings surface (component-design.md "AccountViewModel";
/// M-UI-US-7): it reflects the current tier (guest vs signed-in), runs sign-out,
/// and owns the **account-deletion confirm flow** (M-ACCT-US-6 / M-NFR-6 — the App
/// Store deletion requirement).
///
/// `@MainActor @Observable` — all UI state mutates on the main actor and views
/// observe it directly. It depends on the ``AuthService`` **protocol** (never
/// `LiveAuthService`) so it unit-tests against `FakeAuthService`
/// (testing-strategy.md "ViewModels"), and reads/flips ``AppState`` for the
/// session transitions (whose own tests cover the token-clearing + return-to-guest
/// behavior). The view model adds no policy of its own beyond mapping a failed
/// deletion to user-facing copy and gating the busy state.
@MainActor
@Observable
final class AccountViewModel {
  // MARK: Dependencies

  private let auth: any AuthService
  private let appState: AppState

  // MARK: Observed state

  /// `true` while a sign-out or deletion request is in flight (drives a spinner
  /// and disables the destructive actions so they can't be double-fired).
  private(set) var isBusy = false

  /// A user-facing error for a failed sign-out/deletion, or `nil` when clear.
  /// In-domain success never sets this — the deletion either completes (and
  /// `AppState` flips to guest) or this surfaces a recoverable message.
  private(set) var errorMessage: String?

  init(auth: any AuthService, appState: AppState) {
    self.auth = auth
    self.appState = appState
  }

  // MARK: Derived session state

  /// The current auth state, mirrored from ``AppState`` so the view reacts to
  /// sign-in/out/deletion without holding its own copy.
  var authState: AuthState {
    appState.authState
  }

  /// Whether the user is signed in (gates the sign-out + delete-account controls).
  var isSignedIn: Bool {
    if case .signedIn = appState.authState { return true }
    return false
  }

  /// The signed-in email, or `nil` for a guest.
  var email: String? {
    if case .signedIn(let email) = appState.authState { return email }
    return nil
  }

  // MARK: Tier / limit indication (M-AC-1.2, M-AC-5.1)

  /// A short tier label, paired with text in the UI so the tier is never carried
  /// by color alone (M-AC-UI9.3).
  var tierTitle: String {
    isSignedIn ? Self.signedInTierTitle : Self.guestTierTitle
  }

  /// A qualitative description of the current tier's limit and what it unlocks.
  /// Deliberately qualitative — the exact rate-limit numbers are enforced
  /// server-side and must not be hard-coded into the client (M-BR-ACCT-4).
  var tierDescription: String {
    isSignedIn ? Self.signedInTierDescription : Self.guestTierDescription
  }

  // MARK: Actions

  /// Signs out and returns to guest (M-ACCT-US-3). Best-effort server revoke + a
  /// local Keychain clear happen inside ``AppState/signOut(using:)``, which never
  /// throws — so this always lands the device back on guest.
  func signOut() async {
    errorMessage = nil
    isBusy = true
    defer { isBusy = false }
    await appState.signOut(using: auth)
  }

  /// Permanently deletes the account and its server data, then returns to guest
  /// (M-ACCT-US-6 / M-BR-ACCT-6). A real backend failure is mapped to a recoverable
  /// message and the user stays signed in — the UI must never falsely claim a
  /// deletion that did not happen. On success ``AppState`` has already flipped to
  /// guest and cleared the token.
  func deleteAccount() async {
    errorMessage = nil
    isBusy = true
    defer { isBusy = false }
    do {
      try await appState.deleteAccount(using: auth)
    } catch let error as OakError {
      Log.auth.error("account deletion failed; staying signed in")
      errorMessage = Self.deletionMessage(for: error)
    } catch {
      errorMessage = Self.deletionFailedMessage
    }
  }

  /// Clears the current error message (e.g. when the user dismisses the banner).
  func dismissError() {
    errorMessage = nil
  }

  // MARK: Sign-in handoff

  /// Builds the ``AuthViewModel`` for the sign-in sheet, keeping the
  /// ``AuthService`` inside this view model so the view never holds a service
  /// directly (conventions.md "Module boundaries"). The shared ``AppState`` is
  /// reused so a completed verification flips the whole app to signed-in.
  func makeAuthViewModel() -> AuthViewModel {
    AuthViewModel(auth: auth, appState: appState)
  }

  // MARK: Copy (static, so tests assert the exact strings)

  static let guestTierTitle = "Guest"
  static let signedInTierTitle = "Signed in"

  static let guestTierDescription =
    "You're using Oak as a guest, with the lower usage limit. Sign in to raise your limit and unlock saved history and the team builder."
  static let signedInTierDescription =
    "You're signed in, with the higher usage limit plus saved history and the team builder across your devices."

  /// The explanatory body shown in the deletion confirmation (M-AC-6.2): names
  /// exactly what is removed so the consent is informed.
  static let deletionWarning =
    "This permanently deletes your account, your saved conversations, and your saved teams. This can't be undone."

  static let connectionMessage = "No connection. Check your network and try again."
  static let deletionFailedMessage =
    "We couldn't delete your account right now. Please try again."

  /// Maps a failed deletion/sign-out to user-facing copy. A transport fault gets
  /// the specific connection message (so the user knows to check the network);
  /// every other fault gets the generic deletion-failed message rather than
  /// leaking a status code.
  static func deletionMessage(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited, .unauthorized, .http, .decoding, .imageRejected:
      return deletionFailedMessage
    }
  }
}
