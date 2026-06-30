import Foundation
import Testing

@testable import OakApp

/// `ConnectionStateView` smoke (M-AC-NFR1.1): the offline/retry surface constructs
/// without crashing, hides the button when no retry is offered, and fires the retry
/// closure when one is. (The full visual render is exercised by previews/UI tests;
/// this pins the wiring that a unit test can assert.) The view holds a non-`Sendable`
/// closure, so the suite is `@MainActor`.
@MainActor
struct ConnectionStateViewTests {

  @Test
  func retryClosureFiresWhenTapped() {
    var fired = false
    let view = ConnectionStateView(retry: { fired = true })

    view.retry?()

    #expect(fired)
  }

  @Test
  func defaultsHaveCopyAndNoRetryButton() {
    let view = ConnectionStateView()

    #expect(view.retry == nil)  // no retry → the button is hidden
    #expect(view.title == ConnectionStateView.defaultTitle)
    #expect(view.message == ConnectionStateView.defaultMessage)
    #expect(!ConnectionStateView.defaultTitle.isEmpty)
    #expect(!ConnectionStateView.defaultMessage.isEmpty)
  }

  @Test
  func customCopyIsRetained() {
    let view = ConnectionStateView(
      title: "Offline",
      message: "Reconnect to keep chatting.",
      retry: {}
    )

    #expect(view.title == "Offline")
    #expect(view.message == "Reconnect to keep chatting.")
    #expect(view.retry != nil)
  }
}
