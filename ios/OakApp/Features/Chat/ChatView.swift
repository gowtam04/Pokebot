import SwiftUI
import UIKit

/// The chat thread screen (chat-experience.md M-CHAT-US-1/2/3/4): a scrolling
/// conversation of user messages and reasoned answers, a live streaming section
/// while a turn is in flight, a recoverable error banner, and the composer.
///
/// The view owns its ``ChatViewModel`` (`@State`) and drives it directly; all logic
/// and the SSE reducer live in the view model. Finalized answers render through the
/// full field-by-field ``AnswerCardView`` tree (status, reasoning, citations,
/// inferences, candidates, damage calc, team blocks, clarify options, suggestions,
/// uncertainty…); a clarify-option or suggestion tap is sent verbatim as the next
/// user turn. Layout uses Dynamic-Type styles and semantic colors so it adapts to
/// text size and light/dark.
struct ChatView: View {
  @State private var model: ChatViewModel

  init(model: ChatViewModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        thread
        Divider()
        if let banner = model.errorBanner {
          errorBannerView(banner)
        }
        ComposerView(model: model)
      }
      .navigationTitle("Oak")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            model.startNewConversation()
          } label: {
            Label("New conversation", systemImage: "square.and.pencil")
          }
        }
      }
    }
    // Tear down the stream when the screen goes away (conventions.md "Concurrency").
    .onDisappear { model.cancelStreaming() }
  }

  // MARK: Thread

  private var thread: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          if model.turns.isEmpty && !model.isStreaming {
            emptyState
          }

          ForEach(model.turns) { turn in
            turnView(turn)
              .id(turn.id)
          }

          // The in-flight turn: live status + streamed prose as it arrives.
          if model.isStreaming || !model.streamingText.isEmpty {
            inProgressView
              .id(Self.inProgressAnchor)
          }
        }
        .padding(16)
      }
      .scrollDismissesKeyboard(.interactively)
      // Keep the newest content in view as turns/tokens arrive (M-AC-2.2).
      .onChange(of: model.turns.count) { _, _ in scrollToBottom(proxy) }
      .onChange(of: model.streamingText) { _, _ in scrollToBottom(proxy) }
      .onChange(of: model.toolActivities.count) { _, _ in scrollToBottom(proxy) }
    }
  }

  @ViewBuilder
  private func turnView(_ turn: ChatViewModel.ChatTurnItem) -> some View {
    switch turn.content {
    case let .user(text, imageCount):
      UserMessageView(text: text, imageCount: imageCount)
    case let .assistant(answer):
      // The full field-by-field card. A clarify-option / suggestion tap sends its
      // text verbatim as the next user turn (the same UI→agent-input path the web
      // uses); team-block actions are wired by later phases (P10 / artifact).
      AnswerCardView(answer: answer, onFollowUp: sendFollowUp)
    }
  }

  /// Sends `text` verbatim as the next user message (clarify options + suggestion
  /// chips). A no-op while a turn is already streaming.
  private func sendFollowUp(_ text: String) {
    model.composerText = text
    model.send()
  }

  /// The live streaming section: the status ticker, then the streamed prose (which
  /// the terminal answer later replaces, authoritatively).
  private var inProgressView: some View {
    VStack(alignment: .leading, spacing: 12) {
      StreamingStatusView(phase: model.streamingPhase, activities: model.toolActivities)
      if !model.streamingText.isEmpty {
        MarkdownText(model.streamingText)
          .font(Theme.body(.body))
          .foregroundStyle(Theme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var emptyState: some View {
    ContentUnavailableView {
      Label("Ask Oak", systemImage: "bubble.left.and.text.bubble.right")
    } description: {
      Text("Every answer carries its reasoning, sources, and the generation it's based on.")
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 48)
  }

  // MARK: Error banner

  @ViewBuilder
  private func errorBannerView(_ banner: ChatViewModel.ErrorBanner) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(Theme.danger)
      Text(banner.message)
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
      if banner.isRetryable {
        Button("Retry") { model.retry() }
          .font(Theme.display(.footnote))
          .buttonStyle(.borderless)
          .tint(Theme.accent)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.danger.opacity(0.12))
  }

  // MARK: Helpers

  private static let inProgressAnchor = "oak.inProgress"

  private func scrollToBottom(_ proxy: ScrollViewProxy) {
    withAnimation(.easeOut(duration: 0.2)) {
      if model.isStreaming || !model.streamingText.isEmpty {
        proxy.scrollTo(Self.inProgressAnchor, anchor: .bottom)
      } else if let last = model.turns.last {
        proxy.scrollTo(last.id, anchor: .bottom)
      }
    }
  }
}

// MARK: - User message

/// A user's message bubble, trailing-aligned. Shows an attached-image caption when
/// the turn carried photos (the actual thumbnails are P8).
private struct UserMessageView: View {
  let text: String
  let imageCount: Int

  var body: some View {
    HStack {
      Spacer(minLength: 32)
      VStack(alignment: .trailing, spacing: 4) {
        if !text.isEmpty {
          Text(text)
            .font(Theme.body(.body))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.Radius.lg))
        }
        if imageCount > 0 {
          Label("\(imageCount) image(s) attached", systemImage: "photo")
            .font(Theme.body(.caption))
            .foregroundStyle(Theme.textSecondary)
        }
      }
    }
  }
}

#if DEBUG
/// A preview/canvas ``ChatService`` that streams a short scripted answer without the
/// network. Shared by the chat feature's previews (internal, not `private`).
struct PreviewChatService: ChatService {
  func send(
    sessionId: String,
    message: String,
    images: [UIImage],
    championsMode: Bool,
    activeTeamId: String?
  ) -> AsyncThrowingStream<SSEEvent, Error> {
    AsyncThrowingStream { continuation in
      let answer = OakAnswer(
        status: .answered,
        answerMarkdown: "**Garchomp** is a Dragon/Ground pseudo-legendary with a base stat total of 600.",
        reasoningMarkdown: "Resolved Garchomp and read its base stats and typing.",
        citations: [],
        inferences: [],
        generationBasis: GenerationBasis(generation: "Gen 9 (Scarlet/Violet)", fallback: false, note: nil),
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
      continuation.yield(.toolActivity(tool: "resolve_entity", label: "Resolving \"Garchomp\""))
      continuation.yield(.answerStart)
      continuation.yield(.answerDelta(text: answer.answerMarkdown))
      continuation.yield(.answer(answer))
      continuation.finish()
    }
  }
}

#Preview("Chat") {
  ChatView(model: ChatViewModel(chat: PreviewChatService(), appState: AppState()))
}
#endif
