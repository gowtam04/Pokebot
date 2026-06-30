import SwiftUI

/// Renders an answer's `suggestions[]` (mirrors the web `SuggestionChips`) — the
/// closest-match / follow-up prompts Oak offers, most often on a
/// `resolution_failed` ("Did you mean …") or `clarification_needed` turn, but
/// valid on any status. Each suggestion is a **tappable chip**; tapping it calls
/// ``onSelect`` with the verbatim text, which the host sends as the next user
/// message (M-SUCCESS-3 — structural fidelity to the web AnswerCard).
///
/// The header label is status-aware (`resolution_failed` → "Did you mean", else
/// "Suggestions") and carried by **text + icon**, not color (M-UI-US-9). Chips use
/// `Theme`'s accent tint with a border + label so the affordance never relies on
/// hue alone, and `Theme`'s Dynamic-Type styles + a wrapping flow layout so chips
/// reflow across rows (and long text wraps within a chip) rather than clip at large
/// text sizes / in light or dark (M-AC-1.4, M-UI-US-1).
///
/// Renders **nothing** when there are no (non-blank) suggestions.
struct SuggestionsView: View {
  let suggestions: [String]
  /// Drives the header label only; defaults so the host may omit it.
  var status: OakAnswer.Status = .answered
  /// Sends the tapped suggestion verbatim as the next user message.
  let onSelect: (String) -> Void

  var body: some View {
    let items = suggestions
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        header
        SuggestionFlowLayout(spacing: 8) {
          ForEach(Array(items.enumerated()), id: \.offset) { _, text in
            chip(text)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: Header

  /// "Did you mean" for a resolution miss, otherwise "Suggestions" — paired with
  /// an icon so the section reads without relying on color (M-UI-US-9).
  private var header: some View {
    Label(headerText, systemImage: headerIcon)
      .font(Theme.display(.subheadline))
      .foregroundStyle(Theme.textSecondary)
      .accessibilityAddTraits(.isHeader)
  }

  private var headerText: String {
    status == .resolutionFailed ? "Did you mean" : "Suggestions"
  }

  private var headerIcon: String {
    status == .resolutionFailed ? "magnifyingglass" : "text.bubble"
  }

  // MARK: Chip

  /// One suggestion as an accent-tinted, bordered capsule button. The text wraps
  /// (never truncates) so a long suggestion grows the chip instead of clipping.
  private func chip(_ text: String) -> some View {
    Button {
      onSelect(text)
    } label: {
      Text(text)
        .font(Theme.body(.subheadline).weight(.medium))
        .foregroundStyle(Theme.accent)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.accent.opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.accent.opacity(0.35), lineWidth: 1))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Ask: \(text)")
    .accessibilityHint("Sends this as your next message")
  }
}

/// A minimal wrapping (flow) layout: places its subviews left-to-right at their
/// ideal size and wraps to a new row when the next subview would overflow the
/// proposed width. A subview wider than the container is clamped to the container
/// width so its own content (the chip's text) wraps instead of clipping
/// (M-AC-1.4). Scoped to this file — the suggestion chips are its only client.
private struct SuggestionFlowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    let rows = rows(maxWidth: maxWidth, subviews: subviews)
    let width = proposal.width ?? rows.map(\.width).max() ?? 0
    let height = rows.reduce(0) { $0 + $1.height }
      + spacing * CGFloat(max(0, rows.count - 1))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
    let rows = rows(maxWidth: bounds.width, subviews: subviews)
    var y = bounds.minY
    for row in rows {
      var x = bounds.minX
      for item in row.items {
        subviews[item.index].place(
          at: CGPoint(x: x, y: y),
          anchor: .topLeading,
          proposal: ProposedViewSize(width: item.size.width, height: item.size.height)
        )
        x += item.size.width + spacing
      }
      y += row.height + spacing
    }
  }

  // MARK: Row packing

  private struct Row {
    var items: [(index: Int, size: CGSize)] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  /// Greedy left-to-right packing into rows bounded by `maxWidth`.
  private func rows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
    let cap = maxWidth.isFinite ? maxWidth : .infinity
    var rows: [Row] = []
    var current = Row()

    for index in subviews.indices {
      let ideal = subviews[index].sizeThatFits(ProposedViewSize(width: cap, height: nil))
      let size = CGSize(width: min(ideal.width, cap), height: ideal.height)

      if !current.items.isEmpty, current.width + spacing + size.width > maxWidth {
        rows.append(current)
        current = Row()
      }

      current.width += (current.items.isEmpty ? 0 : spacing) + size.width
      current.height = max(current.height, size.height)
      current.items.append((index, size))
    }

    if !current.items.isEmpty { rows.append(current) }
    return rows
  }
}

#if DEBUG
#Preview("Did you mean (resolution_failed)") {
  SuggestionsView(
    suggestions: ["Garchomp", "Gabite", "Gible"],
    status: .resolutionFailed
  ) { _ in }
    .padding()
}

#Preview("Follow-up suggestions") {
  SuggestionsView(
    suggestions: [
      "What's its hidden ability?",
      "Show its best moveset for Gen 9 VGC",
      "How does it fare against Dragapult?",
    ]
  ) { _ in }
    .padding()
}

#Preview("Empty (renders nothing)") {
  SuggestionsView(suggestions: []) { _ in }
    .padding()
}
#endif
