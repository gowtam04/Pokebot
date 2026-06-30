import SwiftUI

/// Dependency container for the app's services, injected through the SwiftUI
/// environment so view models resolve **service protocols** (never `Live…`
/// concretes) and previews/tests can substitute `Fake…` implementations
/// (conventions.md "SwiftUI / state").
///
/// P1 ships this as an empty seam. Each later phase adds its service additively
/// to BOTH the stored properties and the factories below, e.g.:
///
/// ```swift
/// let auth: any AuthService
/// ```
///
/// Keeping the container itself `Sendable` is fine because every service protocol
/// is declared `: Sendable`.
struct ServiceContainer: Sendable {
  // Services are added here by later phases (P4+). Empty by design in P1.

  /// The production wiring (real `Live…` services). Extended by later phases.
  static func live() -> ServiceContainer {
    ServiceContainer()
  }

  /// A preview/test-friendly container (substitute `Fake…` services here).
  static func preview() -> ServiceContainer {
    ServiceContainer()
  }
}

private struct ServiceContainerKey: EnvironmentKey {
  static let defaultValue = ServiceContainer.live()
}

extension EnvironmentValues {
  /// The injected service container. Read it from a view, then hand the needed
  /// service to the screen's view model.
  var services: ServiceContainer {
    get { self[ServiceContainerKey.self] }
    set { self[ServiceContainerKey.self] = newValue }
  }
}

extension View {
  /// Injects the service container into the environment for descendant views.
  func oakServices(_ container: ServiceContainer) -> some View {
    environment(\.services, container)
  }
}
