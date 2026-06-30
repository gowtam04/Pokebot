import Foundation
import Testing

@testable import OakApp

/// Verifies the `(HTTPURLResponse, Data) → success | OakError` mapping
/// (`OakError.validate`) and the transport-error wrapper (`OakError.transportFailure`)
/// against the api-design.md table: `2xx` → success, `401` → `.unauthorized`,
/// `429 (+Retry-After)` → `.rateLimited`, other non-2xx with a `{ code, message }`
/// envelope → `.http`, and a `URLSession` failure → `.transport`.
struct OakErrorMappingTests {

  private func response(_ status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
    HTTPURLResponse(
      url: URL(string: "https://oak-gowtam.fly.dev/api/test")!,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: headers
    )!
  }

  @Test
  func twoHundredReturnsBody() throws {
    let body = Data("{\"ok\":true}".utf8)
    let result = OakError.validate(response(200), data: body)
    guard case let .success(data) = result else {
      Issue.record("expected success, got \(result)")
      return
    }
    #expect(data == body)
  }

  @Test
  func twoOhFourReturnsEmptyBody() {
    let result = OakError.validate(response(204), data: Data())
    guard case .success = result else {
      Issue.record("expected success for 204, got \(result)")
      return
    }
  }

  @Test
  func unauthorizedMapsToUnauthorized() {
    let result = OakError.validate(response(401), data: Data())
    #expect(result == .failure(.unauthorized))
  }

  @Test
  func rateLimitedParsesNumericRetryAfter() {
    let result = OakError.validate(response(429, headers: ["Retry-After": "30"]), data: Data())
    #expect(result == .failure(.rateLimited(retryAfter: 30)))
  }

  @Test
  func rateLimitedWithoutRetryAfterHasNilDelta() {
    let result = OakError.validate(response(429), data: Data())
    #expect(result == .failure(.rateLimited(retryAfter: nil)))
  }

  @Test
  func clientErrorDecodesCodeMessageEnvelope() {
    let body = Data("{\"code\":\"invalid_request\",\"message\":\"Bad body\"}".utf8)
    let result = OakError.validate(response(400), data: body)
    #expect(result == .failure(.http(status: 400, code: "invalid_request", message: "Bad body")))
  }

  @Test
  func serverErrorDecodesCodeMessageEnvelope() {
    let body = Data("{\"code\":\"model_unavailable\",\"message\":\"Down\"}".utf8)
    let result = OakError.validate(response(503), data: body)
    #expect(result == .failure(.http(status: 503, code: "model_unavailable", message: "Down")))
  }

  @Test
  func nonEnvelopeBodyFallsBackToUnknownCode() {
    let result = OakError.validate(response(500), data: Data("not json".utf8))
    #expect(result == .failure(.http(status: 500, code: "unknown", message: "")))
  }

  @Test
  func transportFailureWrapsURLError() {
    let mapped = OakError.transportFailure(URLError(.notConnectedToInternet))
    guard case .transport = mapped else {
      Issue.record("expected .transport, got \(mapped)")
      return
    }
  }

  @Test
  func transportFailureWrapsArbitraryError() {
    struct Boom: Error {}
    let mapped = OakError.transportFailure(Boom())
    guard case .transport = mapped else {
      Issue.record("expected .transport, got \(mapped)")
      return
    }
  }
}
