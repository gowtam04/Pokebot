import SwiftUI

/// The live in-progress indicator shown while a turn streams (chat-experience.md
/// M-CHAT-US-4): a tool-activity ticker plus a "thinking"/"answering" state, so the
/// wait feels responsive and the reasoning is visible.
///
/// Purely presentational — it takes the reducer's coarse ``ChatViewModel/StreamingPhase``
/// and the tool-activity list and renders them. Meaning is carried by text + an SF
/// Symbol + the spinner, never color alone (M-AC-UI9.3); Dynamic-Type styles and
/// semantic colors adapt to text size and light/dark.
struct StreamingStatusView: View {
  let phase: ChatViewModel.StreamingPhase
  let activities: [ChatViewModel.ToolActivity]

  var body: some View {
    if phase != .idle {
      VStack(alignment: .leading, spacing: 8) {
        statusLine

        // The recent tool-activity ticker (newest last). Kept across answer_start so
        // the user can see what Oak looked up before it started writing.
        if !activities.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(activities) { activity in
              Label {
                Text(activity.label)
                  .font(Theme.body(.footnote))
                  .foregroundStyle(Theme.textSecondary)
              } icon: {
                Image(systemName: "wrench.and.screwdriver")
                  .foregroundStyle(Theme.azure)
              }
              .labelStyle(.titleAndIcon)
            }
          }
          .accessibilityElement(children: .combine)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
  }

  /// The headline status: a spinner paired with a phase label and icon.
  @ViewBuilder
  private var statusLine: some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.small)
      Image(systemName: phaseIcon)
        .foregroundStyle(Theme.accent)
        .imageScale(.small)
      Text(phaseLabel)
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.textPrimary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(phaseLabel)
  }

  private var phaseLabel: String {
    switch phase {
    case .idle: return ""
    case .thinking: return "Thinking…"
    case .usingTools: return "Looking things up…"
    case .answering: return "Writing the answer…"
    }
  }

  private var phaseIcon: String {
    switch phase {
    case .idle, .thinking: return "brain"
    case .usingTools: return "magnifyingglass"
    case .answering: return "text.append"
    }
  }
}

#if DEBUG
#Preview("Using tools") {
  StreamingStatusView(
    phase: .usingTools,
    activities: [
      .init(tool: "resolve_entity", label: "Resolving \"Garchomp\""),
      .init(tool: "get_pokemon", label: "Looking up Garchomp"),
    ]
  )
  .padding()
}

#Preview("Thinking") {
  StreamingStatusView(phase: .thinking, activities: [])
    .padding()
}
#endif
