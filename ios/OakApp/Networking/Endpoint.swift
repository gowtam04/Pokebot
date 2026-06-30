import Foundation

/// A declarative description of one REST request, turned into a `URLRequest` by
/// ``OakAPIClient`` (conventions.md "Module boundaries" — only `Networking`
/// constructs `URLRequest`s).
///
/// An `Endpoint` is a pure value: path, method, query items, an optional
/// `Encodable` body, and a `requiresAuth` flag. It does **not** know the base URL,
/// the session, or the token — those belong to ``OakAPIClient``, which calls
/// ``urlRequest(baseURL:token:encoder:)`` to assemble the final request. Keeping
/// the encoder *owned by the client* but *applied here* concentrates request
/// assembly in one place while leaving JSON encode/decode configuration on the
/// actor.
///
/// `requiresAuth` means "attach the Bearer token when one is available": guest
/// turns simply send no `Authorization` header (the server treats the absence as a
/// guest), while a required-but-absent identity surfaces later as a `401`
/// (`OakError.unauthorized`). Truly public endpoints set it `false`.
struct Endpoint: Sendable {
  /// The HTTP verbs the Oak API uses.
  enum Method: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
  }

  /// The HTTP method.
  let method: Method
  /// An absolute path beginning with `/`, e.g. `/api/conversations`.
  let path: String
  /// Query items appended to the URL (empty ⇒ none).
  let queryItems: [URLQueryItem]
  /// An optional request body, JSON-encoded by the client's encoder.
  let body: (any Encodable & Sendable)?
  /// Whether to attach the Bearer token when one exists (see type doc).
  let requiresAuth: Bool

  init(
    method: Method,
    path: String,
    queryItems: [URLQueryItem] = [],
    body: (any Encodable & Sendable)? = nil,
    requiresAuth: Bool
  ) {
    self.method = method
    self.path = path
    self.queryItems = queryItems
    self.body = body
    self.requiresAuth = requiresAuth
  }

  /// Assembles the final `URLRequest`.
  ///
  /// - The URL is `baseURL` + `path` (+ query). The hosts in ``BaseURL`` carry no
  ///   path component, so the endpoint's absolute `path` becomes the URL path.
  /// - HTTPS is enforced (`OakError.transport("insecure_scheme")` otherwise) — a
  ///   defensive backstop to the App Transport Security policy.
  /// - The Bearer header is attached only when `requiresAuth` and a non-nil
  ///   `token` is supplied.
  /// - A non-nil `body` is JSON-encoded with the caller-owned `encoder` and sent
  ///   with `Content-Type: application/json`.
  func urlRequest(baseURL: URL, token: String?, encoder: JSONEncoder) throws -> URLRequest {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw OakError.transport(underlying: "invalid_base_url")
    }
    components.path = path
    if !queryItems.isEmpty {
      components.queryItems = queryItems
    }
    guard let url = components.url else {
      throw OakError.transport(underlying: "invalid_url")
    }
    guard url.scheme?.lowercased() == "https" else {
      throw OakError.transport(underlying: "insecure_scheme")
    }

    var request = URLRequest(url: url)
    request.httpMethod = method.rawValue
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if requiresAuth, let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.httpBody = try encoder.encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }
}
