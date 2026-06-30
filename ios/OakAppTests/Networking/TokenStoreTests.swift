import Foundation
import Testing

@testable import OakApp

/// Exercises ``TokenStore`` against the real test Keychain (testing-strategy.md
/// "Mocking policy": Keychain is real, not faked). Each test uses a unique account
/// name so it never collides with the production `session-token` item, and clears
/// the item at the end. Covers the CRUD round-trip, overwrite, idempotent clear,
/// and that a freshly written token reads back like a relaunch (a separate
/// `TokenStore` instance over the same account).
struct TokenStoreTests {

  /// A fresh, unique account so concurrent tests / the real app never interfere.
  private func makeStore() -> (store: TokenStore, account: String) {
    let account = "test-session-token-\(UUID().uuidString)"
    return (TokenStore(account: account), account)
  }

  @Test
  func setThenTokenRoundTrips() async {
    let (store, _) = makeStore()

    #expect(await store.token() == nil)
    await store.set("abc123")
    #expect(await store.token() == "abc123")

    await store.clear()
    #expect(await store.token() == nil)
  }

  @Test
  func setOverwritesExistingToken() async {
    let (store, _) = makeStore()

    await store.set("first")
    await store.set("second")
    #expect(await store.token() == "second")

    await store.clear()
  }

  @Test
  func clearIsIdempotent() async {
    let (store, _) = makeStore()

    // Clearing an absent item must not crash or error.
    await store.clear()
    await store.clear()
    #expect(await store.token() == nil)
  }

  @Test
  func tokenSurvivesAcrossInstances() async {
    let (writer, account) = makeStore()
    await writer.set("persisted-token")

    // A new instance over the same account models a relaunch reading the Keychain.
    let reader = TokenStore(account: account)
    #expect(await reader.token() == "persisted-token")

    await writer.clear()
    #expect(await reader.token() == nil)
  }
}
