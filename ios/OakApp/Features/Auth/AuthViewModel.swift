import Foundation
import Observation

/// Drives the two-step email-OTP sign-in flow (accounts-and-access.md
/// M-ACCT-US-2): enter email → request a code, then enter the 6-digit code →
/// verify. On success it hands the resolved account to ``AppState`` so the whole
/// app transitions to signed-in.
///
/// `@MainActor @Observable` — all UI state mutates on the main actor and views
/// observe it directly. It depends on the ``AuthService`` **protocol** (never
/// `LiveAuthService`) so it is unit-tested against `FakeAuthService`
/// (testing-strategy.md "ViewModels").
///
/// Time is injected (`now`) rather than read from the wall clock so the 60-second
/// resend cooldown (``resendSecondsRemaining``) is deterministic in tests — no
/// real sleeping. The view re-reads the countdown each second via a
/// `TimelineView`; the value derives purely from `cooldownUntil` and `now()`.
@MainActor
@Observable
final class AuthViewModel {
  /// Which entry step the screen is showing.
  enum Step: Equatable {
    /// Collect the email address.
    case email
    /// Collect the 6-digit one-time code.
    case code
  }

  // MARK: Bindable input

  /// The email being entered (two-way bound from the email step).
  var email: String = ""
  /// The one-time code being entered (two-way bound; filled by OTP autofill).
  var code: String = ""

  // MARK: Observed flow state

  /// The current step in the sign-in flow.
  private(set) var step: Step = .email
  /// `true` while a `requestCode`/`verify` request is in flight (drives spinners
  /// and disables submit so a turn can't be double-sent).
  private(set) var isBusy: Bool = false
  /// A user-facing error message for the current step, or `nil` when clear.
  private(set) var errorMessage: String?
  /// A neutral confirmation (e.g. "code sent"), or `nil`.
  private(set) var noticeMessage: String?

  // MARK: Dependencies

  private let auth: any AuthService
  private let appState: AppState
  private let cooldownDuration: TimeInterval
  private let now: () -> Date

  /// When the resend cooldown ends; `nil` before a code has been requested.
  private var cooldownUntil: Date?

  init(
    auth: any AuthService,
    appState: AppState,
    cooldownDuration: TimeInterval = 60,
    now: @escaping () -> Date = { Date() }
  ) {
    self.auth = auth
    self.appState = appState
    self.cooldownDuration = cooldownDuration
    self.now = now
  }

  // MARK: Derived state

