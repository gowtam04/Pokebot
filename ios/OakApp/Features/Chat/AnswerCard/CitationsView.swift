import SwiftUI

/// The "Sources" section at the foot of an ``AnswerCardView`` — the cited sources
/// backing the answer (M-AC-1.2; transparency is a first-class surface). Renders
/// **nothing** when there are no citations.
///
/// Mirrors the web `SourceList`: a collapsible disclosure, closed by default,
/// titled "Sources" with a count pill. Each ``Citation`` shows its `source` in
/// bold, the `detail` muted, and `endpoint_url` (when present) as a tappable link.
/// The link is distinguished by an icon + underline, never color alone
/// (M-AC-UI9.3); the section title and rows use `Theme`'s Dynamic-Type styles and
/// system-semantic colors, so they adapt to text size and light/dark for free.
struct CitationsView: View {
  let citations: [Citation]

  @State private var isExpanded = false

  var body: some View {
    if !citations.isEmpty {
      DisclosureGroup(isExpanded: $isExpanded) {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(citations.enumerated()), id: \.offset) { _, citation in
            citationRow(citation)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
      } label: {
        header
      }
      // Tint the disclosure chevron to the muted text color (it's a footer affordance).
      .tint(Theme.textSecondary)
    }
  }

  /// Section title: a book glyph + "Sources" + a count pill (text carries meaning,
  /// not the glyph alone).
  private var header: some View {
    HStack(spacing: 8) {
      Image(systemName: "book")
        .foregroundStyle(Theme.textSecondary)
        .imageScale(.small)
      Text("Sources")
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.textPrimary)
      countPill
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Sources, \(citations.count)")
  }

  private var countPill: some View {
    Text("\(citations.count)")
      .font(Theme.mono(.caption2))
      .foregroundStyle(Theme.textSecondary)
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(Theme.surfaceRaised, in: Capsule())
      .accessibilityHidden(true)
  }

  /// One citation: `source` bold, `detail` muted, and the optional endpoint link.
  private func citationRow(_ citation: Citation) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(citation.source)
        .font(Theme.body(.footnote))
        .fontWeight(.semibold)
        .foregroundStyle(Theme.textPrimary)
      Text(citation.detail)
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textSecondary)
      if let endpointUrl = citation.endpointUrl, !endpointUrl.isEmpty {
        endpointLink(endpointUrl)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// `endpoint_url` rendered as a tappable link — azure, underlined, with a link
  /// glyph so it reads as a link without relying on color. A present-but-unparseable
  /// URL degrades to plain muted text rather than crashing or vanishing.
  @ViewBuilder
  private func endpointLink(_ endpointUrl: String) -> some View {
    if let url = URL(string: endpointUrl) {
      Link(destination: url) {
        Label {
          Text(endpointUrl)
            .underline()
            .lineLimit(1)
            .truncationMode(.middle)
        } icon: {
          Image(systemName: "link")
        }
        .font(Theme.body(.footnote))
      }
      .foregroundStyle(Theme.azure)
      .accessibilityLabel("Open source link")
      .accessibilityHint(endpointUrl)
    } else {
      Text(endpointUrl)
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textMuted)
    }
  }
}

#if DEBUG
#Preview("Sources") {
  CitationsView(
    citations: [
      .init(
        source: "PokeAPI",
        detail: "Garchomp base stats (national dex #445)",
        endpointUrl: "https://pokeapi.co/api/v2/pokemon/445"
      ),
      .init(
        source: "Type chart",
        detail: "Dragon/Ground defensive multipliers",
        endpointUrl: nil
      ),
    ]
  )
  .padding()
}

#Preview("Empty (renders nothing)") {
  CitationsView(citations: [])
    .padding()
}
#endif
