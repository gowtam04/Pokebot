import SwiftUI

/// The saved-conversation list (history-and-teams.md M-HIST-US-2; M-UI-US-4): a
/// searchable, format-filterable list of conversations with native list patterns —
/// swipe actions, context menus, and pull-to-refresh (M-AC-H2.5).
///
/// **Content-only / signed-in only.** It does not own a `NavigationStack` — the Chat
/// tab's signed-in home embeds it inside its own stack (titled "Chats") and supplies
/// the New-Chat toolbar button. It is shown only when signed in (M-BR-H1), so there
/// is no guest branch here; a guest gets the single-thread chat instead. The view
/// owns its ``HistoryListViewModel`` (`@State`) and drives it; all logic lives in the
/// view model. Tapping a row hands the conversation back to the Chat tab via
/// ``onSelect``, which pushes the thread route (load detail + resume into chat).
struct ConversationListView: View {
  @State private var model: HistoryListViewModel

  /// Called when a conversation row is tapped — the Chat tab pushes the thread
  /// route, which loads the detail and resumes it into chat (M-AC-H3.1).
  private let onSelect: (ConversationSummary) -> Void

  /// The conversation currently being renamed (drives the rename alert).
  @State private var renameTarget: ConversationSummary?
  @State private var renameText: String = ""

  init(
    model: HistoryListViewModel,
    onSelect: @escaping (ConversationSummary) -> Void
  ) {
    _model = State(initialValue: model)
    self.onSelect = onSelect
  }

  var body: some View {
    @Bindable var model = model
    listContent
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          formatFilterMenu
        }
      }
      .searchable(text: $model.searchQuery, prompt: "Search conversations")
      .onSubmit(of: .search) {
        Task { await model.search() }
      }
      // Initial load; pull-to-refresh and search/filter changes re-fetch on their own.
      .task { await model.reload() }
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

  // MARK: Empty / error states

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

#if DEBUG
/// A preview-only ``HistoryService`` returning a small static list without the
/// network, so the canvas renders the conversation list. Confined to this file.
private struct PreviewHistoryService: HistoryService {
  func list(query: String?, format: Format?) async throws -> [ConversationSummary] {
    [
      ConversationSummary(
        id: "1", title: "Garchomp's best moveset",
        format: .scarletViolet, pinned: true, updatedAt: 1_700_000_000_000
      ),
      ConversationSummary(
        id: "2", title: "Champions: Miraidon counters",
        format: .champions, pinned: false, updatedAt: 1_699_900_000_000
      ),
    ]
  }
  func get(id: String) async throws -> ConversationDetail {
    ConversationDetail(id: id, title: "Conversation", format: .scarletViolet, pinned: false, turns: [])
  }
  func rename(id: String, title: String) async throws {}
  func setPinned(id: String, pinned: Bool) async throws {}
  func delete(id: String) async throws {}
  func importGuestThread(sessionId: String, championsMode: Bool, turns: [ChatTurn]) async throws -> String? { nil }
}

#Preview("Conversations") {
  NavigationStack {
    ConversationListView(
      model: HistoryListViewModel(history: PreviewHistoryService()),
      onSelect: { _ in }
    )
    .navigationTitle("Chats")
  }
}
#endif
