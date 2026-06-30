import SwiftUI

/// Renders an answer's `question` — the "ask the user" affordance shown on a
/// `clarification_needed` outcome, when the agent chose to STOP and ask rather
/// than answer generally (M-AC-1.2). Each option is a tappable, card-style choice;
/// tapping sends the option's `label` **verbatim** as the next user turn via the
/// ``onSelect`` callback, which the chat wiring turns into a normal follow-up POST
/// (the same UI→agent-input mechanism as suggestion chips / candidate rows). The
/// always-present composer covers the free-text path, so there's no "type your
/// own" affordance here.
///
/// Mirrors the web `QuestionOptions`: a stacked list of buttons, the `label` in
/// bold with optional `description` helper text beneath. Each row pairs a chevron
/// glyph with the text so the "tap to reply" affordance never rests on color alone
/// (M-AC-UI9.3); colors come from `Theme` and type uses Dynamic-Type styles, so
/// the choices adapt to light/dark and wrap (never clip) at large text sizes
/// (M-AC-1.4, M-UI-US-9).
///
/// Renders **nothing** when there is no question or it carries no options.
struct ClarifyQuestionView: View {
  let question: ClarifyQuestion?

  /// Invoked with the chosen option's `label`, sent verbatim as the next turn.
  /// The chat layer (P7 orchestrator) routes this into ``ChatViewModel`` so the
  /// choice becomes a normal follow-up message.
  let onSelect: (String) -> Void

  var body: some View {
    if let options = question?.options, !options.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Label("Pick one to continue", systemImage: "questionmark.circle")
          .font(Theme.display(.subheadline))
          .foregroundStyle(Theme.info)
          .accessibilityLabel("Pick one option to continue")

        ForEach(Array(options.enumerated()), id: \.offset) { _, option in
          optionButton(option)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// One option rendered as a full-width tappable card.
  private func optionButton(_ option: ClarifyOption) -> some View {
    Button {
      onSelect(option.label)
    } label: {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label)
            .font(Theme.body(.subheadline).weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)

          if let description = option.description?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !description.isEmpty
          {
            Text(description)
              .font(Theme.body(.footnote))
              .foregroundStyle(Theme.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Spacer(minLength: 8)

        Image(systemName: "chevron.right")
          .font(Theme.body(.footnote).weight(.semibold))
          .foregroundStyle(Theme.info)
          .accessibilityHidden(true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(
        Theme.surfaceRaised,
        in: RoundedRectangle(cornerRadius: Theme.Radius.md)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Radius.md)
          .strokeBorder(Theme.info.opacity(0.35), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel(for: option))
    .accessibilityHint("Sends this as your reply")
    .accessibilityAddTraits(.isButton)
  }

  private func accessibilityLabel(for option: ClarifyOption) -> String {
    guard let description = option.description?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !description.isEmpty
    else {
      return option.label
    }
    return "\(option.label). \(description)"
  }
}

#if DEBUG
#Preview("Clarify question") {
  ClarifyQuestionView(
    question: ClarifyQuestion(
      options: [
        .init(
          label: "Gen 9 (Scarlet/Violet)",
          description: "The current generation and competitive format."
        ),
        .init(
          label: "Gen 8 (Sword/Shield)",
          description: "Use the older Galar-era data and movepools."
        ),
        .init(label: "All generations", description: nil),
      ]
    ),
    onSelect: { _ in }
  )
  .padding()
}

#Preview("No question (renders nothing)") {
  ClarifyQuestionView(question: nil, onSelect: { _ in })
    .padding()
}
#endif
