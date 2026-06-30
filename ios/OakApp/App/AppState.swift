import Foundation
import Observation

/// Root session/app state, injected through the SwiftUI environment.
///
/// Holds the cross-cutting state that outlives any single screen: the current
/// auth state, the active conversation id, the in-memory guest thread, and the
/// Champions-mode default for new conversations. `@MainActor` because everything
/// here drives UI; `@Observable` so views update on change.
///
/// P1 ships this as a real stub; later phases extend it (P5 wires auth
/// transitions + the guest→sign-in handoff via `HistoryService.importGuestThread`;
/// P6 appends to the guest thread as turns happen).
@MainActor
@Observable
final class AppState {
  /// Whether the user is a guest or signed in (`AuthState` is defined below and is
  /// the canonical type — `AuthService` in P5 reuses it, it is not redefined).
  var authState: AuthState = .guest

  /// The active conversation id. `nil` means a fresh, unsaved thread.
  var activeConversationId: String?

  /// The in-memory guest thread: turns kept only for the session and never
  /// persisted. On sign-in these are mapped to the import payload (P9). Stubbed
  /// here with a lightweight turn model; P6 populates it as the chat streams.
  var guestThread: [GuestTurn] = []

  /// The Champions-mode default applied to new conversations (M-CHAT-US-3). The
  /// per-request value is server-controlled; this is just the composer's default.
  var championsMode: Bool = false

  init() {}
}

// MARK: - Auth transitions (P5)

extension AppState {
  /// Restores the session on launch (accounts-and-access.md M-AC-2.5): ask the
  /// backend who we are. The client attaches the stored Bearer token (if any), so
  /// a valid token resolves to `.signedIn`, an absent/expired token to `.guest`
  /// (the `me` route returns guest as a first-class 200). A transport failure
  /// leaves the state as the launch default (guest) rather than throwing — the
  /// next authed call will surface connectivity if it persists.
  func restoreSession(using auth: any AuthService) async {
    do {
      authState = try await auth.me()
    } catch {
      Log.auth.error("session restore failed; remaining a guest")
    }
  }

  /// Applies a completed verification: flip the whole app to signed-in
  /// (M-ACCT-US-2). The token was already persisted by the service. The on-screen
  /// guest thread is preserved (M-AC-4.1); importing it into durable history is a
  /// separate, non-fatal step — ``importGuestThread(using:)`` — invoked from the
  /// sign-in flow once a `HistoryService` is in hand, so the state flip here stays
  /// synchronous and dependency-free.
  func completeSignIn(email: String) {
    authState = .signedIn(email: email)
  }

  /// Signs out (M-ACCT-US-3): best-effort server revoke + Keychain clear via the
  /// service, then return to guest. Never throws — sign-out must always succeed in
  /// returning the device to guest.
  func signOut(using auth: any AuthService) async {
    do {
      try await auth.signOut()
    } catch {
      Log.auth.error("sign-out failed; clearing local session anyway")
    }
    resetToGuest()
  }

  /// Handles a `401` on a previously-authed call (api-design.md "Authentication"):
  /// the session expired or was revoked, so drop the token and return to guest,
  /// prompting a re-sign-in. The revoke endpoint is idempotent, so reusing
  /// `signOut` to clear the now-orphaned token is safe.
  func handleUnauthorized(using auth: any AuthService) async {
    Log.auth.info("received 401 on an authed call; returning to guest")
    do {
      try await auth.signOut()
    } catch {
      Log.auth.error("token drop after 401 failed")
    }
    resetToGuest()
  }

  /// Deletes the account and its server data, then returns to guest
  /// (M-ACCT-US-6). A real backend failure propagates so the UI doesn't falsely
  /// report deletion; only a confirmed deletion reaches the guest reset.
  func deleteAccount(using auth: any AuthService) async throws {
    try await auth.deleteAccount()
    resetToGuest()
  }

  /// Clears all session-scoped state back to the guest baseline.
  private func resetToGuest() {
    authState = .guest
    activeConversationId = nil
  }
}

// MARK: - Guest → sign-in thread import (P9)

