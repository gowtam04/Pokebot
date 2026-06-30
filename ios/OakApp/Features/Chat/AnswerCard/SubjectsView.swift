import SwiftUI

/// Renders an answer's `subjects[]` — the primary entities the answer is about —
/// as a stack of sprite cards (sprite, display name, optional Dex number, type
/// badges, and a fallback flag when the data is pre-Gen-9).
///
/// Native mirror of the web `SpriteCard` (`web/src/components/answer-card/
/// SpriteCard.tsx`): the sprite comes from the answer payload (`SpriteImage`
/// handles placeholder/failure), types render as `TypeBadge` chips (color **and**
/// label — never color alone, M-AC-UI9.3), and `is_fallback` surfaces an explicit,
/// icon+text warning pill (BR-1: pre-Gen-9 data used as a fallback).
///
/// Renders **nothing** when there are no subjects (the field is absent on most
/// answers). Layout is vertical (sprite beside name/badges) with a `@ScaledMetric`
/// sprite, so it reflows under Dynamic Type and light/dark without horizontal
/// clipping (M-AC-1.4). Tapping a subject to open its artifact is wired in a later
/// phase; this view is display-only.
struct SubjectsView: View {
  let subjects: [Subject]

  var body: some View {
    if !subjects.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array(subjects.enumerated()), id: \.offset) { _, subject in
          SubjectCard(subject: subject)
        }
      }
    }
  }
}

// MARK: - One subject

/// A single sprite card: the sprite on a subtle "Pokédex screen" wash, beside the
/// name + Dex number, an optional fallback pill, and the type badges.
private struct SubjectCard: View {
  let subject: Subject

  /// The sprite scales with the user's text size so it never looks tiny next to
  /// large Dynamic Type (M-AC-UI1.4 / M-AC-UI9.2); it's an image, so a base point
  /// size is appropriate — `@ScaledMetric` keeps it proportional.
  @ScaledMetric(relativeTo: .body) private var spriteSize: CGFloat = 72

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      SpriteImage(url: URL(string: subject.spriteUrl), name: subject.name, size: spriteSize)
        .padding(6)
        .background(
          Theme.azure.opacity(0.06),
          in: RoundedRectangle(cornerRadius: Theme.Radius.md)
        )

      VStack(alignment: .leading, spacing: 6) {
        nameRow
        if subject.isFallback {
          fallbackPill
        }
        typeBadges
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      Theme.surfaceRaised,
      in: RoundedRectangle(cornerRadius: Theme.Radius.lg)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Radius.lg)
        .strokeBorder(Theme.separator, lineWidth: 1)
    )
    // One combined VoiceOver label so the card reads as a single, ordered unit
    // (M-AC-UI9.1) instead of disjoint sprite/badge fragments.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  // MARK: Name + dex

  private var nameRow: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(subject.name)
        .font(Theme.display(.headline))
        .foregroundStyle(Theme.textPrimary)
      if let dex = subject.dexNumber {
        Text(dexLabel(dex))
          .font(Theme.mono(.subheadline))
          .foregroundStyle(Theme.textMuted)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: Fallback flag (icon + text + color — never color alone, M-AC-UI9.3)

  private var fallbackPill: some View {
    Label(fallbackText, systemImage: "clock.arrow.circlepath")
      .font(Theme.display(.caption2))
      .foregroundStyle(Theme.warning)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(
        Theme.warning.opacity(0.14),
        in: Capsule()
      )
  }

  // MARK: Type badges (primary type first)

  private var typeBadges: some View {
    HStack(spacing: 6) {
      ForEach(subject.types, id: \.self) { type in
        TypeBadge(type: type)
      }
    }
  }

  // MARK: Helpers

  /// `is_fallback` label text — mirrors the web card: the source generation when
  /// known (e.g. "Gen 8"), else a plain "Fallback".
  private var fallbackText: String {
    subject.sourceGeneration ?? "Fallback"
  }

  /// National Dex number, zero-padded to four digits (e.g. `#0006`).
  private func dexLabel(_ number: Int) -> String {
    String(format: "#%04d", number)
  }

  /// Ordered, spoken description for VoiceOver: name, Dex number, types, fallback.
  private var accessibilityLabel: String {
    var parts: [String] = [subject.name]
    if let dex = subject.dexNumber {
      parts.append("number \(dex)")
    }
    if !subject.types.isEmpty {
      let typeList = subject.types.map { $0.capitalized }.joined(separator: ", ")
      parts.append("\(typeList) type")
    }
    if subject.isFallback {
      let from = subject.sourceGeneration.map { " from \($0)" } ?? ""
      parts.append("fallback data\(from)")
    }
    return parts.joined(separator: ", ")
  }
}

#if DEBUG
#Preview("Subjects") {
  ScrollView {
    SubjectsView(subjects: [
      Subject(
        name: "Garchomp",
        dexNumber: 445,
        spriteUrl: "https://example.invalid/garchomp.png",
        types: ["dragon", "ground"],
        isFallback: false,
        sourceGeneration: nil
      ),
      Subject(
        name: "Stantler",
        dexNumber: 234,
        spriteUrl: "https://example.invalid/stantler.png",
        types: ["normal"],
        isFallback: true,
        sourceGeneration: "Gen 8"
      ),
    ])
    .padding()
  }
}
#endif
