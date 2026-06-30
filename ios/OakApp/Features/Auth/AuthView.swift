import SwiftUI

/// The email-OTP sign-in screen (accounts-and-access.md M-ACCT-US-2). Two steps in
/// one view: collect the email, then the 6-digit code. The code field opts into the
/// system one-time-code autofill (`.textContentType(.oneTimeCode)`, M-AC-2.4) and
/// auto-submits once six digits are present for low-friction entry.
///
/// The view owns its ``AuthViewModel`` (`@State`) and drives it from `Task`s; all
/// logic and error copy live in the view model. Layout uses Dynamic-Type styles and
/// system semantic colors so it adapts to light/dark and text size; error text is
/// paired with an icon so color is never the sole signal (M-AC-UI9.3).
///
/// Presentation (where this surfaces in the app) is wired by the Account feature in
/// a later phase; the view is presenter-agnostic and self-contained.
struct AuthView: View {
  @State private var model: AuthViewModel
  @FocusState private var focusedField: Field?

  private enum Field: Hashable {
    case email
    case code
  }

  init(model: AuthViewModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    @Bindable var model = model
    NavigationStack {
      Form {
        if let email = model.signedInEmail {
          signedInSection(email: email)
        } else {
          switch model.step {
          case .email:
            emailStep(emailText: $model.email)
          case .code:
            codeStep(codeText: $model.code)
          }
        }
      }
      .navigationTitle("Sign in")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  // MARK: Email step

  @ViewBuilder
  private func emailStep(emailText: Binding<String>) -> some View {
    Section {
      TextField("you@example.com", text: emailText)
        .textContentType(.emailAddress)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.send)
        .focused($focusedField, equals: .email)
        .onSubmit { Task { await model.submitEmail() } }
    } header: {
      Text("Email")
    } footer: {
      Text("We'll email you a 6-digit code. No password needed.")
    }

    messageRows

    Section {
      Button {
        Task { await model.submitEmail() }
      } label: {
        submitButtonContent(title: "Send code")
      }
      .disabled(!model.canSubmitEmail)
    }
    .onAppear { focusedField = .email }
  }

  // MARK: Code step

  @ViewBuilder
  private func codeStep(codeText: Binding<String>) -> some View {
    Section {
      TextField("123456", text: codeText)
        .textContentType(.oneTimeCode)
        .keyboardType(.numberPad)
        .font(Theme.mono(.title2))
        .focused($focusedField, equals: .code)
        // OTP autofill drops all six digits at once — verify automatically.
        .onChange(of: model.code) { _, newValue in
          if newValue.count == 6 { Task { await model.submitCode() } }
        }
    } header: {
      Text("Enter code")
    } footer: {
      Text("Enter the 6-digit code we sent to \(model.normalizedEmail).")
    }

    messageRows

    Section {
      Button {
        Task { await model.submitCode() }
      } label: {
        submitButtonContent(title: "Verify")
      }
      .disabled(!model.canSubmitCode)

      // The cooldown ticks via TimelineView so the countdown updates each second
      // without the view model holding a timer.
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        if model.canResend {
          Button("Resend code") {
            Task { await model.resendCode() }
          }
        } else {
          Text("Resend available in \(model.resendSecondsRemaining)s")
            .foregroundStyle(Theme.textSecondary)
        }
      }

      Button("Use a different email") {
        model.editEmail()
      }
      .foregroundStyle(Theme.textSecondary)
    }
    .onAppear { focusedField = .code }
  }

  // MARK: Signed-in confirmation

  @ViewBuilder
  private func signedInSection(email: String) -> some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text("Signed in")
            .font(Theme.display(.headline))
          Text(email)
            .font(Theme.body(.subheadline))
            .foregroundStyle(Theme.textSecondary)
        }
      } icon: {
        Image(systemName: "checkmark.seal.fill")
          .foregroundStyle(Theme.success)
      }
    }
  }

  // MARK: Shared pieces

  /// A submit-button label that shows a spinner while a request is in flight.
  @ViewBuilder
  private func submitButtonContent(title: String) -> some View {
    HStack {
      Text(title)
      if model.isBusy {
        Spacer()
        ProgressView()
      }
    }
  }

  /// Error (with a warning icon) and neutral notice rows; rendered only when set.
  @ViewBuilder
  private var messageRows: some View {
    if let errorMessage = model.errorMessage {
      Section {
        Label {
          Text(errorMessage)
            .foregroundStyle(Theme.danger)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(Theme.danger)
        }
        .font(Theme.body(.footnote))
      }
    }
    if let noticeMessage = model.noticeMessage {
      Section {
        Label {
          Text(noticeMessage)
            .foregroundStyle(Theme.textSecondary)
        } icon: {
          Image(systemName: "envelope.fill")
            .foregroundStyle(Theme.info)
        }
        .font(Theme.body(.footnote))
      }
    }
  }
}

#if DEBUG
/// A preview-only ``AuthService`` so the canvas renders without the network.
private struct PreviewAuthService: AuthService {
  func requestCode(email: String) async throws {}
  func verify(email: String, code: String) async throws -> Account {
    Account(email: email, created: false)
  }
  func me() async throws -> AuthState { .guest }
  func signOut() async throws {}
  func deleteAccount() async throws {}
}

#Preview("Sign in") {
  AuthView(model: AuthViewModel(auth: PreviewAuthService(), appState: AppState()))
}
#endif
