import SwiftUI

/// A clean, reusable "no connection" surface with a retry affordance
/// (M-AC-NFR1.1): when the network is unavailable the app shows this clear state
/// and a way to try again, rather than hanging or surfacing a raw `URLError`.
///
/// Built on `ContentUnavailableView` so it reads well in light/dark and at large
/// Dynamic Type without bespoke layout, and inherits its accessibility behavior.
/// The "offline" meaning is carried by the icon **and** the title text (never
/// color alone, M-AC-UI9.3). Drop it in anywhere a screen has nothing to show
/// because the connection dropped; pass a `retry` closure to offer the button.
struct ConnectionStateView: View {
  /// The headline shown to the user. Defaults to the shared offline copy.
  let title: String
  /// A short supporting line. Defaults to a "check your connection" hint.
  let message: String
  /// Invoked when the user taps Retry. When `nil`, the button is hidden (e.g.
  /// when the surrounding screen retries automatically).
  let retry: (() -> Void)?

  init(
    title: String = ConnectionStateView.defaultTitle,
    message: String = ConnectionStateView.defaultMessage,
    retry: (() -> Void)? = nil
  ) {
    self.title = title
    self.message = message
    self.retry = retry
  }

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: "wifi.slash")
    } description: {
      Text(message)
    } actions: {
      if let retry {
        Button {
          retry()
        } label: {
          Label("Try Again", systemImage: "arrow.clockwise")
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .accessibilityHint("Retries the last action that needed a connection.")
      }
    }
  }

  // MARK: Shared copy (matches the view models' transport message, M-AC-NFR1.1)

  static let defaultTitle = "No Connection"
  static let defaultMessage = "Check your network and try again."
}

#if DEBUG
#Preview("With retry") {
  ConnectionStateView(retry: {})
}

#Preview("No retry") {
  ConnectionStateView()
}
#endif
