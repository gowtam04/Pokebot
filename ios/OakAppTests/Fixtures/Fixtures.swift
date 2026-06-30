import Foundation

/// Loads committed wire/SSE fixtures from the test bundle (testing-strategy.md
/// "Fixture conventions"). The fixtures under `OakAppTests/Fixtures/*.json` and
/// `*.sse` are copied into the unit-test bundle's resources (see `project.yml`);
/// this helper resolves them by name so decode tests build their DTOs from the
/// committed JSON, never from inline literals — so a contract change fails loudly.
///
/// The raw byte readers (`load`/`data`) are also the entry point a later
/// `SSEParser` test phase uses to feed `.sse` streams; here they back the
/// JSON decode suite and a smoke check that every `.sse` fixture is bundled.
enum Fixtures {
  /// Errors surfaced when a named fixture is missing from the test bundle —
  /// almost always a `project.yml` resource-inclusion regression.
  enum FixtureError: Error, CustomStringConvertible {
    case notFound(String)

    var description: String {
      switch self {
      case let .notFound(name):
        return "Fixture \"\(name)\" was not found in the test bundle. "
          + "Confirm OakAppTests/Fixtures is wired into the Copy Bundle Resources "
          + "phase (project.yml)."
      }
    }
  }

  /// Anchors `Bundle(for:)` to the unit-test bundle (no SwiftPM `Bundle.module`
  /// exists for an XcodeGen target).
  private final class BundleToken {}

  /// The unit-test bundle that carries the fixture resources.
  static var bundle: Bundle { Bundle(for: BundleToken.self) }

  /// Raw bytes of a named fixture, e.g. `"conversations_list.json"` or
  /// `"chat_answered_full.sse"`. The extension is optional but recommended.
  static func load(_ name: String) throws -> Data {
    let nsName = name as NSString
    let resource = nsName.deletingPathExtension
    let ext = nsName.pathExtension
    guard
      let url = bundle.url(
        forResource: resource,
        withExtension: ext.isEmpty ? nil : ext
      )
    else {
      throw FixtureError.notFound(name)
    }
    return try Data(contentsOf: url)
  }

  /// Convenience alias for raw bytes (reads as a noun at call sites).
  static func data(_ name: String) throws -> Data {
    try load(name)
  }

  /// A fixture decoded as UTF-8 text (for `.sse` streams / heartbeat checks).
  static func string(_ name: String) throws -> String {
    String(decoding: try load(name), as: UTF8.self)
  }

  /// Decode a JSON fixture into a `Decodable` DTO with a fresh decoder.
  static func decode<T: Decodable>(
    _ type: T.Type,
    from name: String,
    using decoder: JSONDecoder = JSONDecoder()
  ) throws -> T {
    try decoder.decode(type, from: load(name))
  }
}
