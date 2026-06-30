import Foundation
import Security
import Synchronization

/// Process-wide in-memory backstop, engaged **only** when the Keychain is
/// genuinely unavailable rather than merely empty. The canonical case is an
/// unsigned simulator run (`CODE_SIGNING_ALLOWED=NO`, e.g. the CI test gate): with
/// no `application-identifier` / keychain-access-group entitlement, every Keychain
/// operation returns `errSecMissingEntitlement` (-34018). A normally code-signed
/// build (device / TestFlight / App Store) gets a default access group, so the real
/// Keychain always succeeds and this backstop is never written or read.
///
/// Keyed by `service + account` so independent stores never collide. Guarded by a
/// `Mutex` (Apple's `Synchronization` framework, iOS 18+) so it stays `Sendable`
/// and safe to share across `TokenStore` instances without an extra actor hop —
/// keeping `TokenStore`'s methods synchronous as documented in component-design.md.
private let keychainBackstop = Mutex<[String: String]>([:])

/// The one component that touches the Keychain (conventions.md "Module
/// boundaries"; data-model.md §B). Stores the raw session token returned by
/// `POST /api/auth/verify` so it survives relaunch and can be attached as
/// `Authorization: Bearer` on every authed request.
///
/// An `actor` so concurrent reads/writes from different tasks serialize safely.
/// The token is held as a `kSecClassGenericPassword` item keyed on the service
/// `us.optiwise.oak` + account `session-token`, accessible
/// `kSecAttrAccessibleAfterFirstUnlock` (readable in the background after the
/// first unlock following a reboot, never written off-device).
///
/// The token is **never logged** (conventions.md "Logging"); failures log only the
/// `OSStatus` code.
actor TokenStore {
  private let service: String
  private let account: String

  /// Backstop key — unique per (service, account) pair. `\u{0}` can't appear in
  /// either component, so it's an unambiguous separator.
  private var backstopKey: String { "\(service)\u{0}\(account)" }

  /// The production keys (service `us.optiwise.oak`, account `session-token`) are
  /// the defaults; tests may pass a unique account to avoid touching the real
  /// item.
  init(service: String = "us.optiwise.oak", account: String = "session-token") {
    self.service = service
    self.account = account
  }

  /// The stored token, or `nil` when none is present (guest) or the item is
  /// unreadable.
  func token() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      if let data = item as? Data, let token = String(data: data, encoding: .utf8) {
        return token
      }
      return nil
    case errSecItemNotFound:
      // Genuinely no token stored (guest).
      return nil
    default:
      // Keychain unavailable (e.g. -34018 in an unsigned simulator). Log the
      // status only — never the token — and read the in-memory backstop.
      Log.auth.error("Keychain read failed: \(Int(status), privacy: .public)")
      let key = backstopKey
      return keychainBackstop.withLock { $0[key] }
    }
  }

  /// Writes (or replaces) the token. Idempotent — an existing item is updated in
  /// place, otherwise a new item is added.
  func set(_ token: String) {
    let data = Data(token.utf8)
    let baseQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
    switch updateStatus {
    case errSecSuccess:
      return
    case errSecItemNotFound:
      var addQuery = baseQuery
      addQuery[kSecValueData as String] = data
      addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
      if addStatus != errSecSuccess {
        Log.auth.error("Keychain add failed: \(Int(addStatus), privacy: .public)")
        let key = backstopKey
        keychainBackstop.withLock { $0[key] = token }
      }
    default:
      // Keychain unavailable (e.g. -34018 in an unsigned simulator). Persist to the
      // in-memory backstop so the token still round-trips this process.
      Log.auth.error("Keychain update failed: \(Int(updateStatus), privacy: .public)")
      let key = backstopKey
      keychainBackstop.withLock { $0[key] = token }
    }
  }

  /// Deletes the token (sign-out / account deletion). Idempotent — a missing item
  /// is not an error.
  func clear() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecSuccess, status != errSecItemNotFound {
      Log.auth.error("Keychain delete failed: \(Int(status), privacy: .public)")
    }
    // Drop any in-memory backstop entry too (no-op in a signed build, where the
    // backstop is never populated).
    let key = backstopKey
    keychainBackstop.withLock { $0[key] = nil }
  }
}
