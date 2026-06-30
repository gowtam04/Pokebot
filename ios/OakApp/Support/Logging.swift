import OSLog

/// Centralized `OSLog` loggers, one per functional area (conventions.md "Logging").
///
/// Subsystem is the app's bundle identifier; categories let Console / Xcode filter
/// by area. Use levels deliberately: `.debug` (dev detail), `.info` (lifecycle),
/// `.error` (a caught `OakError`).
///
/// NEVER log the session token, OTP codes, email beyond what's strictly needed,
/// message content, or image bytes — log an error `code`/status and a request
/// label, not payloads.
enum Log {
  private static let subsystem = "us.optiwise.oak"

  /// Networking: requests, status codes, transport faults (no payloads/tokens).
  static let network = Logger(subsystem: subsystem, category: "network")

  /// Auth lifecycle: sign-in/out transitions (no OTP, no token).
  static let auth = Logger(subsystem: subsystem, category: "auth")

  /// Chat: stream lifecycle and tool-activity (no message content/images).
  static let chat = Logger(subsystem: subsystem, category: "chat")

  /// UI: view/navigation lifecycle and recoverable user-facing states.
  static let ui = Logger(subsystem: subsystem, category: "ui")
}
