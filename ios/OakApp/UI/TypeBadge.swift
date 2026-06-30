import SwiftUI
import UIKit

/// A labeled Pokémon type chip — color **and** text, never color-only.
///
/// Mirrors the web "signature recipe" (`web/src/app/globals.css` `.type-badge`):
/// a faint type-tinted pill, strong type-colored text, and a soft type-colored
/// border. The palette is sourced from `Theme.type(_:)` (the single source of the
/// 18 type solids), so the same slug renders consistently everywhere it appears.
///
/// The type's name is always shown as text, so color is not the sole carrier of
/// meaning (M-AC-UI9.3). Typography uses a Dynamic Type text style — the chip
/// grows with the user's preferred size instead of clipping (M-AC-UI9.2).
struct TypeBadge: View {
  /// The lowercase type slug, e.g. `"fire"` (one of the 18 `TYPE_NAMES`).
  let type: String

  /// The user-facing label, capitalized from the slug (`"fire"` → `"Fire"`).
  private var label: String {
    type.capitalized
  }

  var body: some View {
    let color = Theme.type(type)
    Text(label)
      .font(.system(.caption2, design: .rounded).weight(.semibold))
      .tracking(0.4)
      .lineLimit(1)
      .padding(.horizontal, 10)
      .padding(.vertical, 3)
      .foregroundStyle(Self.mix(color, into: Theme.textPrimary, light: 0.72, dark: 0.45))
      .background(
        Self.mix(color, into: Theme.surface, light: 0.16, dark: 0.26),
        in: Capsule()
      )
      .overlay(Capsule().strokeBorder(color.opacity(0.30)))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(label) type")
  }
}

private extension TypeBadge {
  /// A color that blends `amount` of `type` into `base`, choosing the blend
  /// fraction per appearance (`light` vs `dark`). Resolved through a dynamic
  /// `UIColor` so it tracks the system trait collection (light/dark, contrast),
  /// mirroring the web `color-mix(in srgb, type X%, base)` recipe natively.
  static func mix(_ type: Color, into base: Color, light: CGFloat, dark: CGFloat) -> Color {
    Color(
      uiColor: UIColor { traits in
        let amount = traits.userInterfaceStyle == .dark ? dark : light
        let resolvedType = UIColor(type).resolvedColor(with: traits)
        let resolvedBase = UIColor(base).resolvedColor(with: traits)
        var (tr, tg, tb, ta): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (br, bg, bb, ba): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        resolvedType.getRed(&tr, green: &tg, blue: &tb, alpha: &ta)
        resolvedBase.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        let rest = 1 - amount
        return UIColor(
          red: tr * amount + br * rest,
          green: tg * amount + bg * rest,
          blue: tb * amount + bb * rest,
          alpha: ta * amount + ba * rest
        )
      }
    )
  }
}

#Preview("Type badges") {
  let types = [
    "normal", "fire", "water", "electric", "grass", "ice",
    "fighting", "poison", "ground", "flying", "psychic", "bug",
    "rock", "ghost", "dragon", "dark", "steel", "fairy",
  ]
  return ScrollView {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 12) {
      ForEach(types, id: \.self) { TypeBadge(type: $0) }
    }
    .padding()
  }
}
