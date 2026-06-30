import SwiftUI

/// The chat-history list screen (history-and-teams.md M-HIST-US-2; M-UI-US-4): a
/// searchable, format-filterable list of saved conversations with native list
/// patterns — swipe actions, context menus, and pull-to-refresh (M-AC-H2.5).
///
/// History is signed-in only (M-BR-H1): a guest sees a sign-in prompt, not an empty
/// list. The view owns its ``HistoryListViewModel`` (`@State`) and drives it; all
/// logic lives in the view model. Tapping a row hands the conversation back to the
/// presenter via ``onSelect`` (which loads the detail and resumes into chat).
struct HistoryListView: View {
  @Environment(AppState.self) private var appState
  @State private var model: HistoryListViewModel

  /// Called when a conversation row is tapped — the presenter opens the detail and
  /// resumes the thread into chat. Defaults to a no-op for standalone previews.
  private let onSelect: (ConversationSummary) -> Void

  /// The conversation currently being renamed (drives the rename alert).
  @State private var renameTarget: ConversationSummary?
  @State private var renameText: String = ""

  init(
    model: HistoryListViewModel,
    onSelect: @escaping (ConversationSummary) -> Void = { _ in }
  ) {
    _model = State(initialValue: model)
    self.onSelect = onSelect
  }

  private var isSignedIn: Bool {
    if case .signedIn = appState.authState { return true }
    return false
  }

  var body: some View {
    @Bindable var model = model
    NavigationStack {
      Group {
        if !isSignedIn {
          guestState
        } else {
          listContent
        }
      }
      .navigationTitle("History")
      .toolbar {
        if isSignedIn {
          ToolbarItem(placement: .topBarTrailing) {
            formatFilterMenu
          }
        }
      }
    }
    .searchable(text: $model.searchQuery, prompt: "Search conversations")
    .onSubmit(of: .search) {
      Task { await model.search() }
    }
    // Load once signed in (and reload if the auth state flips).
    .task(id: isSignedIn) {
      if isSignedIn { await model.reload() }
    }
    .alert(
      "Rename conversation",
      isPresented: renameBinding,
      presenting: renameTarget
    ) { conversation in
      TextField("Title", text: $renameText)
      Button("Save") {
        let title = renameText
        Task { await model.rename(conversation, to: title) }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  // MARK: List

  @ViewBuilder
  private var listContent: some View {
    if model.conversations.isEmpty {
      if model.isLoading {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        emptyState
      }
    } else {
      List {
        ForEach(model.conversations) { conversation in
          Button {
            onSelect(conversation)
          } label: {
            ConversationRow(conversation: conversation)
          }
          .buttonStyle(.plain)
          .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
              Task { await model.delete(conversation) }
            } label: {
              Label("Delete", systemImage: "trash")
            }
          }
          .swipeActions(edge: .leading) {
            Button {
              Task { await model.togglePin(conversation) }
            } label: {
              Label(
                conversation.pinned ? "Unpin" : "Pin",
                systemImage: conversation.pinned ? "pin.slash" : "pin"
              )
            }
            .tint(Theme.accent)
          }
          .contextMenu {
            Button {
              renameText = conversation.title
              renameTarget = conversation
            } label: {
              Label("Rename", systemImage: "pencil")
            }
            Button {
              Task { await model.togglePin(conversation) }
            } label: {
              Label(
                conversation.pinned ? "Unpin" : "Pin",
                systemImage: conversation.pinned ? "pin.slash" : "pin"
              )
            }
            Button(role: .destructive) {
              Task { await model.delete(conversation) }
            } label: {
              Label("Delete", systemImage: "trash")
            }
          }
        }
      }
      .listStyle(.plain)
      .refreshable { await model.reload() }
      .overlay(alignment: .bottom) {
        if let message = model.errorMessage {
          errorBanner(message)
        }
      }
    }
  }

  private var formatFilterMenu: some View {
    Menu {
      filterButton(title: "All formats", format: nil)
      filterButton(title: "Standard", format: .scarletViolet)
      filterButton(title: "Champions", format: .champions)
    } label: {
      Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
    }
  }

  @ViewBuilder
  private func filterButton(title: String, format: Format?) -> some View {
    Button {
      Task { await model.setFormatFilter(format) }
    } label: {
      if model.formatFilter == format {
        Label(title, systemImage: "checkmark")
      } else {
        Text(title)
      }
    }
  }

  // MARK: Empty / guest / error states

  private var guestState: some View {
    ContentUnavailableView {
      Label("Sign in for history", systemImage: "clock.arrow.circlepath")
    } description: {
      Text("Sign in to save your conversations and pick them up on any device.")
    }
  }

  private var emptyState: some View {
    ContentUnavailableView {
      Label(searchActive ? "No matches" : "No conversations yet", systemImage: "bubble.left.and.bubble.right")
    } description: {
      Text(
        searchActive
          ? "No saved conversations match your search."
          : "Conversations you have with Oak are saved here automatically."
      )
    }
  }

  private var searchActive: Bool {
    !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || model.formatFilter != nil
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text(message)
        .font(.footnote)
      Spacer(minLength: 0)
      Button("Dismiss") { model.dismissError() }
        .font(.footnote)
    }
    .padding(12)
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    .padding()
  }

  // MARK: Rename alert binding

  /// A bool binding that mirrors `renameTarget != nil` so the alert presents while a
  /// target is set and clears it on dismiss.
  private var renameBinding: Binding<Bool> {
    Binding(
      get: { renameTarget != nil },
      set: { if !$0 { renameTarget = nil } }
    )
  }
}

/// One conversation row: title, a format tag, and the last-active time. Color is
/// never the sole signal — the format is shown as text (M-AC-UI9.3 / conventions.md).
private struct ConversationRow: View {
  let conversation: ConversationSummary

  var body: some View {
    HStack(spacing: 12) {
      if conversation.pinned {
        Image(systemName: "pin.fill")
          .font(.caption)
          .foregroundStyle(Theme.accent)
          .accessibilityLabel("Pinned")
      }
      VStack(alignment: .leading, spacing: 4) {
        Text(conversation.title)
          .font(.body)
          .lineLimit(1)
        HStack(spacing: 6) {
          Text(formatLabel)
          Text("·")
          Text(updatedAt, format: .relative(presentation: .named))
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .contentShape(Rectangle())
  }

  private var formatLabel: String {
    switch conversation.format {
    case .scarletViolet: return "Standard"
    case .champions: return "Champions"
    }
  }

  private var updatedAt: Date {
    Date(timeIntervalSince1970: Double(conversation.updatedAt) / 1000)
  }
}
