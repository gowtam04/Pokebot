import SwiftUI

/// Renders runtime Markdown prose — `answer_markdown` and `reasoning_markdown`, and
/// any other free-form text an `OakAnswer` carries — using Apple's native
/// `AttributedString(markdown:)`. No third-party Markdown renderer (ADR-5).
///
/// Parsing uses `.inlineOnlyPreservingWhitespace`: inline markup (bold, italic,
/// `code`, links) is interpreted while paragraph and line breaks are preserved, so a
/// multi-line answer renders legibly as a single, wrapping `Text` (M-AC-1.2,
/// M-AC-1.4). Block structures the answer carries as STRUCTURED fields — tables,
/// sprites, team blocks — are deliberately not Markdown; their own AnswerCard
/// subviews render them, never this view.
///
/// Degrades gracefully (M-SUCCESS-3 / M-BR-CHAT-5 — answer fidelity): if the Markdown
/// fails to parse, the raw string is shown verbatim rather than dropping content.
///
/// Typography and color are inherited from the environment — this view sets neither —
/// so callers apply `.font(…)`/`.foregroundStyle(…)` and the text scales with Dynamic
/// Type (M-AC-UI1.4, M-UI-US-9) and adapts to light/dark automatically.
struct MarkdownText: View {
  private let markdown: String

  /// Text-like, unlabeled initializer mirroring `Text("…")`.
  init(_ markdown: String) {
    self.markdown = markdown
  }

  var body: some View {
    if let attributed = Self.parse(markdown) {
      Text(attributed)
    } else {
      // Parse failed outright — show the source verbatim (no localization-key
      // interpretation), so the user still sees the full content.
      Text(verbatim: markdown)
    }
  }

  /// Parses inline Markdown while preserving whitespace/newlines. Returns `nil` only
  /// when parsing throws even under the partial-parse policy, letting `body` fall
  /// back to the raw string.
  private static func parse(_ markdown: String) -> AttributedString? {
    try? AttributedString(
      markdown: markdown,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    )
  }
}

#if DEBUG
#Preview("MarkdownText") {
  ScrollView {
    VStack(alignment: .leading, spacing: 16) {
      MarkdownText(
        "**Garchomp** outspeeds **Dragapult** only with a *Choice Scarf* — base "
          + "`108` vs `142` Speed.\n\nWithout it, Dragapult wins the speed tie."
      )
      .font(Theme.body(.body))
      .foregroundStyle(Theme.textPrimary)

      MarkdownText("Source: [Bulbapedia](https://bulbapedia.bulbagarden.net)")
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textSecondary)
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
#endif
