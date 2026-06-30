import Foundation

/// The single owner of the app's `URLSession`, base URL, and JSON coders, and the
/// only place that turns an ``Endpoint`` into a live request (component-design.md
/// "Networking layer"; conventions.md "Networking specifics").
///
/// An `actor`: the session and coders are shared mutable infrastructure, so all
/// access serializes through the actor. Services depend on this type to make typed
/// requests; ``SSEClient`` borrows it for the chat byte stream so the Bearer header
/// and base URL are attached identically.
///
/// Coders use **no** global key strategy — every wire type maps with explicit
/// `CodingKeys` (the payloads mix `snake_case` and `camelCase`), so a plain
/// `JSONEncoder`/`JSONDecoder` is correct (conventions.md "Naming").
actor OakAPIClient {
  private let baseURL: URL
  private let tokenStore: TokenStore
  private let session: URLSession
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(baseURL: URL, tokenStore: TokenStore, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.tokenStore = tokenStore
    self.session = session
  }

  /// Performs a request and decodes the 2xx body into `Response`.
  ///
  /// `Response` is `Sendable` (in addition to the documented `Decodable`) so the
  /// decoded value can cross the actor boundary back to the caller under Swift 6
  /// strict concurrency — every wire DTO already conforms.
  func send<Response: Decodable & Sendable>(_ endpoint: Endpoint, as type: Response.Type) async throws -> Response {
    let data = try await perform(endpoint)
    do {
      return try decoder.decode(Response.self, from: data)
    } catch {
      let typeName = "\(Response.self)"
      Log.network.error("decode failed for \(typeName, privacy: .public)")
      throw OakError.decoding(typeName)
    }
  }

  /// Performs a request whose 2xx body is ignored (e.g. `{ ok: true }`).
  func sendNoContent(_ endpoint: Endpoint) async throws {
    _ = try await perform(endpoint)
  }

  /// Opens a streaming (SSE) connection for `endpoint` and returns the raw byte
  /// stream once the response status is 2xx. Used only by ``SSEClient`` for
  /// `POST /api/chat`: it attaches the Bearer header + base URL exactly like a
  /// normal request, then overrides `Accept` to `text/event-stream`.
  ///
  /// A **pre-stream HTTP failure** (rate limit, 413, 503, …) is mapped here and
  /// thrown as an ``OakError``: the small `{ code, message }` body is read off the
  /// stream and run through ``OakError/validate(_:data:)``. The non-`Sendable`
  /// `HTTPURLResponse` never leaves the actor — only the `Sendable`
  /// `URLSession.AsyncBytes` crosses back to the caller.
  func openByteStream(_ endpoint: Endpoint) async throws -> URLSession.AsyncBytes {
    var request = try await buildRequest(endpoint)
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    do {
      (bytes, response) = try await session.bytes(for: request)
    } catch {
      throw OakError.transportFailure(error)
    }
    guard let http = response as? HTTPURLResponse else {
      throw OakError.transport(underlying: "non_http_response")
    }
    guard (200..<300).contains(http.statusCode) else {
      var body = Data()
      do {
        for try await byte in bytes {
          body.append(byte)
        }
      } catch {
        throw OakError.transportFailure(error)
      }
      if case .failure(let error) = OakError.validate(http, data: body) {
        throw error
      }
      throw OakError.transport(underlying: "unexpected_status_\(http.statusCode)")
    }
    return bytes
  }

  // MARK: - Internals

  /// Runs a non-streaming request and returns the validated 2xx body bytes,
  /// mapping every failure to ``OakError``.
  private func perform(_ endpoint: Endpoint) async throws -> Data {
    let request = try await buildRequest(endpoint)
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw OakError.transportFailure(error)
    }
    guard let http = response as? HTTPURLResponse else {
      throw OakError.transport(underlying: "non_http_response")
    }
    switch OakError.validate(http, data: data) {
    case .success(let body):
      return body
    case .failure(let error):
      Log.network.error(
        "\(endpoint.method.rawValue, privacy: .public) request failed with status \(http.statusCode, privacy: .public)"
      )
      throw error
    }
  }

  /// Resolves the token (when the endpoint wants auth) and assembles the request,
  /// mapping a build/encode failure to ``OakError``.
  private func buildRequest(_ endpoint: Endpoint) async throws -> URLRequest {
    let token = endpoint.requiresAuth ? await tokenStore.token() : nil
    do {
      return try endpoint.urlRequest(baseURL: baseURL, token: token, encoder: encoder)
    } catch let error as OakError {
      throw error
    } catch {
      throw OakError.transport(underlying: "request_encoding_failed")
    }
  }
}
