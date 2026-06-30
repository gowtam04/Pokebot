import SwiftUI

/// The Account / Settings screen (M-UI-US-7): sign in/out, the current tier &
/// what it unlocks, the **account-deletion** flow (M-ACCT-US-6 / M-NFR-6), the
/// Champions-mode default, and standard about/legal links.
///
/// The view owns its ``AccountViewModel`` (`@State`) and drives it from `Task`s;
/// all logic and copy live in the view model. Layout uses Dynamic-Type styles and
/// system semantic colors so it adapts to light/dark and text size (M-AC-UI1.3/4);
/// destructive and status rows pair an icon + text with color so meaning is never
/// carried by color alone (M-AC-UI9.3). Interactive controls carry VoiceOver
/// labels/hints (M-AC-UI9.1).
struct AccountView: View {
  @Environment(AppState.self) private var appState
  @State private var model: AccountViewModel

  /// Drives the sign-in sheet (presented over the guest state).
  @State private var showingSignIn = false
  /// Drives the destructive account-deletion confirmation.
  @State private var showingDeleteConfirm = false

  init(model: AccountViewModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    @Bindable var appState = appState
    NavigationStack {
      Form {
        accountSection
        if let message = model.errorMessage {
          errorSection(message)
        }
        preferencesSection(championsDefault: $appState.championsMode)
        if model.isSignedIn {
          dangerSection
        }
        aboutSection
      }
      .navigationTitle("Account")
    }
    .sheet(isPresented: $showingSignIn) {
      AuthView(model: model.makeAuthViewModel())
    }
    // Dismiss the sign-in sheet automatically once verification flips the app to
    // signed-in (the AuthView itself is presenter-agnostic).
    .onChange(of: model.isSignedIn) { _, signedIn in
      if signedIn { showingSignIn = false }
    }
    .alert("Delete account?", isPresented: $showingDeleteConfirm) {
      Button("Delete account", role: .destructive) {
        Task { await model.deleteAccount() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(AccountViewModel.deletionWarning)
    }
  }

  // MARK: Account / tier

  @ViewBuilder
  private var accountSection: some View {
    Section {
      tierRow
      if model.isSignedIn {
        Button {
          Task { await model.signOut() }
        } label: {
          actionLabel(title: "Sign out", systemImage: "rectangle.portrait.and.arrow.right")
        }
        .disabled(model.isBusy)
        .accessibilityHint("Returns the app to guest mode and removes your session from this device.")
      } else {
        Button {
          showingSignIn = true
        } label: {
          actionLabel(title: "Sign in", systemImage: "person.crop.circle.badge.plus")
        }
        .accessibilityHint("Sign in with your email to unlock saved history and the team builder.")
      }
    } header: {
      Text("Account")
    } footer: {
      Text(model.tierDescription)
    }
  }

  /// The tier row: an icon + the tier title (color is never the only signal — the
  /// tier is spelled out in text, M-AC-UI9.3).
  private var tierRow: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.tierTitle)
          .font(Theme.display(.headline))
        if let email = model.email {
          Text(email)
            .font(Theme.body(.subheadline))
            .foregroundStyle(Theme.textSecondary)
        }
      }
    } icon: {
      Image(systemName: model.isSignedIn ? "checkmark.seal.fill" : "person.crop.circle")
        .foregroundStyle(model.isSignedIn ? Theme.success : Theme.textSecondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityTierLabel)
  }

  private var accessibilityTierLabel: String {
    if let email = model.email {
      return "\(model.tierTitle), \(email)"
    }
    return model.tierTitle
  }

  // MARK: Preferences

  @ViewBuilder
  private func preferencesSection(championsDefault: Binding<Bool>) -> some View {
    Section {
      Toggle(isOn: championsDefault) {
        Label("Champions mode by default", systemImage: "trophy")
      }
      .accessibilityHint("New conversations start in the Champions data scope.")
    } header: {
      Text("Preferences")
    } footer: {
      Text("New conversations open in this data scope. You can still switch scope per conversation.")
    }
  }

  // MARK: Danger zone (account deletion)

  @ViewBuilder
  private var dangerSection: some View {
    Section {
      Button(role: .destructive) {
        showingDeleteConfirm = true
      } label: {
        HStack {
          actionLabel(title: "Delete account", systemImage: "trash")
            .foregroundStyle(Theme.danger)
          if model.isBusy {
            Spacer()
            ProgressView()
          }
        }
      }
      .disabled(model.isBusy)
      .accessibilityHint("Permanently deletes your account, history, and teams. This can't be undone.")
    } footer: {
      Text("Permanently removes your account and all of its data from Oak.")
    }
  }

  // MARK: About / legal

  @ViewBuilder
  private var aboutSection: some View {
    Section {
      Link(destination: Self.privacyPolicyURL) {
        actionLabel(title: "Privacy Policy", systemImage: "hand.raised")
      }
      Link(destination: Self.supportURL) {
        actionLabel(title: "Support", systemImage: "questionmark.circle")
      }
      LabeledContent {
        Text(Self.versionString)
          .font(Theme.mono(.subheadline))
          .foregroundStyle(Theme.textSecondary)
      } label: {
        Label("Version", systemImage: "info.circle")
      }
    } header: {
      Text("About")
    }
  }

  // MARK: Error banner row

  @ViewBuilder
  private func errorSection(_ message: String) -> some View {
    Section {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(Theme.danger)
          .accessibilityHidden(true)
        Text(message)
          .font(Theme.body(.footnote))
          .foregroundStyle(Theme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button("Dismiss") { model.dismissError() }
          .font(Theme.body(.footnote))
          .buttonStyle(.borderless)
      }
      .accessibilityElement(children: .combine)
    }
  }

  // MARK: Helpers

  /// A label that scales with Dynamic Type (no fixed sizing) and reads as one
  /// element to VoiceOver.
  private func actionLabel(title: String, systemImage: String) -> some View {
    Label(title, systemImage: systemImage)
      .font(Theme.body(.body))
  }

  // MARK: Placeholder links + version
  //
  // NOTE: these URLs are PLACEHOLDERS — replace with the real hosted privacy
  // policy and support pages before App Store submission (M-NFR-7). They are
  // present so the about/legal surface (M-UI-US-7) exists and is wired.
  static let privacyPolicyURL = URL(string: "https://oak.optiwise.us/privacy")!
  static let supportURL = URL(string: "https://oak.optiwise.us/support")!

  /// The marketing version + build, read from the bundle (set in `project.yml`).
  static var versionString: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
    let build = info?["CFBundleVersion"] as? String ?? "1"
    return "\(version) (\(build))"
  }
}

#if DEBUG
/// A preview-only ``AuthService`` so the canvas renders without the network.
private struct PreviewAccountAuthService: AuthService {
  func requestCode(email: String) async throws {}
  func verify(email: String, code: String) async throws -> Account {
    Account(email: email, created: false)
  }
  func me() async throws -> AuthState { .guest }
  func signOut() async throws {}
  func deleteAccount() async throws {}
}

#Preview("Guest") {
  let state = AppState()
  return AccountView(model: AccountViewModel(auth: PreviewAccountAuthService(), appState: state))
    .environment(state)
}

#Preview("Signed in") {
  let state = AppState()
  state.completeSignIn(email: "ash@pallet.town")
  return AccountView(model: AccountViewModel(auth: PreviewAccountAuthService(), appState: state))
    .environment(state)
}
#endif
