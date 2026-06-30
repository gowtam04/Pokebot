import Foundation
import UIKit

/// Pure `UIImage` → validated ``ChatImage`` encoder for the chat vision path
/// (chat-experience.md M-CHAT-US-5; api-design.md "Image caps"; component-design.md
/// "Services layer"). It is the **client-side mirror** of the backend's
/// `@/server/image-upload` guard: it enforces the same caps BEFORE the stream opens
/// so a bad attachment is a fast, local rejection rather than a wasted round-trip.
///
/// What it enforces (and why each matters, mirroring the server):
///  - **Count** ≤ ``maxImages`` — bounds the per-turn token + payload cost.
///  - **Per-image decoded bytes** ≤ ``maxImageBytes`` (~3.75 MiB) — the tool loop
///    re-sends every image on each iteration, so oversized uploads are rejected up
///    front. "Decoded bytes" = the re-encoded file bytes (what base64 decodes to on
///    the server), i.e. the `Data` length here — the same number the server checks.
///  - **Total decoded bytes** ≤ ``maxTotalBytes`` (10 MiB) across the turn.
///  - **Type** — every image is RE-ENCODED to one of the four types every provider
///    accepts (JPEG, or PNG when the source carries alpha). This also transcodes
///    HEIC/other library formats into a supported type, which the server requires
///    (it sniffs magic bytes and rejects anything else, notably HEIC).
///
/// The emitted ``ChatImage/data`` is **RAW base64 with no `data:` prefix** — exactly
/// the wire shape `POST /api/chat` expects.
///
/// Pure + `Sendable`: no I/O, no shared state. The caps are injectable so the cap
/// logic is unit-testable with tiny thresholds; production uses the defaults, which
/// match the server's constants byte-for-byte.
struct ImageEncoder: Sendable {
  /// Max images per turn (matches the server's `MAX_IMAGES`).
  static let defaultMaxImages = 4
  /// Per-image decoded-byte cap (~3.75 MiB; matches `MAX_IMAGE_BYTES`).
  static let defaultMaxImageBytes = 3_932_160
  /// Combined decoded-byte cap across the turn (10 MiB; matches `MAX_TOTAL_IMAGE_BYTES`).
  static let defaultMaxTotalBytes = 10_485_760
  /// JPEG re-encode quality for non-alpha images (a sensible photo default).
  private static let jpegQuality: CGFloat = 0.8

  let maxImages: Int
  let maxImageBytes: Int
  let maxTotalBytes: Int

  init(
    maxImages: Int = ImageEncoder.defaultMaxImages,
    maxImageBytes: Int = ImageEncoder.defaultMaxImageBytes,
    maxTotalBytes: Int = ImageEncoder.defaultMaxTotalBytes
  ) {
    self.maxImages = maxImages
    self.maxImageBytes = maxImageBytes
    self.maxTotalBytes = maxTotalBytes
  }

  /// Re-encodes and validates `images` into wire ``ChatImage``s.
  ///
  /// An empty input is the text-only path → `[]` (no throw). On any cap/type
  /// violation it throws ``OakError/imageRejected(reason:)`` with the specific
  /// ``ImageRejectReason`` so the UI can explain exactly what went wrong.
  func encode(_ images: [UIImage]) throws -> [ChatImage] {
    guard !images.isEmpty else { return [] }
    guard images.count <= maxImages else {
      throw OakError.imageRejected(reason: .tooMany)
    }

    var encoded: [ChatImage] = []
    var total = 0
    for image in images {
      guard let payload = Self.reencode(image) else {
        // Couldn't produce any supported encoding (e.g. an empty/invalid image).
        throw OakError.imageRejected(reason: .unsupportedType)
      }
      guard payload.bytes.count <= maxImageBytes else {
        throw OakError.imageRejected(reason: .perImageTooLarge)
      }
      total += payload.bytes.count
      guard total <= maxTotalBytes else {
        throw OakError.imageRejected(reason: .totalTooLarge)
      }
      // RAW base64, no `data:` prefix — the wire shape the server expects.
      encoded.append(
        ChatImage(mimeType: payload.mimeType, data: payload.bytes.base64EncodedString())
      )
    }
    return encoded
  }

  // MARK: Re-encoding

  /// Re-encodes a `UIImage` into a supported type: PNG when it carries alpha (to
  /// preserve transparency), otherwise JPEG. Returns `nil` when no encoding can be
  /// produced (an empty/backing-less image), which the caller maps to
  /// ``ImageRejectReason/unsupportedType``.
  private static func reencode(_ image: UIImage) -> (mimeType: String, bytes: Data)? {
    if hasAlpha(image), let png = image.pngData() {
      return ("image/png", png)
    }
    if let jpeg = image.jpegData(compressionQuality: jpegQuality) {
      return ("image/jpeg", jpeg)
    }
    if let png = image.pngData() {
      return ("image/png", png)
    }
    return nil
  }

  /// Whether the image's underlying bitmap carries an alpha channel.
  private static func hasAlpha(_ image: UIImage) -> Bool {
    guard let alpha = image.cgImage?.alphaInfo else { return false }
    switch alpha {
    case .first, .last, .premultipliedFirst, .premultipliedLast:
      return true
    case .none, .noneSkipFirst, .noneSkipLast, .alphaOnly:
      return false
    @unknown default:
      return false
    }
  }
}
