import Foundation

/// A single JSON scalar value — `string | number | bool | null`.
///
/// Mirrors `jsonScalarSchema` (`web/src/agent/schemas.ts`):
/// `z.union([z.string(), z.number(), z.boolean(), z.null()])`. It is the value
/// type for the free-form `Record<string, scalar>` maps the server emits inside
/// `submit_answer` — candidate `key_stats` and `damage_calc` `assumptions` /
/// `result` — which carry heterogeneous scalars the client renders verbatim.
///
/// `number` is split into `.int` / `.double` so whole numbers round-trip as
/// integers (`5` → `5`, not `5.0`) while fractional values keep their precision.
/// Decoding and re-encoding any scalar the server sends preserves it without
/// loss; unknown scalar shapes are never dropped.
enum JSONScalar: Codable, Sendable, Equatable {
  case string(String)
  case int(Int)
  case double(Double)
  case bool(Bool)
  case null

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
      return
    }
    // Bool before the numeric cases: JSON `true`/`false` must not be coerced
    // into 1/0. Int before Double so whole numbers stay integers.
    if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int.self) {
      self = .int(value)
    } else if let value = try? container.decode(Double.self) {
      self = .double(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Value is not a JSON scalar (string, number, bool, or null)."
      )
    }
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .int(let value):
      try container.encode(value)
    case .double(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}
