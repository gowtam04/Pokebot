import SwiftUI

/// Top-level navigation shell: a four-tab `TabView` (Chat / History / Teams /
/// Account). Chat is the default surface on launch (M-AC-UI2.1); History and
/// Teams are reachable in one tap (M-AC-UI2.2).
///
/// Each tab currently hosts a placeholder. Later phases replace the placeholder
/// bodies with the real feature views (P6 `ChatView`, P9 `HistoryListView`,
/// P10 `TeamsListView`, P12 `AccountView`).
struct RootView: View {
  var body: some View {
    TabView {
      Tab("Chat", systemImage: "bubble.left.and.text.bubble.right") {
        PlaceholderScreen(
          title: "Chat",
          systemImage: "bubble.left.and.text.bubble.right",
          message: "Ask Oak a Pokémon question — every answer carries its reasoning, sources, and the generation it's based on."
        )
      }
      Tab("History", systemImage: "clock.arrow.circlepath") {
        PlaceholderScreen(
          title: "History",
          systemImage: "clock.arrow.circlepath",
          message: "Your saved conversations will appear here once you sign in."
        )
      }
      Tab("Teams", systemImage: "person.3") {
        PlaceholderScreen(
          title: "Teams",
          systemImage: "person.3",
          message: "Build and manage your Pokémon teams once you sign in."
        )
      }
      Tab("Account", systemImage: "person.crop.circle") {
        PlaceholderScreen(
          title: "Account",
          systemImage: "person.crop.circle",
          message: "Sign in with your email to sync history and teams across devices."
        )
      }
    }
    .tint(Theme.accent)
  }
}

/// A neutral placeholder used by every tab until its feature view lands. Built on
/// `ContentUnavailableView` so it reads well in light/dark and at large Dynamic
/// Type without bespoke layout.
private struct PlaceholderScreen: View {
  let title: String
  let systemImage: String
  let message: String

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label(title, systemImage: systemImage)
      } description: {
        Text(message)
      }
      .navigationTitle(title)
    }
  }
}

#Preview {
  RootView()
    .environment(AppState())
    .oakServices(.preview())
}
