import Foundation
import UIKit

/// One chat turn → a live `SSEEvent` stream (component-design.md "Services layer";
/// chat-experience.md M-CHAT-US-1/4). View models depend on this **protocol**
/// (never `LiveChatService`) so they unit-test against `FakeChatService`.
///
/// The method is **synchronous** and returns an `AsyncThrowingStream<SSEEvent, Error>`
/// immediately: it runs in the caller's context (so passing the main-actor-held
/// `[UIImage]` is safe — there is no actor hop), then hands back the stream the
/// view-model's reducer consumes. Pre-stream HTTP failures (rate limit, 413, 503…)
/// surface as a thrown `OakError` from the stream before any event is yielded; an
/// in-band SSE `error` event (transport fault) arrives as `.error(...)`. Every
/// in-domain failure rides a normal `.answer` event whose `OakAnswer.status` carries
/// the failure — never the `error` channel (sse-types.ts).
protocol ChatService: Sendable {
  /// Opens the chat stream for one turn.
  ///
  /// - `sessionId`: the client thread UUID (equals the conversation id on resume).
  /// - `message`: 0–2000 chars; MAY be empty when `images` are attached.
  /// - `images`: attached photos (≤4), encoded to raw base64 with the client-side
  ///   caps enforced by `ImageEncoder`. A cap/type violation finishes the returned
  ///   stream by throwing `OakError.imageRejected(...)` before any event is yielded.
  /// - `championsMode`: scopes the turn to the Champions format when `true`.
  ///
  /// Saved teams are referenced **by name in chat** (resolved server-side via
  /// `list_teams` / `get_team`), so the body carries no team id.
  func send(
    sessionId: String,
    message: String,
    images: [UIImage],
    championsMode: Bool
  ) -> AsyncThrowingStream<SSEEvent, Error>
}

/// Production ``ChatService`` over ``SSEClient`` (which borrows ``OakAPIClient`` for
/// the Bearer header + base URL). A value type holding one immutable struct, so it
/// is `Sendable` without ceremony.
struct LiveChatService: ChatService {
  private let sseClient: SSEClient

  init(sseClient: SSEClient) {
    self.sseClient = sseClient
  }

  func send(
    sessionId: String,
    message: String,
    images: [UIImage],
    championsMode: Bool
  ) -> AsyncThrowingStream<SSEEvent, Error> {
    // Encode + validate the attached images BEFORE opening the stream (M-AC-5.5).
    // `encode` is synchronous and runs in the caller's context (the main actor),
    // so passing the main-actor-held `[UIImage]` involves no actor hop. A client
    // cap/type violation surfaces as a thrown `OakError.imageRejected(...)` from
    // the returned stream — never as a partially-attached turn.
    let encodedImages: [ChatImage]
    do {
      encodedImages = try ImageEncoder().encode(images)
    } catch let error as OakError {
      return AsyncThrowingStream { $0.finish(throwing: error) }
    } catch {
      // `encode` only throws `OakError`; map any unexpected error to a Sendable
      // `OakError` BEFORE the `@Sendable` stream closure captures it.
      let mapped = OakError.transportFailure(error)
      return AsyncThrowingStream { $0.finish(throwing: mapped) }
    }

    let request = ChatRequest(
      sessionId: sessionId,
      message: message,
      images: encodedImages.isEmpty ? nil : encodedImages,
      championsMode: championsMode
    )
    return sseClient.stream(request)
  }
}
