import Foundation
import Testing

@testable import OakApp

/// `AccountViewModel` against `FakeAuthService` (testing-strategy.md "ViewModels";
/// M-ACCT-US-6 / M-NFR-6): the account-deletion confirm outcome (returns to guest +
/// clears the token on success; stays signed in + surfaces a recoverable error on
/// failure), sign-out, and the tier/limit indication that backs the screen's text +
/// accessibility labels. The view model is `@MainActor`, so the suite is too.
@MainActor
struct AccountViewModelTests {

  private func makeVM(
    fake: FakeAuthService = FakeAuthService(),
    appState: AppState = AppState()
  ) -> (AccountViewModel, FakeAuthService, AppState) {
    let vm = AccountViewModel(auth: fake, appState: appState)
    return (vm, fake, appState)
  }

  private func signedInState() -> AppState {
    let state = AppState()
    state.completeSignIn(email: "ash@pallet.town")
    return state
  }

  // MARK: Account deletion (the App Store requirement)

  @Test
  func deleteAccountReturnsToGuestAndClearsToken() async {
    let state = signedInState()
    let (vm, fake, _) = makeVM(appState: state)
    fake.storedToken = "fake-session-token"  // model a signed-in device

    await vm.deleteAccount()

    #expect(fake.deleteCount == 1)
    #expect(fake.storedToken == nil)  // credentials removed from the device
    #expect(state.authState == .guest)  // back to guest (M-AC-6.3)
    #expect(vm.isSignedIn == false)
    #expect(vm.errorMessage == nil)
    #expect(vm.isBusy == false)
  }

  @Test
  func deleteAccountTransportFailureStaysSignedInWithConnectionMessage() async {
    let state = signedInState()
    let (vm, fake, _) = makeVM(appState: state)
    fake.storedToken = "fake-session-token"
    fake.deleteResult = .failure(.transport(underlying: "URLError.-1009"))

    await vm.deleteAccount()

    // The server delete failed → token intact, still signed in (no false success).
    #expect(fake.storedToken == "fake-session-token")
    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
    #expect(vm.isSignedIn == true)
    #expect(vm.errorMessage == AccountViewModel.connectionMessage)
    #expect(vm.isBusy == false)
  }

  @Test
  func deleteAccountServerFailureUsesGenericDeletionMessage() async {
    let state = signedInState()
    let (vm, fake, _) = makeVM(appState: state)
    fake.storedToken = "fake-session-token"
    fake.deleteResult = .failure(.http(status: 500, code: "server_error", message: "boom"))

    await vm.deleteAccount()

    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
    #expect(vm.errorMessage == AccountViewModel.deletionFailedMessage)
  }

  @Test
  func dismissErrorClearsTheMessage() async {
    let state = signedInState()
    let (vm, fake, _) = makeVM(appState: state)
    fake.deleteResult = .failure(.transport(underlying: "URLError.-1009"))
    await vm.deleteAccount()
    #expect(vm.errorMessage != nil)

    vm.dismissError()

    #expect(vm.errorMessage == nil)
  }

  // MARK: Sign out

  @Test
  func signOutReturnsToGuestAndClearsToken() async {
    let state = signedInState()
    state.activeConversationId = "conv-1"
    let (vm, fake, _) = makeVM(appState: state)
    fake.storedToken = "fake-session-token"

    await vm.signOut()

    #expect(fake.signOutCount == 1)
    #expect(fake.storedToken == nil)
    #expect(state.authState == .guest)
    #expect(state.activeConversationId == nil)
    #expect(vm.isSignedIn == false)
    #expect(vm.errorMessage == nil)
  }

  @Test
  func signOutAlwaysReturnsToGuestEvenWhenEndpointFails() async {
    let state = signedInState()
    let (vm, fake, _) = makeVM(appState: state)
    fake.storedToken = "fake-session-token"
    fake.signOutError = .transport(underlying: "URLError.-1009")

    await vm.signOut()

    // Sign-out never blocks the local return to guest (M-AC-3.1).
    #expect(fake.storedToken == nil)
    #expect(state.authState == .guest)
    #expect(vm.errorMessage == nil)
  }

  // MARK: Tier / limit indication (backs the screen text + a11y labels)

  @Test
  func guestTierIndicatesLowerLimitAndSignInUnlock() {
    let (vm, _, _) = makeVM()  // a fresh AppState is a guest

    #expect(vm.isSignedIn == false)
    #expect(vm.email == nil)
    #expect(vm.tierTitle == AccountViewModel.guestTierTitle)
    #expect(vm.tierDescription == AccountViewModel.guestTierDescription)
  }

  @Test
  func signedInTierIndicatesHigherLimitAndShowsEmail() {
    let state = signedInState()
    let (vm, _, _) = makeVM(appState: state)

    #expect(vm.isSignedIn == true)
    #expect(vm.email == "ash@pallet.town")
    #expect(vm.tierTitle == AccountViewModel.signedInTierTitle)
    #expect(vm.tierDescription == AccountViewModel.signedInTierDescription)
  }

  /// VoiceOver/Dynamic-Type smoke (unit-testable slice): the strings that back the
  /// tier labels, footers, and the deletion confirmation are present and distinct,
  /// so the accessibility labels and the destructive-confirm copy are never empty
  /// (M-AC-UI9.1, M-AC-6.2). Real VoiceOver + the privacy-label submission are
  /// human follow-ups.
  @Test
  func accessibilityBackingCopyIsPresentAndDistinct() {
    #expect(!AccountViewModel.guestTierTitle.isEmpty)
    #expect(!AccountViewModel.signedInTierTitle.isEmpty)
    #expect(AccountViewModel.guestTierDescription != AccountViewModel.signedInTierDescription)
    #expect(!AccountViewModel.deletionWarning.isEmpty)
    #expect(!AccountViewModel.connectionMessage.isEmpty)
    #expect(!AccountViewModel.deletionFailedMessage.isEmpty)
  }

  // MARK: Sign-in handoff

  @Test
  func makeAuthViewModelSharesAppStateSoSignInFlipsTier() async {
    let (vm, _, state) = makeVM()
    #expect(vm.isSignedIn == false)

    let authVM = vm.makeAuthViewModel()
    // Completing verification through the produced view model flips the shared
    // AppState, which the AccountViewModel reflects.
    authVM.email = "ash@pallet.town"
    await authVM.submitEmail()
    authVM.code = "123456"
    await authVM.submitCode()

    #expect(state.authState == .signedIn(email: "ash@pallet.town"))
    #expect(vm.isSignedIn == true)
    #expect(vm.email == "ash@pallet.town")
  }
}
