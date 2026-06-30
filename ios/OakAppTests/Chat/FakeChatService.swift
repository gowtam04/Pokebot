import Foundation
import UIKit

@testable import OakApp

/// In-memory ``ChatService`` test double (testing-strategy.md "Mocking policy":
/// service protocols are faked for view-model unit tests). It records the call
/// parameters — crucially the `championsMode` flag — and replays a scripted sequence
/// of ``SSEEvent``s, optionally finishing with a thrown error to exercise the
/// reducer's transport-fault path.
///
/// `@unchecked Sendable`: the recording/config state is mutable, but every test
/// drives it serially from the main actor and awaits the stream, so there is no
/// concurrent access — the standard test-fake pattern.
final class FakeChatService: ChatService, @unchecked Sendable {
  // MARK: Configurable script

  /// Events yielded (in order) before the stream finishes.
  var scriptedEvents: [SSEEvent] = []

  /// When set, the stream finishes by THROWING this after yielding `scriptedEvents`
  /// (models a mid-stream transport drop / pre-stream HTTP failure). Typed
  /// ``OakError`` (a `Sendable` error) so it can be captured into the stream's
  /// `@Sendable` builder closure under Swift 6 strict concurrency.
  var thrownError: OakError?

  // MARK: Recording

  private(set) var sendCount = 0
  private(set) var lastSessionId: String?
  private(set) var lastMessage: String?
  private(set) var lastChampionsMode: Bool?
  private(set) var lastImageCount: Int?

  func send(
    sessionId: String,
    message: String,
    images: [UIImage],
    championsMode: Bool
  ) -> AsyncThrowingStream<SSEEvent, Error> {
    sendCount += 1
    lastSessionId = sessionId
    lastMessage = message
    lastChampionsMode = championsMode
    lastImageCount = images.count

    let events = scriptedEvents
    let error = thrownError
    return AsyncThrowingStream { continuation in
      for event in events {
        continuation.yield(event)
      }
      if let error {
        continuation.finish(throwing: error)
      } else {
        continuation.finish()
      }
    }
  }
}
