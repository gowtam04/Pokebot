import Foundation
import Testing

@testable import OakApp

/// `AuthViewModel` against `FakeAuthService` (testing-strategy.md "ViewModels":
/// invalid/expired/cooldown/rate-limit). The view model is `@MainActor`, so the
/// suite is too; time is injected so the resend cooldown is deterministic.
@MainActor
struct AuthViewModelTests {

  private func makeViewModel(
    fake: FakeAuthService,
    appState: AppState = AppState(),
    cooldown: TimeInterval = 60,
    now: @escaping () -> Date = { Date() }
  ) -> AuthViewModel {
    AuthViewModel(auth: fake, appState: appState, cooldownDuration: cooldown, now: now)
  }

  // MARK: Happy path

  @Test
  func happyPathRequestsCodeThenSignsIn() async {
    let fake = FakeAuthService()
    fake.verifyResult = .success(Account(email: "ash@pallet.town", created: true))
    let state = AppState()
    let vm = makeViewModel(fake: fake, appState: state)

    vm.email = "Ash@Pallet.Town"
    await vm.submitEmail()

    #expect(vm.step == .code)
    #expect(fake.requestCodeCount == 1)
    #expect(fake.lastRequestedEmail == "ash@pallet.town")  // trimmed + lowercased
    #expect(vm.errorMessage == nil)
    #expect(vm.noticeMessage != nil)

    vm.code = "123456"
    await vm.submitCode()

    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
    #expect(fake.storedToken == "fake-session-token")  // verify stored the token
    #expect(vm.signedInEmail == "ash@pallet.town")
    #expect(vm.errorMessage == nil)
  }

  // MARK: Verify failures

  @Test
  func invalidCodeShowsErrorAndKeepsCode() async {
    let fake = FakeAuthService()
    fake.verifyResult = .failure(.http(status: 400, code: "invalid_code", message: "x"))
    let state = AppState()
    let vm = makeViewModel(fake: fake, appState: state)
    vm.email = "ash@pallet.town"
    await vm.submitEmail()

    vm.code = "000000"
    await vm.submitCode()

    #expect(vm.errorMessage == "That code is incorrect. Please try again.")
    #expect(vm.code == "000000")  // a wrong (not expired) code stays for correction
    #expect(state.authState == .guest)
  }

  @Test
  func expiredCodeShowsErrorAndClearsField() async {
    let fake = FakeAuthService()
    fake.verifyResult = .failure(.http(status: 400, code: "invalid_or_expired", message: "x"))
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"
    await vm.submitEmail()

    vm.code = "111111"
    await vm.submitCode()

    #expect(vm.errorMessage == "That code is no longer valid. Request a new one.")
    #expect(vm.code == "")  // stale code cleared
  }

  @Test
  func tooManyAttemptsShowsErrorAndClearsField() async {
    let fake = FakeAuthService()
    fake.verifyResult = .failure(.http(status: 400, code: "too_many_attempts", message: "x"))
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"
    await vm.submitEmail()

    vm.code = "222222"
    await vm.submitCode()

    #expect(vm.errorMessage == "Too many incorrect attempts. Request a new code.")
    #expect(vm.code == "")
  }

  // MARK: Request failures

  @Test
  func rateLimitedRequestShowsWaitMessage() async {
    let fake = FakeAuthService()
    fake.requestCodeResult = .failure(.rateLimited(retryAfter: 30))
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"

    await vm.submitEmail()

    #expect(vm.errorMessage == "Too many attempts. Please wait 30s and try again.")
    #expect(vm.step == .email)  // request failed → stayed on the email step
  }

  @Test
  func invalidEmailFromServerShowsMessage() async {
    let fake = FakeAuthService()
    fake.requestCodeResult = .failure(.http(status: 400, code: "invalid_email", message: "x"))
    // Passes the light client check, but the server is authoritative and rejects.
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"

    await vm.submitEmail()

    #expect(vm.errorMessage == "Enter a valid email address.")
    #expect(vm.step == .email)
  }

  @Test
  func transportFailureShowsConnectionMessage() async {
    let fake = FakeAuthService()
    fake.requestCodeResult = .failure(.transport(underlying: "URLError.-1009"))
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"

    await vm.submitEmail()

    #expect(vm.errorMessage == "No connection. Check your network and try again.")
  }

  // MARK: Resend cooldown

  @Test
  func resendCooldownBlocksUntilElapsed() async {
    var clock = Date(timeIntervalSince1970: 1_000_000)
    let fake = FakeAuthService()
    let vm = makeViewModel(fake: fake, cooldown: 60, now: { clock })

    vm.email = "ash@pallet.town"
    await vm.submitEmail()
    #expect(fake.requestCodeCount == 1)
    #expect(vm.resendSecondsRemaining == 60)
    #expect(vm.canResend == false)

    // A resend during the cooldown is a no-op (no extra request).
    await vm.resendCode()
    #expect(fake.requestCodeCount == 1)

    // Halfway through, still blocked.
    clock = clock.addingTimeInterval(30)
    #expect(vm.resendSecondsRemaining == 30)
    #expect(vm.canResend == false)

    // After the full window, resend is allowed and fires a fresh request.
    clock = clock.addingTimeInterval(30)
    #expect(vm.resendSecondsRemaining == 0)
    #expect(vm.canResend == true)
    await vm.resendCode()
    #expect(fake.requestCodeCount == 2)
    #expect(vm.resendSecondsRemaining == 60)  // cooldown reset
  }

  // MARK: Validation + navigation

  @Test
  func codeValidationRequiresSixDigits() async {
    let fake = FakeAuthService()
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"
    await vm.submitEmail()

    vm.code = "123"
    #expect(vm.canSubmitCode == false)
    await vm.submitCode()
    #expect(fake.verifyCount == 0)  // guarded — never reached the service

    vm.code = "12345a"
    #expect(vm.canSubmitCode == false)

    vm.code = "123456"
    #expect(vm.canSubmitCode == true)
  }

  @Test
  func emailValidationRejectsMalformed() {
    let fake = FakeAuthService()
    let vm = makeViewModel(fake: fake)

    vm.email = "not-an-email"
    #expect(vm.canSubmitEmail == false)

    vm.email = "ash@pallet"  // no dot in the domain
    #expect(vm.canSubmitEmail == false)

    vm.email = "ash@pallet.town"
    #expect(vm.canSubmitEmail == true)
  }

  @Test
  func editEmailResetsToEmailStep() async {
    let fake = FakeAuthService()
    let vm = makeViewModel(fake: fake)
    vm.email = "ash@pallet.town"
    await vm.submitEmail()
    vm.code = "123456"

    vm.editEmail()

    #expect(vm.step == .email)
    #expect(vm.code == "")
    #expect(vm.resendSecondsRemaining == 0)
    #expect(vm.errorMessage == nil)
  }
}
