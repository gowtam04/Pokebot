import Foundation

/// The sign-in lifecycle seam (component-design.md "Services layer";
/// accounts-and-access.md M-ACCT-US-1/2/3/6). View models depend on this
/// **protocol** (never `LiveAuthService`) so they unit-test against `FakeAuthService`.
///
/// Every method is `async throws` and surfaces failures as the single typed
/// ``OakError``. Sign-in is passwordless email-OTP: ``requestCode(email:)`` mails a
/// 6-digit code, ``verify(email:code:)`` exchanges it for a session — storing the
/// raw Bearer token in the Keychain on success (M-BR-ACCT-5). ``me()`` reports the
/// current state on launch, ``signOut()`` returns to guest, and
/// ``deleteAccount()`` performs real backend deletion (M-BR-ACCT-6).
protocol AuthService: Sendable {
  /// Requests a one-time code be emailed to `email`.
  ///
  /// Maps the route's failures to ``OakError``: `invalid_email` (400) →
  /// `.http`, `rate_limited` (429) → `.rateLimited`, `email_failed` (502) →
  /// `.http`. The success path is non-enumerating (identical for new and
  /// returning emails), so there is nothing to return.
  func requestCode(email: String) async throws

  /// Verifies `code` for `email`. On success the raw session token is written to
  /// the Keychain (so it survives relaunch and rides every authed request as
  /// `Authorization: Bearer`) and the resolved ``Account`` is returned. A wrong
  /// or expired code throws an ``OakError`` (`invalid_code` /
  /// `invalid_or_expired` / `too_many_attempts`).
  func verify(email: String, code: String) async throws -> Account

  /// Reports the current auth state for launch restore: the request carries the
  /// stored Bearer token (when present); a valid token resolves to
  /// `.signedIn(email:)`, an absent or invalid token to `.guest` (the route
  /// returns guest as a first-class 200, never an error).
  func me() async throws -> AuthState

  /// Ends the device session: best-effort server revoke, then always clears the
  /// Keychain token so the app returns to guest. Idempotent — calling it without
  /// a session is a no-op (M-AC-3.1).
  func signOut() async throws

  /// Permanently deletes the account and all its server data, then clears the
  /// local token (M-ACCT-US-6 / M-BR-ACCT-6). A transport/HTTP failure (other
  /// than an already-orphaned token) propagates so the UI does not falsely claim
  /// deletion.
  func deleteAccount() async throws
}

/// The result of a successful ``AuthService/verify(email:code:)``.
///
/// `created` distinguishes a first-time signup (`true`, M-AC-2.3) from a returning
/// login (`false`, M-AC-2.4); the UI may greet a new account differently.
struct Account: Equatable, Sendable {
  let email: String
  let created: Bool
}

/// Production ``AuthService`` over ``OakAPIClient`` (the network) and
/// ``TokenStore`` (the Keychain).
///
/// A value type holding two immutable actor references, so it is `Sendable`
/// without ceremony. It owns the **only** policy decisions the auth surface needs:
/// when to persist the token (on `verify`) and when to clear it (on `signOut` /
/// `deleteAccount`). Wire shapes are decoded into ``AuthVerifyResponse`` /
/// ``MeResponse``; error mapping happens inside ``OakAPIClient``.
struct LiveAuthService: AuthService {
  private let apiClient: OakAPIClient
  private let tokenStore: TokenStore

  init(apiClient: OakAPIClient, tokenStore: TokenStore) {
    self.apiClient = apiClient
    self.tokenStore = tokenStore
  }

  func requestCode(email: String) async throws {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/auth/request-code",
      body: RequestCodeBody(email: email),
      requiresAuth: false
    )
    try await apiClient.sendNoContent(endpoint)
  }

  func verify(email: String, code: String) async throws -> Account {
    let endpoint = Endpoint(
      method: .post,
      path: "/api/auth/verify",
      body: VerifyBody(email: email, code: code),
      requiresAuth: false
    )
    let response = try await apiClient.send(endpoint, as: AuthVerifyResponse.self)
    // Persist the Bearer token (M-BR-ACCT-5) — the one place a token is stored.
    await tokenStore.set(response.token)
    return Account(email: response.email, created: response.created)
  }

  func me() async throws -> AuthState {
    let endpoint = Endpoint(method: .get, path: "/api/auth/me", requiresAuth: true)
    let response = try await apiClient.send(endpoint, as: MeResponse.self)
    if response.signedIn, let email = response.email {
      return .signedIn(email: email)
    }
    return .guest
  }

  func signOut() async throws {
    // Best-effort server revoke: a transport/HTTP failure must NOT block the
    // local return to guest, so it is logged (never swallowed silently) and the
    // token is cleared regardless. Idempotent (M-AC-3.1).
    let endpoint = Endpoint(method: .post, path: "/api/auth/signout", requiresAuth: true)
    do {
      try await apiClient.sendNoContent(endpoint)
    } catch {
      Log.auth.error("sign-out endpoint failed; clearing local token anyway")
    }
    await tokenStore.clear()
  }

  func deleteAccount() async throws {
    let endpoint = Endpoint(method: .delete, path: "/api/auth/account", requiresAuth: true)
    do {
      try await apiClient.sendNoContent(endpoint)
    } catch OakError.unauthorized {
      // The token is already orphaned (the account row is gone) — clearing the
      // local token completes the deletion from the device's point of view.
      Log.auth.info("account deletion saw 401 (already orphaned); clearing local token")
    }
    // Reached only on a confirmed 2xx delete or an already-orphaned 401: every
    // other failure (transport / 5xx / rate limit) propagated above with the
    // token intact, so the account is genuinely gone before we clear it.
    await tokenStore.clear()
  }
}

/// `POST /api/auth/request-code` body. `email` is identical on the wire, so no
/// `CodingKeys` are needed (the property name *is* the wire key).
private struct RequestCodeBody: Encodable, Sendable {
  let email: String
}

/// `POST /api/auth/verify` body. `email`/`code` are identical on the wire.
private struct VerifyBody: Encodable, Sendable {
  let email: String
  let code: String
}