extension AppState {
  /// Persists the in-memory guest thread to durable history right after sign-in
  /// (M-ACCT-US-4 / component-design.md "Guest→sign-in"). Maps the session-only
  /// ``GuestTurn``s into the wire ``ChatTurn``s the import endpoint expects and
  /// uploads them under a stable session id; the returned conversation id becomes
  /// the active conversation so follow-ups continue the same thread.
  ///
  /// **Non-fatal by design:** an empty thread imports nothing (returns `nil`), and
  /// any failure is logged and swallowed — the on-screen thread is preserved either
  /// way (M-AC-4.1), so a transient backend problem never costs the user their
  /// visible conversation. The returned id is the new conversation's id (or `nil`).
  ///
  /// Called from the sign-in flow once a ``HistoryService`` is available (the wiring
  /// point lives at the app's composition root, where services are constructed).
  @discardableResult
  func importGuestThread(using history: any HistoryService) async -> String? {
    guard !guestThread.isEmpty else { return nil }

    // Reuse the active conversation id when one exists; otherwise mint a fresh
    // session id (the import route creates the conversation under this id and
    // echoes it back as the returned id).
    let sessionId = activeConversationId ?? UUID().uuidString
    let turns = guestThread.map(\.asChatTurn)

    do {
      let id = try await history.importGuestThread(
        sessionId: sessionId,
        championsMode: championsMode,
        turns: turns
      )
      if let id {
        activeConversationId = id
      }
      return id
    } catch {
      Log.auth.error("guest thread import failed; keeping the on-screen thread")
      return nil
    }
  }
}

private extension GuestTurn {
  /// Maps a session-only guest turn into the wire ``ChatTurn`` the import endpoint
  /// validates. A user turn carries its text verbatim; an assistant turn — which the
  /// guest thread stores only as markdown (``GuestTurn`` is intentionally lossy) —
  /// is wrapped in a minimal, schema-valid ``OakAnswer`` so the upload preserves the
  /// prose. The stored turn id (a UUID) keys the import's idempotent upsert.
  var asChatTurn: ChatTurn {
    switch role {
    case .user:
      return .user(id: id.uuidString, content: text)
    case .assistant:
      return .assistant(id: id.uuidString, answer: .guestImportPlaceholder(markdown: text))
    }
  }
}

private extension OakAnswer {
  /// A minimal ``OakAnswer`` synthesized from a guest assistant turn's plain text.
  /// `oakAnswerSchema` (the import route's validator) requires only `status`, the two
  /// markdown fields, the citation/inference arrays (which may be empty), and
  /// `generation_basis`; every other block is optional. The guest thread carries
  /// only the answer markdown, so the structured blocks are intentionally empty —
  /// the prose round-trips, the (unavailable) reasoning/citations do not.
  static func guestImportPlaceholder(markdown: String) -> OakAnswer {
    OakAnswer(
      status: .answered,
      answerMarkdown: markdown,
      reasoningMarkdown: "",
      citations: [],
      inferences: [],
      generationBasis: GenerationBasis(generation: "", fallback: false, note: nil),
      subjects: nil,
      candidates: nil,
      damageCalc: nil,
      suggestions: nil,
      question: nil,
      uncertaintyFlags: nil,
      proposedTeam: nil,
      savedTeam: nil,
      proposedTeamWarnings: nil
    )
  }
}

/// Whether the user is browsing as a guest or signed in with an email account.
///
/// Canonical home: this is the single definition used by `AppState` and by P5's
/// `AuthService`/`AuthViewModel`. Do not redefine it elsewhere.
enum AuthState: Equatable, Sendable {
  case guest
  case signedIn(email: String)
}

/// One turn of the in-memory guest thread (session-only, never persisted).
///
/// Intentionally minimal in P1. P6/P9 reconcile this with the wire `ChatTurn`
/// when mapping the guest thread into the sign-in import payload.
struct GuestTurn: Identifiable, Sendable, Equatable {
  enum Role: String, Sendable, Equatable {
    case user
    case assistant
  }

  let id: UUID
  let role: Role
  let text: String

  init(id: UUID = UUID(), role: Role, text: String) {
    self.id = id
    self.role = role
    self.text = text
  }
}
