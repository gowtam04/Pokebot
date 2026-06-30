import Foundation
import Testing

@testable import OakApp

/// Round-trips the outbound `ChatRequest` body (testing-strategy.md "encode/decode
/// request bodies"). `ChatRequest` is `Encodable`-only, so the round-trip encodes
/// it and re-decodes through a wire mirror, asserting the snake_case mapping
/// (`session_id`, `champions_mode`) AND that the image's `mimeType` stays
/// camelCase — the exact mixed-convention case the explicit per-type `CodingKeys`
/// exist to handle.
struct ChatRequestEncodingTests {

  private func encodedObject(_ request: ChatRequest) throws -> [String: Any] {
    let data = try JSONEncoder().encode(request)
    let object = try JSONSerialization.jsonObject(with: data)
    return try #require(object as? [String: Any])
  }

  /// A text-only turn maps to snake_case keys and omits the optional `images` /
  /// `champions_mode` when nil.
  @Test
  func textOnlyTurnEncodesSnakeCaseAndOmitsNilOptionals() throws {
    let request = ChatRequest(
      sessionId: "sess-123",
      message: "What is Garchomp's typing?",
      images: nil,
      championsMode: nil
    )
    let object = try encodedObject(request)

    #expect(object["session_id"] as? String == "sess-123")
    #expect(object["message"] as? String == "What is Garchomp's typing?")
    // nil optionals are omitted (synthesized encode uses encodeIfPresent).
    #expect(object["champions_mode"] == nil)
    #expect(object["images"] == nil)
    // No camelCase leakage of the renamed keys.
    #expect(object["sessionId"] == nil)
    #expect(object["championsMode"] == nil)
  }

  /// An image-bearing turn may carry an empty `message`; `champions_mode` is
  /// present when set; each image keeps the camelCase `mimeType` and raw base64.
  @Test
  func imageTurnEncodesChampionsModeAndRawBase64Images() throws {
    let request = ChatRequest(
      sessionId: "sess-456",
      message: "",
      images: [
        ChatImage(mimeType: "image/jpeg", data: "AQIDBA=="),
        ChatImage(mimeType: "image/png", data: "BQYHCA=="),
      ],
      championsMode: true
    )
    let object = try encodedObject(request)

    #expect(object["session_id"] as? String == "sess-456")
    #expect(object["message"] as? String == "")
    #expect(object["champions_mode"] as? Bool == true)

    let images = try #require(object["images"] as? [[String: Any]])
    #expect(images.count == 2)
    // mimeType is intentionally camelCase on the wire (server re-sniffs anyway).
    #expect(images[0]["mimeType"] as? String == "image/jpeg")
    // Raw base64, no "data:" prefix.
    let raw = try #require(images[0]["data"] as? String)
    #expect(raw == "AQIDBA==")
    #expect(raw.hasPrefix("data:") == false)
  }

  /// Encode → decode (through a wire mirror) → field equality: a true round-trip
  /// that fails if any key name or value is dropped or coerced.
  @Test
  func roundTripsThroughWireMirror() throws {
    let request = ChatRequest(
      sessionId: "sess-789",
      message: "Build me a rain team",
      images: [ChatImage(mimeType: "image/webp", data: "CQoLDA==")],
      championsMode: false
    )
    let data = try JSONEncoder().encode(request)
    let mirror = try JSONDecoder().decode(ChatRequestWireMirror.self, from: data)

    #expect(mirror.sessionId == request.sessionId)
    #expect(mirror.message == request.message)
    #expect(mirror.championsMode == false)
    #expect(mirror.images?.count == 1)
    #expect(mirror.images?.first?.mimeType == "image/webp")
    #expect(mirror.images?.first?.data == "CQoLDA==")
  }
}

/// A `Decodable` mirror of the `ChatRequest` wire frame — the decode half of the
/// round-trip (the production `ChatRequest` is `Encodable`-only by design).
private struct ChatRequestWireMirror: Decodable, Equatable {
  let sessionId: String
  let message: String
  let championsMode: Bool?
  let images: [ImageMirror]?

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case message
    case championsMode = "champions_mode"
    case images
  }

  struct ImageMirror: Decodable, Equatable {
    let mimeType: String
    let data: String
  }
}
