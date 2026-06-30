import SwiftUI
import UIKit

/// Oak's brand expression over iOS.
///
/// Colors are sourced from the web design system (`web/src/app/globals.css`) and
/// re-expressed natively. Brand/semantic/type colors adapt to light & dark via a
/// dynamic `UIColor` provider; surfaces and text use the system semantic colors so
/// they inherit Dynamic Type contrast, increased-contrast, and dark-mode behavior
/// automatically (M-AC-UI1.2, M-AC-UI1.3, M-AC-UI1.4).
///
/// Color is never the sole carrier of meaning (M-AC-UI9.3) — that pairing with
/// text/icon is the calling view's responsibility; `Theme` only supplies the
/// palette and type ramp.
enum Theme {
  // MARK: Brand

  /// Pokédex red — the primary brand/accent color (mirrored by `AccentColor`).
  static let accent = adaptive(light: 0xEE5A5A, dark: 0xFF6B6B)
  static let accentHover = adaptive(light: 0xE04545, dark: 0xFF7E7E)
  static let accentActive = adaptive(light: 0xC93B3B, dark: 0xF25C5C)
  static let sunflower = adaptive(light: 0xF5A524, dark: 0xF8B73E)
  static let azure = adaptive(light: 0x3AA0E3, dark: 0x5BB4EF)

  // MARK: Semantic

  static let success = adaptive(light: 0x2FB573, dark: 0x46C98A)
  static let warning = adaptive(light: 0xF08C00, dark: 0xFBA53B)
  static let danger = adaptive(light: 0xE0394A, dark: 0xFF5C6B)
  static let info = adaptive(light: 0x3AA0E3, dark: 0x5BB4EF)

  // MARK: Surfaces & text (system semantics — adapt for free)

  static let background = Color(uiColor: .systemBackground)
  static let surface = Color(uiColor: .secondarySystemBackground)
  static let surfaceRaised = Color(uiColor: .tertiarySystemBackground)
  static let separator = Color(uiColor: .separator)
  static let textPrimary = Color(uiColor: .label)
  static let textSecondary = Color(uiColor: .secondaryLabel)
  static let textMuted = Color(uiColor: .tertiaryLabel)

  // MARK: Corner radii (brand favors generous rounding)

  enum Radius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let pill: CGFloat = 999
  }

  // MARK: Typography (Dynamic Type styles only — no fixed point sizes)

  /// Display face — rounded + semibold to echo Oak's "playful chrome".
  static func display(_ style: Font.TextStyle = .title) -> Font {
    .system(style, design: .rounded).weight(.semibold)
  }

  /// Body face — the system default at the given text style.
  static func body(_ style: Font.TextStyle = .body) -> Font {
    .system(style)
  }

  /// Monospaced face — for "precise data" (stats, dex numbers, damage rolls).
  static func mono(_ style: Font.TextStyle = .body) -> Font {
    .system(style, design: .monospaced)
  }

  // MARK: Pokémon type colors (theme-stable, mirrors the 18 web type solids)

  /// The brand color for a Pokémon type name (e.g. "fire"). Unknown names fall
  /// back to the Normal-type solid. Pair with the type's text label — never use
  /// color alone to convey the type (M-AC-UI9.3).
  static func type(_ name: String) -> Color {
    typeColors[name.lowercased()] ?? typeColors["normal"]!
  }

  private static let typeColors: [String: Color] = [
    "normal": solid(0xA8A77A),
    "fire": solid(0xEE8130),
    "water": solid(0x6390F0),
    "electric": solid(0xF7D02C),
    "grass": solid(0x7AC74C),
    "ice": solid(0x96D9D6),
    "fighting": solid(0xC22E28),
    "poison": solid(0xA33EA1),
    "ground": solid(0xE2BF65),
    "flying": solid(0xA98FF3),
    "psychic": solid(0xF95587),
    "bug": solid(0xA6B91A),
    "rock": solid(0xB6A136),
    "ghost": solid(0x735797),
    "dragon": solid(0x6F35FC),
    "dark": solid(0x705746),
    "steel": solid(0xB7B7CE),
    "fairy": solid(0xD685AD),
  ]

  // MARK: Helpers

  /// A color that resolves to `light`/`dark` 0xRRGGBB values per the active
  /// interface style, updating automatically when the user toggles appearance.
  private static func adaptive(light: UInt32, dark: UInt32) -> Color {
    Color(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
          ? UIColor(rgb: dark)
          : UIColor(rgb: light)
      }
    )
  }

  /// A theme-stable color from a 0xRRGGBB value.
  private static func solid(_ rgb: UInt32) -> Color {
    Color(uiColor: UIColor(rgb: rgb))
  }
}

private extension UIColor {
  /// Builds an opaque color from a packed 0xRRGGBB integer.
  convenience init(rgb: UInt32) {
    self.init(
      red: CGFloat((rgb >> 16) & 0xFF) / 255,
      green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255,
      alpha: 1
    )
  }
}
