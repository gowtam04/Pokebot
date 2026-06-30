import SwiftUI

/// Application entry point.
///
/// Constructs the shared `AppState` and the `ServiceContainer`, injects both into
/// the environment, and shows `RootView` (the four-tab shell). The app holds no
/// LLM keys and no database — it talks only to the Oak backend over HTTP/SSE.
@main
struct OakApp: App {
  @State private var appState = AppState()
  private let services = ServiceContainer.live()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(appState)
        .oakServices(services)
    }
  }
}
