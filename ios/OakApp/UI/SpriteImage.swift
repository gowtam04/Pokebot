import SwiftUI

/// A Pokémon sprite loaded from a remote URL, with loading, failure, and
/// missing-URL states.
///
/// Sprite art arrives from the backend as absolute URLs on the answer payload
/// (`Subject.spriteUrl`, `CandidateRow.spriteUrl`, `PokemonArtifactData.spriteUrl`)
/// — Oak serves alternate forms their own Showdown-CDN sprites, so these are small
/// pixel-art images. This wraps `AsyncImage` so the answer card can drop sprites
/// inline with a graceful placeholder while loading and a calm fallback when a URL
/// is absent or the fetch fails (M-AC-1.4).
///
/// Caching: relies on `URLSession.shared`'s default `URLCache` — sprite payloads
/// are tiny and the system disk/memory cache is sufficient; no bespoke cache layer.
///
/// Accessibility: the view is a single element labeled with the entity name, so
/// VoiceOver announces the subject ("Garchomp") even when only the placeholder is
/// showing — the picture is never the sole carrier of meaning (M-AC-UI9.3). The
/// frame scales with Dynamic Type via `@ScaledMetric` so it grows alongside
/// surrounding text instead of clipping (M-UI-US-9).
struct SpriteImage: View {
  /// The sprite art URL; `nil` (e.g. an absent `sprite_url`) renders the placeholder.
  let url: URL?
  /// The entity name, used verbatim as the VoiceOver accessibility label.
  let name: String

  /// The square render edge in points, scaled with the user's Dynamic Type setting.
  @ScaledMetric private var edge: CGFloat

  /// - Parameters:
  ///   - url: The sprite URL, or `nil` to show the placeholder.
  ///   - name: The entity name for the accessibility label.
  ///   - size: The base square edge in points (scaled with Dynamic Type).
  init(url: URL?, name: String, size: CGFloat = 56) {
    self.url = url
    self.name = name
    self._edge = ScaledMetric(wrappedValue: size)
  }

  var body: some View {
    Group {
      if let url {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image
              .interpolation(.none)  // keep pixel-art crisp when upscaled
              .resizable()
              .scaledToFit()
          case .failure:
            placeholder
          case .empty:
            ProgressView()
          @unknown default:
            placeholder
          }
        }
      } else {
        placeholder
      }
    }
    .frame(width: edge, height: edge)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(name))
    .accessibilityAddTraits(.isImage)
  }

  /// The no-image surface — a rounded tile carrying an SF Symbol so the empty state
  /// reads as "image unavailable" rather than a blank gap.
  private var placeholder: some View {
    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
      .fill(Theme.surface)
      .overlay {
        Image(systemName: "photo")
          .font(.system(size: edge * 0.4))
          .foregroundStyle(Theme.textMuted)
      }
  }
}

extension SpriteImage {
  /// Convenience for the common case where the sprite URL arrives as a wire
  /// `String` (optional, since `CandidateRow.spriteUrl` may be absent). An empty,
  /// whitespace-only, or malformed string maps to the placeholder.
  init(urlString: String?, name: String, size: CGFloat = 56) {
    let url =
      urlString
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : URL(string: $0) }
    self.init(url: url, name: name, size: size)
  }
}

#Preview {
  HStack(spacing: 16) {
    SpriteImage(
      url: URL(string: "https://example.com/missing.png"),
      name: "Garchomp"
    )
    SpriteImage(url: nil, name: "Unknown")
    SpriteImage(urlString: "  ", name: "Empty string", size: 40)
  }
  .padding()
}
