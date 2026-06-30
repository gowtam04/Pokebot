import SwiftUI

/// Renders `OakAnswer.generationBasis` — the generation/format tag every answer
/// carries (M-AC-1.2) — and flags a generation **fallback** clearly when the
/// subject falls outside the active format's index (BR-1 / M-AC-6.2).
///
/// The fallback state is never signaled by color alone (M-AC-UI9.3): it pairs the
/// warning tint with a triangle icon, the word "Fallback", and an explanatory
/// note. Colors come from `Theme` and type uses Dynamic-Type styles, so the tag
/// adapts to light/dark and reflows (never clips) at large text sizes.
struct GenerationBasisView: View {
  let generationBasis: GenerationBasis

  var body: some View {
    let generation = generationBasis.generation
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let note = generationBasis.note?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let explanation = explanationLine(generation: generation, note: note)

    // `generation_basis` is a required answer field, but render nothing if there
    // is genuinely nothing to show — mirrors the render-if-present rule the rest
    // of the AnswerCard tree follows.
    if generation.isEmpty, !generationBasis.fallback, explanation == nil {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 4) {
        tag(generation: generation)
        if let explanation {
          Text(explanation)
            .font(Theme.body(.caption))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityElement(children: .combine)
    }
  }

  // MARK: Tag chip

  private func tag(generation: String) -> some View {
    let isFallback = generationBasis.fallback
    let tint = isFallback ? Theme.warning : Theme.textSecondary

    return Label {
      Text(labelText(generation: generation))
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: isFallback ? "exclamationmark.triangle.fill" : "tag.fill")
        .accessibilityHidden(true)
    }
    .font(Theme.body(.footnote).weight(.medium))
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
        .fill(isFallback ? Theme.warning.opacity(0.15) : Theme.surface)
    )
  }

  // MARK: Text

  /// The tag's visible text. A fallback is prefixed with the word "Fallback" so
  /// the meaning is carried by text, not the tint alone (M-AC-UI9.3).
  private func labelText(generation: String) -> String {
    let base = generation.isEmpty ? "Unknown generation" : generation
    return generationBasis.fallback ? "Fallback · \(base)" : base
  }

  /// The explanatory line under the tag: the model's `note` when present, else a
  /// default fallback message (mirroring the web `CaveatStrip`). `nil` means no
  /// line is shown (a non-fallback tag with no note stands alone).
  private func explanationLine(generation: String, note: String?) -> String? {
    if let note, !note.isEmpty { return note }
    guard generationBasis.fallback else { return nil }
    let base = generation.isEmpty ? "an earlier generation" : generation
    return "Based on \(base) data — this Pokémon is not in Gen 9."
  }
}

#Preview {
  VStack(alignment: .leading, spacing: 16) {
    GenerationBasisView(
      generationBasis: GenerationBasis(
        generation: "Gen 9 (Scarlet/Violet)",
        fallback: false,
        note: nil
      )
    )
    GenerationBasisView(
      generationBasis: GenerationBasis(
        generation: "Gen 8 (Sword/Shield)",
        fallback: true,
        note: nil
      )
    )
    GenerationBasisView(
      generationBasis: GenerationBasis(
        generation: "Gen 5 (Black/White)",
        fallback: true,
        note: "Stats reflect Gen 5; this form was removed in later games."
      )
    )
  }
  .padding()
}
