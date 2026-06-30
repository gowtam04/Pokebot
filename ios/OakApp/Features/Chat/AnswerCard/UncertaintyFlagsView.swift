import SwiftUI

/// Renders an answer's `uncertainty_flags[]` — the explicit caveats Oak attaches
/// when something about the result is assumed, approximate, or unverified
/// (BR-1 / M-AC-1.2 / US-13). Each flag is a short caution the user should weigh
/// before trusting the answer.
///
/// Styling is the **solid** warning caveat strip — deliberately distinct from the
/// `InferencesView` dashed azure callout (inferred-but-cited) and from the
/// `GenerationBasisView` fallback tag (which carries the generation-fallback
/// caveat separately, mirroring the web `CaveatStrip` split). The caution is
/// carried by a triangle icon **and** the "Caveats" label **and** the flag text,
/// not the warning tint alone (M-AC-UI9.3); colors come from `Theme` and the type
/// ramp uses Dynamic-Type styles, so the strip adapts to light/dark and wraps
/// rather than clips at large text sizes (M-AC-1.4, M-UI-US-9).
///
/// Renders **nothing** when the field is absent, empty, or holds only blank
/// strings.
struct UncertaintyFlagsView: View {
  let uncertaintyFlags: [String]?

  /// Non-blank flags, trimmed — a stray `""` never renders an empty caveat row,
  /// and an all-blank array collapses to nothing.
  private var flags: [String] {
    (uncertaintyFlags ?? [])
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  var body: some View {
    if !flags.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Label("Caveats", systemImage: "exclamationmark.triangle.fill")
          .font(Theme.display(.subheadline))
          .foregroundStyle(Theme.warning)
          .accessibilityLabel("Caveats — things to keep in mind")

        ForEach(Array(flags.enumerated()), id: \.offset) { _, flag in
          row(flag)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(
        Theme.warning.opacity(0.10),
        in: RoundedRectangle(cornerRadius: Theme.Radius.md)
      )
      // SOLID border (vs. the inferences' dashed edge) — the visual tell that
      // these are caveats, not deductions.
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Radius.md)
          .strokeBorder(Theme.warning.opacity(0.5), lineWidth: 1)
      )
    }
  }

  /// One caveat: a leading triangle glyph + the flag text. The icon repeats the
  /// caution so the tint is reinforcement, never the sole signal (M-AC-UI9.3).
  private func row(_ flag: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .imageScale(.small)
        .foregroundStyle(Theme.warning)
        .accessibilityHidden(true)

      Text(flag)
        .font(Theme.body(.subheadline))
        .foregroundStyle(Theme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Caveat: \(flag)")
  }
}

#if DEBUG
#Preview("Caveats") {
  UncertaintyFlagsView(
    uncertaintyFlags: [
      "Result assumes the standard Rough Skin ability.",
      "Damage roll is an estimate — exact EV investment of the opponent is unknown.",
      "This Pokémon is not available in Gen 9.",
    ]
  )
  .padding()
}

#Preview("Absent (renders nothing)") {
  UncertaintyFlagsView(uncertaintyFlags: nil)
    .padding()
}

#Preview("Blank-only (renders nothing)") {
  UncertaintyFlagsView(uncertaintyFlags: ["", "   "])
    .padding()
}
#endif
