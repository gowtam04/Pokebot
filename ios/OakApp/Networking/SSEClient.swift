import Foundation

/// Opens the chat stream (`POST /api/chat`) and turns the SSE byte stream into an
/// `AsyncThrowingStream<SSEEvent, Error>` (component-design.md "Networking layer").
///
/// It borrows ``OakAPIClient`` to attach the Bearer header + base URL (and to own
/// the `URLSession`), feeds the response bytes line-by-line through ``SSEParser``,
/// and yields decoded events. Error contract (component-design.md "Interface
/// Definitions"):
///   * **Pre-stream HTTP failure** (rate limit, 413, 503, …): the non-2xx body is
///     read off the stream, mapped via ``OakError/validate(_:data:)``, and the
///     stream finishes by throwing that `OakError` before any event is yielded.
///   * **Transport drop mid-stream**: surfaces as a thrown `OakError.transport`.
///   * **SSE `error` event**: yielded as `.error(...)`, then the stream finishes
///     normally (transport faults ride this in-band event, per the wire contract).
///
/// The work runs in a child `Task` cancelled on stream termination, so a view that
/// disappears (or a new turn) tears down the connection.
struct SSEClient: Sendable {
  private let apiClient: OakAPIClient

  init(apiClient: OakAPIClient) {
    self.apiClient = apiClient
  }

  /// Opens the stream for one chat turn. The returned stream yields events until
  /// the terminal `answer`/`error` (or completion), then finishes.
  func stream(_ request: ChatRequest) -> AsyncThrowingStream<SSEEvent, Error> {
    let apiClient = self.apiClient
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          // Chat works for guests too: `requiresAuth` here means "attach the
          // Bearer token when signed in" (raises the rate limit + identity);
          // a guest simply sends no Authorization header. A pre-stream HTTP
          // failure throws an OakError out of `openByteStream` (mapped from the
          // non-2xx body), finishing the stream before any event is yielded.
          let endpoint = Endpoint(method: .post, path: "/api/chat", body: request, requiresAuth: true)
          let bytes = try await apiClient.openByteStream(endpoint)

          var parser = SSEParser()
          for try await line in bytes.lines {
            for event in try parser.consume(line: line) {
              continuation.yield(event)
            }
          }
          for event in try parser.finish() {
            continuation.yield(event)
          }
          continuation.finish()
        } catch let urlError as URLError where urlError.code == .cancelled {
          continuation.finish()
        } catch is CancellationError {
          continuation.finish()
        } catch let error as OakError {
          continuation.finish(throwing: error)
        } catch {
          continuation.finish(throwing: OakError.transportFailure(error))
        }
      }
      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }
}
