import SwiftUI

/// Renders an answer's `damage_calc` — Oak's worked damage figure (M-AC-1.2 /
/// M-SUCCESS-3). Damage output is **always non-authoritative** (`is_estimate` is
/// `true` by schema), so the readout is clearly and prominently marked an
/// estimate: a "ESTIMATE" capsule pairing a tint with the ± icon **and** the word,
/// reinforced by a warning-tinted card border — never color alone (M-AC-UI9.3).
///
/// Below the marker it shows the computed `result` (e.g. min/max damage), the
/// `assumptions` that produced it, and — when present — an optional `breakdown`
/// disclosure ("show the math"). The result/assumption tables are built from the
/// structured `[String: JSONScalar]` maps (not from markdown), with values in the
/// monospaced "precise data" face. Colors come from `Theme` and type uses
/// Dynamic-Type styles, so the card adapts to light/dark and reflows (never clips)
/// at large text sizes (M-AC-1.4, M-AC-6.2, M-UI-US-1, M-UI-US-9).
///
/// Mirrors the web `DamageReadout`. The free-form maps are unordered after decode,
/// so entries render in a stable key-sorted order.
struct DamageCalcView: View {
  let damageCalc: DamageCalc

  @State private var breakdownExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header

      if !damageCalc.result.isEmpty {
        resultSection
      }

      if !damageCalc.assumptions.isEmpty {
        assumptionsSection
      }

      if let breakdown = trimmed(damageCalc.breakdown) {
        breakdownDisclosure(breakdown)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(
      Theme.surface,
      in: RoundedRectangle(cornerRadius: Theme.Radius.md)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Radius.md)
        .strokeBorder(Theme.warning.opacity(0.4), lineWidth: 1)
    )
  }

  // MARK: Header

  /// Title + the always-present estimate marker.
  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Label("Damage", systemImage: "bolt.fill")
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.textPrimary)
      Spacer(minLength: 8)
      estimateBadge
    }
  }

  /// The "ESTIMATE" capsule — tint + ± icon + word together carry the meaning, so
  /// the signal survives color-blindness and grayscale (M-AC-UI9.3).
  private var estimateBadge: some View {
    Label {
      Text("ESTIMATE")
        .font(Theme.body(.caption2).weight(.bold))
    } icon: {
      Image(systemName: "plusminus")
        .imageScale(.small)
    }
    .foregroundStyle(Theme.warning)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(Theme.warning.opacity(0.15), in: Capsule())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Estimate — not an exact value")
  }

  // MARK: Result

  /// The computed figure(s) — rendered prominently in the monospaced face.
  private var resultSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(sortedEntries(damageCalc.result), id: \.key) { entry in
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(humanize(entry.key))
            .font(Theme.body(.subheadline))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 8)
          Text(entry.value.displayText)
            .font(Theme.mono(.body).weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(humanize(entry.key)): \(entry.value.displayText)")
      }
    }
  }

  // MARK: Assumptions

  /// Every assumption that fed the estimate, shown inline (no disclosure) so the
  /// basis of the number is always visible (M-SUCCESS-3 — reasoning is surfaced).
  private var assumptionsSection: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Assumptions")
        .font(Theme.body(.caption).weight(.semibold))
        .foregroundStyle(Theme.textSecondary)

      ForEach(sortedEntries(damageCalc.assumptions), id: \.key) { entry in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(humanize(entry.key))
            .font(Theme.body(.caption))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 8)
          Text(entry.value.displayText)
            .font(Theme.mono(.caption))
            .foregroundStyle(Theme.textPrimary)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(humanize(entry.key)): \(entry.value.displayText)")
      }
    }
  }

  // MARK: Breakdown

  /// The optional worked breakdown, collapsed by default to avoid clutter. Shown
  /// in the monospaced face (it's a formula trace) and selectable for copy.
  private func breakdownDisclosure(_ breakdown: String) -> some View {
    DisclosureGroup(isExpanded: $breakdownExpanded) {
      Text(breakdown)
        .font(Theme.mono(.footnote))
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(.top, 6)
    } label: {
      Label("Show the math", systemImage: "function")
        .font(Theme.body(.footnote).weight(.medium))
        .foregroundStyle(Theme.textSecondary)
    }
    .tint(Theme.textSecondary)
  }

  // MARK: Helpers

  /// Stable, key-sorted entries — decoded `[String: JSONScalar]` maps have no
  /// inherent order, so sorting keeps rendering deterministic across re-decodes.
  private func sortedEntries(
    _ map: [String: JSONScalar]
  ) -> [(key: String, value: JSONScalar)] {
    map.sorted { $0.key < $1.key }
  }

  /// `max_damage` → `max damage` for display; the value is rendered verbatim.
  private func humanize(_ key: String) -> String {
    key.replacingOccurrences(of: "_", with: " ")
  }

  /// A non-empty, whitespace-trimmed string, or `nil` (render-if-present rule).
  private func trimmed(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// Display formatting for a `JSONScalar` cell. `private` (file-scoped) so it never
/// collides with a sibling AnswerCard view that formats the same maps.
private extension JSONScalar {
  /// A human-readable rendering of the scalar. Integers and strings render
  /// verbatim; a true fractional keeps its precision; a null shows an em dash.
  var displayText: String {
    switch self {
    case .string(let value): return value
    case .int(let value): return String(value)
    case .double(let value): return String(value)
    case .bool(let value): return value ? "true" : "false"
    case .null: return "—"
    }
  }
}

#if DEBUG
#Preview("Damage estimate") {
  DamageCalcView(
    damageCalc: DamageCalc(
      assumptions: [
        "level": .int(50),
        "power": .int(120),
        "attack_stat": .int(182),
        "defense_stat": .int(115),
        "stab": .bool(true),
        "type_effectiveness": .double(2.0),
      ],
      result: [
        "min_damage": .int(162),
        "max_damage": .int(192),
        "percent_of_hp": .string("78–92%"),
      ],
      isEstimate: true,
      breakdown:
        "((2*50/5+2)*120*182/115)/50 + 2 = 86; ×1.5 STAB ×2 effectiveness; "
        + "85–100% roll → 162–192."
    )
  )
  .padding()
}

#Preview("No breakdown") {
  DamageCalcView(
    damageCalc: DamageCalc(
      assumptions: ["type_effectiveness": .double(0.5)],
      result: ["min_damage": .int(40), "max_damage": .int(48)],
      isEstimate: true,
      breakdown: nil
    )
  )
  .padding()
}
#endif
