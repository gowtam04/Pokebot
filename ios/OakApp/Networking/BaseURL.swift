import Foundation

/// The Oak backend base URL, selected per build configuration.
///
/// Debug builds target **staging**, Release builds target **production**
/// (deployment.md "Environments"). The switch is the `OAK_STAGING` compilation
/// condition, set only in the Debug config by `project.yml`.
///
/// Placeholders: the backend runs on Fly.io as the app `oak-gowtam`, whose default
/// hostname is `oak-gowtam.fly.dev`. The hobby tier has no dedicated staging app
/// yet, so staging points at production for now.
/// TODO(P1): confirm the production host and point staging at a Fly staging app if
/// one is created before App Store submission.
enum BaseURL {
  /// The base URL for the active build configuration.
  static let current: URL = {
    #if OAK_STAGING
    return staging
    #else
    return production
    #endif
  }()

  /// Production backend (Fly.io app `oak-gowtam`).
  static let production = URL(string: "https://oak-gowtam.fly.dev")!

  /// Staging backend (currently the same host as production — see note above).
  static let staging = URL(string: "https://oak-gowtam.fly.dev")!
}
