import SwiftUI
import UIKit

/// Dependency container for the app's services, injected through the SwiftUI
/// environment so view models resolve **service protocols** (never `Live…`
/// concretes) and previews/tests can substitute stub implementations
/// (conventions.md "SwiftUI / state").
///
/// This is the app's **composition root**: `live()` constructs the real network
/// stack once (a single ``TokenStore`` + ``OakAPIClient``, shared by every
/// service) and the three feature services over it. Views read the container
/// from the environment and hand the needed service to a screen's view model —
/// e.g. `AccountViewModel(auth: services.auth, …)`.
///
/// Keeping the container itself `Sendable` is fine because every service protocol
/// is declared `: Sendable` (and each `Live…` service is a value type over an
/// immutable actor reference).
struct ServiceContainer: Sendable {
  /// The sign-in lifecycle (email-OTP request/verify, launch restore, sign-out,
  /// account deletion). Backed by ``LiveAuthService`` in production.
  let auth: any AuthService

  /// Durable, signed-in-only chat history (list, load, rename/pin/delete, the
  /// guest→sign-in import). Backed by ``LiveHistoryService`` in production.
  let history: any HistoryService

  /// One chat turn → a live `SSEEvent` stream. Backed by ``LiveChatService`` in
  /// production.
  let chat: any ChatService

  /// The production wiring (real `Live…` services).
  ///
  /// All three services share **one** ``TokenStore`` (the Keychain) and **one**
  /// ``OakAPIClient`` (the `URLSession`, base URL, and Bearer-header policy), so a
  /// token written on `verify` is read identically by every authed request and the
  /// chat byte stream alike. ``SSEClient`` borrows the same client for the chat
  /// stream.
  static func live() -> ServiceContainer {
    let tokenStore = TokenStore()
    let api = OakAPIClient(baseURL: BaseURL.current, tokenStore: tokenStore)
    return ServiceContainer(
      auth: LiveAuthService(apiClient: api, tokenStore: tokenStore),
      history: LiveHistoryService(apiClient: api),
      chat: LiveChatService(sseClient: SSEClient(apiClient: api))
    )
  }

  /// A preview/test-friendly container whose services never touch the network.
  ///
  /// In DEBUG it is built from the in-file `PreviewStub…` services below (so
  /// SwiftUI previews render instantly and offline); in release there is no preview
  /// surface, so it falls back to ``live()``.
  static func preview() -> ServiceContainer {
    #if DEBUG
    ServiceContainer(
      auth: PreviewStubAuthService(),
      history: PreviewStubHistoryService(),
      chat: PreviewStubChatService()
    )
    #else
    live()
    #endif
  }
}

private struct ServiceContainerKey: EnvironmentKey {
  static let defaultValue = ServiceContainer.live()
}

extension EnvironmentValues {
  /// The injected service container. Read it from a view, then hand the needed
  /// service to the screen's view model.
  var services: ServiceContainer {
    get { self[ServiceContainerKey.self] }
    set { self[ServiceContainerKey.self] = newValue }
  }
}

extension View {
  /// Injects the service container into the environment for descendant views.
  func oakServices(_ container: ServiceContainer) -> some View {
    environment(\.services, container)
  }
}

// MARK: - Preview stubs (DEBUG only)

#if DEBUG

/// No-network ``AuthService`` for SwiftUI previews: stays a guest, and `verify`
/// echoes back a returning ``Account`` so the auth flow renders without a server.
///
/// Named `PreviewStub…` (not `Fake…`) so it never collides with the `private`
/// per-view preview services already declared inside individual feature files.
struct PreviewStubAuthService: AuthService {
  func requestCode(email: String) async throws {}

  func verify(email: String, code: String) async throws -> Account {
    Account(email: email, created: false)
  }

  func me() async throws -> AuthState { .guest }

  func signOut() async throws {}

  func deleteAccount() async throws {}
}

/// No-network ``HistoryService`` for SwiftUI previews: an empty conversation list,
/// a trivially-empty detail on load, and a no-op import.
struct PreviewStubHistoryService: HistoryService {
  func list(query: String?, format: Format?) async throws -> [ConversationSummary] { [] }

  func get(id: String) async throws -> ConversationDetail {
    ConversationDetail(
      id: id,
      title: "Preview conversation",
      format: .scarletViolet,
      pinned: false,
      turns: []
    )
  }

  func rename(id: String, title: String) async throws {}

  func setPinned(id: String, pinned: Bool) async throws {}

  func delete(id: String) async throws {}

  func importGuestThread(
    sessionId: String,
    championsMode: Bool,
    turns: [ChatTurn]
  ) async throws -> String? { nil }
}

/// No-network ``ChatService`` for SwiftUI previews: a tiny scripted stream that
/// opens the answer and yields one markdown chunk, then finishes — enough for the
/// thread to render its streaming state without a server or terminal `OakAnswer`.
struct PreviewStubChatService: ChatService {
  func send(
    sessionId: String,
    message: String,
    images: [UIImage],
    championsMode: Bool
  ) -> AsyncThrowingStream<SSEEvent, Error> {
    AsyncThrowingStream { continuation in
      continuation.yield(.answerStart)
      continuation.yield(.answerDelta(text: "Preview answer."))
      continuation.finish()
    }
  }
}

#endif
