import Foundation

/// Opens the chat stream (`POST /api/chat`) and turns the SSE byte stream into an
/// `AsyncThrowingStream<SSEEvent, Error>` (component-design.md "Networking layer").
///
/// It borrows ``OakAPIClient`` to attach the Bearer header + base URL (and to own
/// the `URLSession`), splits the response bytes into lines via ``ByteLineSplitter``
/// (NOT `URLSession.AsyncBytes.lines`, which drops the empty lines SSE needs to
/// delimit frames — see ``ByteLineSplitter``), feeds each line through ``SSEParser``,
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

          // Split bytes into lines OURSELVES, preserving empty lines. SSE delimits
          // each event with a blank line (`event: …\ndata: …\n\n`) and `SSEParser`
          // dispatches a frame on that blank line — but `bytes.lines`
          // (`AsyncLineSequence`) silently drops empty lines, which collapses every
          // event's `data:` together and makes the terminal `answer` fail to decode.
          var parser = SSEParser()
          var splitter = ByteLineSplitter()
          for try await byte in bytes {
            guard let line = splitter.consume(byte) else { continue }
            for event in try parser.consume(line: line) {
              continuation.yield(event)
            }
          }
          // Flush a final, unterminated line (a stream that doesn't end in `\n`).
          if let line = splitter.finish() {
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

/// Splits a raw byte stream into lines, **preserving empty lines** — the piece SSE
/// needs that `URLSession.AsyncBytes.lines` gets wrong.
///
/// `AsyncLineSequence` (what `bytes.lines` yields) silently drops empty lines. SSE
/// delimits each event with a blank line (`event: …\ndata: …\n\n`), and
/// ``SSEParser`` relies on that blank line to dispatch a frame; without it the
/// parser concatenates every event's `data:` payload and the terminal `answer`
/// fails to decode (the whole chat stream breaks). This splitter emits a line on
/// every `\n` (`0x0A`) — including the empty string between consecutive newlines.
///
/// Splitting on the ASCII byte `0x0A` is UTF-8-safe: `0x0A` never appears inside a
/// multi-byte UTF-8 sequence, so each accumulated line decodes whole. A trailing
/// `\r` (CRLF input) is intentionally left on the line for ``SSEParser`` to strip.
///
/// Pure and synchronous (no I/O, no actor), so it's trivially unit-testable against
/// recorded byte buffers.
struct ByteLineSplitter {
  private var buffer = [UInt8]()

  /// Feeds one byte. Returns the completed line when `byte` is a newline (`0x0A`),
  /// including an empty string for a blank line; returns `nil` otherwise.
  mutating func consume(_ byte: UInt8) -> String? {
    if byte == 0x0A {
      let line = String(decoding: buffer, as: UTF8.self)
      buffer.removeAll(keepingCapacity: true)
      return line
    }
    buffer.append(byte)
    return nil
  }

  /// Returns any buffered final line not terminated by a newline, or `nil` when the
  /// stream ended cleanly on a `\n`.
  mutating func finish() -> String? {
    guard !buffer.isEmpty else { return nil }
    let line = String(decoding: buffer, as: UTF8.self)
    buffer.removeAll(keepingCapacity: true)
    return line
  }
}