  /// The email normalized for submission (trimmed + lowercased).
  var normalizedEmail: String {
    email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  /// Whether the entered email looks well-formed enough to attempt a request
  /// (the server is the real authority and may still return `invalid_email`).
  var canSubmitEmail: Bool {
    Self.looksLikeEmail(normalizedEmail) && !isBusy
  }

  /// Whether the code field holds exactly six digits.
  var canSubmitCode: Bool {
    code.count == 6 && code.allSatisfy(\.isNumber) && !isBusy
  }

  /// Whole seconds remaining before another code can be requested (0 = ready).
  var resendSecondsRemaining: Int {
    guard let until = cooldownUntil else { return 0 }
    return max(0, Int(until.timeIntervalSince(now()).rounded(.up)))
  }

  /// Whether the resend action is currently allowed.
  var canResend: Bool {
    resendSecondsRemaining == 0 && !isBusy
  }

  /// The signed-in email once verification has completed (drives a success
  /// state and lets a presenter dismiss the sheet); `nil` while still a guest.
  var signedInEmail: String? {
    if case .signedIn(let email) = appState.authState { return email }
    return nil
  }

  // MARK: Actions

  /// Step 1: request a code for the entered email and advance to the code step.
  func submitEmail() async {
    guard canSubmitEmail else { return }
    await requestCode(advancingToCodeStep: true)
  }

  /// Re-send a fresh code (only while past the cooldown). A no-op otherwise.
  func resendCode() async {
    guard step == .code, canResend else { return }
    await requestCode(advancingToCodeStep: false)
  }

  /// Step 2: verify the entered code. On success, transition the app to
  /// signed-in via ``AppState``; on a stale/locked code, clear the field so the
  /// user re-enters or resends.
  func submitCode() async {
    guard step == .code, canSubmitCode else { return }
    errorMessage = nil
    noticeMessage = nil
    isBusy = true
    defer { isBusy = false }
    do {
      let account = try await auth.verify(email: normalizedEmail, code: code)
      // The token is now in the Keychain (the service stored it); flip app state.
      // The guest→sign-in thread import is wired in a later phase (HistoryService);
      // the on-screen thread is preserved regardless (M-AC-4.1).
      appState.completeSignIn(email: account.email)
    } catch let error as OakError {
      errorMessage = Self.verifyMessage(for: error)
      if Self.shouldClearCode(after: error) {
        code = ""
      }
    } catch {
      errorMessage = Self.genericErrorMessage
    }
  }

  /// Return to the email step (e.g. "use a different email"), resetting code +
  /// cooldown.
  func editEmail() {
    step = .email
    code = ""
    errorMessage = nil
    noticeMessage = nil
    cooldownUntil = nil
  }

  // MARK: Internals

  /// Shared request-code path for both the first send and a resend.
  private func requestCode(advancingToCodeStep: Bool) async {
    errorMessage = nil
    noticeMessage = nil
    isBusy = true
    defer { isBusy = false }
    do {
      try await auth.requestCode(email: normalizedEmail)
      if advancingToCodeStep {
        step = .code
        code = ""
      }
      cooldownUntil = now().addingTimeInterval(cooldownDuration)
      noticeMessage = "We sent a 6-digit code to \(normalizedEmail)."
    } catch let error as OakError {
      errorMessage = Self.requestCodeMessage(for: error)
    } catch {
      errorMessage = Self.genericErrorMessage
    }
  }

  // MARK: Validation + error copy (static, so tests assert exact strings)

  /// Generic fallback used for the (should-be-impossible) non-`OakError` path.
  static let genericErrorMessage = "Something went wrong. Please try again."

  /// A minimal client-side shape check — local + domain around a single `@`,
  /// with a dot in the domain. The server does authoritative validation.
  static func looksLikeEmail(_ value: String) -> Bool {
    let parts = value.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    let local = parts[0]
    let domain = parts[1]
    return !local.isEmpty && domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
  }

  /// Maps a `requestCode` failure to user-facing copy (accounts-and-access.md
  /// M-AC-5.1: specific, not generic).
  static func requestCodeMessage(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited(let retryAfter):
      return rateLimitMessage(retryAfter: retryAfter)
    case .http(_, let code, _):
      switch code {
      case "invalid_email": return "Enter a valid email address."
      case "email_failed": return "We couldn't send your code right now. Please try again."
      default: return genericErrorMessage
      }
    case .unauthorized, .decoding, .imageRejected:
      return genericErrorMessage
    }
  }

  /// Maps a `verify` failure to user-facing copy (M-AC-2.2).
  static func verifyMessage(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited(let retryAfter):
      return rateLimitMessage(retryAfter: retryAfter)
    case .http(_, let code, _):
      switch code {
      case "invalid_code": return "That code is incorrect. Please try again."
      case "invalid_or_expired": return "That code is no longer valid. Request a new one."
      case "too_many_attempts": return "Too many incorrect attempts. Request a new code."
      default: return genericErrorMessage
      }
    case .unauthorized, .decoding, .imageRejected:
      return genericErrorMessage
    }
  }

  /// The OTP throttle message (request/verify caps), with the wait when known.
  static func rateLimitMessage(retryAfter: TimeInterval?) -> String {
    if let seconds = retryAfter, seconds > 0 {
      let whole = Int(seconds.rounded(.up))
      return "Too many attempts. Please wait \(whole)s and try again."
    }
    return "Too many attempts. Please wait a moment and try again."
  }

  /// Shown for a transport fault (no connection).
  static let connectionMessage = "No connection. Check your network and try again."

  /// A stale/locked code should be cleared so the next attempt starts fresh; a
  /// merely-wrong code is left in place so the user can correct a digit.
  private static func shouldClearCode(after error: OakError) -> Bool {
    if case .http(_, let code, _) = error {
      return code == "invalid_or_expired" || code == "too_many_attempts"
    }
    return false
  }
}
