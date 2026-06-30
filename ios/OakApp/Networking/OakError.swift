import Foundation

/// The single typed error domain for the networking + service layers
/// (conventions.md "Error handling", api-design.md "Error Handling").
///
/// Everything that can fail a network call surfaces as one of these cases, so the
/// view models have a single thing to `catch` and map to UI state. **In-domain
/// failures are NOT errors** — a non-`answered` `OakAnswer`, an entity
/// `not_found`/`unavailable`, and team `validation` warnings are normal *values*
/// returned and rendered, never thrown (mirrors the backend's "never throw
/// in-domain" stance). `OakError` is reserved for transport/HTTP-level faults.
enum OakError: Error, Equatable, Sendable {
  /// No connection / a `URLSession` (transport) failure with no usable HTTP
  /// response. `underlying` is a short, non-sensitive diagnostic label (never a
  /// payload, token, or message).
  case transport(underlying: String)
  /// A non-2xx response carrying the `{ code, message }` envelope (4xx/5xx that
  /// is neither a 401 nor a 429).
  case http(status: Int, code: String, message: String)
  /// `429 Too Many Requests`; `retryAfter` is parsed from the `Retry-After`
  /// header when present (seconds, or an HTTP-date converted to a delta).
  case rateLimited(retryAfter: TimeInterval?)
  /// `401 Unauthorized` on a call that carried (or required) a Bearer token — the
  /// client drops the token, returns to guest, and prompts re-sign-in.
  case unauthorized
  /// A DTO mismatch decoding a 2xx body. Should be impossible if the Swift
  /// mirrors match the wire (guarded by the Phase 3 contract tests). The string
  /// is the offending type name, never the payload.
  case decoding(String)
  /// An attached image failed the client-side caps before the request opened.
  case imageRejected(reason: ImageRejectReason)
}

/// Why the client rejected an attached image before sending (mirrors the server's
/// `@/server/image-upload` caps so the user gets a fast, local reason).
enum ImageRejectReason: Equatable, Sendable {
  /// More than 4 images attached.
  case tooMany
  /// A single image exceeds the per-image decoded-byte cap.
  case perImageTooLarge
  /// The images together exceed the total decoded-byte cap.
  case totalTooLarge
  /// The image is not one of the accepted types (JPEG/PNG/GIF/WebP).
  case unsupportedType
}

extension OakError {
  /// Maps a completed HTTP response to either the success body or an `OakError`
  /// (api-design.md "Error Handling"):
  ///   * `2xx`                          → `.success(data)`
  ///   * `401`                          → `.unauthorized`
  ///   * `429` (+ optional `Retry-After`) → `.rateLimited(retryAfter:)`
  ///   * any other non-2xx              → `.http(status:code:message:)` from the
  ///                                       `{ code, message }` envelope
  ///
  /// Transport faults never reach here (there is no `HTTPURLResponse`); the caller
  /// wraps a thrown `URLSession` error via ``transportFailure(_:)``.
  static func validate(_ response: HTTPURLResponse, data: Data) -> Result<Data, OakError> {
    let status = response.statusCode
    switch status {
    case 200..<300:
      return .success(data)
    case 401:
      return .failure(.unauthorized)
    case 429:
      return .failure(.rateLimited(retryAfter: retryAfterSeconds(from: response)))
    default:
      return .failure(httpError(status: status, data: data))
    }
  }

  /// Wraps a thrown transport/`URLSession` error into ``transport(underlying:)``.
  /// The label is a stable, non-sensitive identifier (a `URLError` code, or the
  /// error's type name) — never the request body or any user data.
  static func transportFailure(_ error: Error) -> OakError {
    if let urlError = error as? URLError {
      return .transport(underlying: "URLError.\(urlError.code.rawValue)")
    }
    return .transport(underlying: "\(type(of: error))")
  }

  /// Builds an `.http` error from a non-2xx (non-401/429) body, decoding the
  /// shared `{ code, message }` envelope when present.
  private static func httpError(status: Int, data: Data) -> OakError {
    if let body = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
      return .http(status: status, code: body.code, message: body.message)
    }
    return .http(status: status, code: "unknown", message: "")
  }

  /// Parses the `Retry-After` header into seconds. Accepts a numeric
  /// delta-seconds value (the form the backend sends) and falls back to an
  /// HTTP-date, converting it to a delta from now.
  private static func retryAfterSeconds(from response: HTTPURLResponse) -> TimeInterval? {
    guard let raw = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    if let seconds = TimeInterval(trimmed) {
      return seconds
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    if let date = formatter.date(from: trimmed) {
      return max(0, date.timeIntervalSinceNow)
    }
    return nil
  }
}
