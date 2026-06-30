import Foundation
import Testing

@testable import OakApp

/// `JSONScalar` is the value type for the free-form `Record<string, scalar>` maps
/// the server emits inside `submit_answer` (candidate `key_stats`, `damage_calc`
/// assumptions/result). These tests prove every scalar shape round-trips without
/// loss or coercion — whole numbers stay `Int` (not `5.0`), booleans stay `Bool`
/// (not `1`), and a heterogeneous map survives a full decode → encode → decode.
struct JSONScalarRoundTripTests {

  /// Decode one scalar from a JSON literal via a single-key box (avoids any
  /// top-level-fragment ambiguity across Foundation versions).
  private func scalar(fromJSONLiteral literal: String) throws -> JSONScalar {
    let json = "{\"value\":\(literal)}"
    return try JSONDecoder().decode(ScalarBox.self, from: Data(json.utf8)).value
  }

  /// Each JSON scalar decodes to the expected case — and bool/int are NOT
  /// coerced into each other (the decode order in `JSONScalar` guards this).
  @Test
  func decodesEachScalarToItsCase() throws {
    #expect(try scalar(fromJSONLiteral: "\"hello\"") == .string("hello"))
    #expect(try scalar(fromJSONLiteral: "142") == .int(142))
    #expect(try scalar(fromJSONLiteral: "9.5") == .double(9.5))
    #expect(try scalar(fromJSONLiteral: "true") == .bool(true))
    #expect(try scalar(fromJSONLiteral: "false") == .bool(false))
    #expect(try scalar(fromJSONLiteral: "null") == .null)
    // A whole number must NOT decode as a Double, and a bool must NOT become 1/0.
    #expect(try scalar(fromJSONLiteral: "5") != .double(5))
    #expect(try scalar(fromJSONLiteral: "1") != .bool(true))
  }

  /// decode → encode → decode equality for every case.
  @Test(arguments: [
    JSONScalar.string("fast attacker"),
    JSONScalar.int(252),
    JSONScalar.double(1.3),
    JSONScalar.bool(true),
    JSONScalar.null,
  ])
  func eachCaseRoundTrips(_ value: JSONScalar) throws {
    let encoded = try JSONEncoder().encode(ScalarBox(value: value))
    let decoded = try JSONDecoder().decode(ScalarBox.self, from: encoded)
    #expect(decoded.value == value)
  }

  /// A heterogeneous scalar map (the shape of `key_stats` / `assumptions`)
  /// survives a full round-trip — unknown scalar shapes are never dropped.
  @Test
  func heterogeneousMapSurvivesRoundTrip() throws {
    let json = """
      { "speed": 142, "role": "sweeper", "invested": true, "tier": 9.5, "notes": null }
      """
    let map = try JSONDecoder().decode([String: JSONScalar].self, from: Data(json.utf8))
    #expect(map["speed"] == .int(142))
    #expect(map["role"] == .string("sweeper"))
    #expect(map["invested"] == .bool(true))
    #expect(map["tier"] == .double(9.5))
    #expect(map["notes"] == .null)

    let reencoded = try JSONEncoder().encode(map)
    let roundTripped = try JSONDecoder().decode([String: JSONScalar].self, from: reencoded)
    #expect(roundTripped == map)
  }
}

/// Single-key wrapper used to decode/encode a bare scalar without relying on
/// top-level JSON fragment support.
private struct ScalarBox: Codable, Equatable {
  let value: JSONScalar
}
