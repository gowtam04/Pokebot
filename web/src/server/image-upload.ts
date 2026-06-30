/**
 * Image-upload validation for `POST /api/chat` (the vision input path).
 *
 * A pure, side-effect-free guard — the image analogue of `rate-limit.ts`'s
 * `checkRateLimit`. The route calls this BEFORE opening the SSE stream so a bad
 * attachment is a real HTTP status (400/413), not a mid-stream error.
 *
 * What it enforces, and WHY each matters:
 *  - **Count** ≤ {@link MAX_IMAGES}: bounds the per-turn token + payload cost.
 *  - **Real image, by MAGIC BYTES** — not the client's declared MIME. The sniffed
 *    type becomes the canonical {@link ImageAttachment.mimeType} we forward,
 *    because Anthropic 400s if `media_type` disagrees with the actual bytes, and a
 *    client could mislabel anything. Only the four types every provider accepts
 *    (jpeg/png/gif/webp) pass — notably HEIC does NOT, so the client must
 *    transcode before upload.
 *  - **Decoded-byte caps** (per-image + total): the real cost is the decoded
 *    image, and the tool loop RESENDS it on every iteration, so oversized uploads
 *    are rejected up front.
 *
 * The canonical `data` we return is RE-ENCODED from the decoded bytes, so it is
 * always clean standard base64 (no `data:` prefix, no stray whitespace/newlines)
 * regardless of how the client framed it — the providers can append it to a
 * `data:` URL or hand it to Anthropic raw without further massaging.
 */

import type { ImageAttachment } from "@/agent/types";

/** Max images per message (matches the client-side attach cap). */
export const MAX_IMAGES = 4;
/** Per-image decoded-byte cap (~3.75 MiB). */
export const MAX_IMAGE_BYTES = 3_932_160;
/** Combined decoded-byte cap across all images in a message (10 MiB). */
export const MAX_TOTAL_IMAGE_BYTES = 10_485_760;

/** The four image types every selectable provider (Anthropic/OpenAI/xAI) accepts. */
type SupportedMime = ImageAttachment["mimeType"];

export type ImageValidationResult =
  | { ok: true; images: ImageAttachment[] }
  | { ok: false; status: 400 | 413; code: string; message: string };

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const INVALID: ImageValidationResult = {
  ok: false,
  status: 400,
  code: "invalid_image",
  message:
    "An attached image isn't a supported file. Use a PNG, JPEG, GIF, or WebP.",
};

/** Identify the image type from its leading bytes; `null` if unrecognized. */
function sniffMime(buf: Buffer): SupportedMime | null {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Decode the client `data` (raw base64, or a `data:` URL we tolerate) → bytes. */
function decodeBase64(data: string): Buffer | null {
  // Tolerate a `data:<mime>;base64,<payload>` URL by keeping only the payload.
  const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
  const b64 = (comma >= 0 ? data.slice(comma + 1) : data).replace(/\s/g, "");
  if (b64.length === 0) return null;
  // Reject anything that isn't well-formed base64 (Buffer.from silently drops
  // invalid chars, which would mask garbage as a "decodable" blob).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Validate the request body's `images` field. `undefined`/`null`/`[]` is the
 * text-only path (returns an empty list). On success returns the canonical,
 * mime-sniffed, re-encoded attachments to bind onto the agent context.
 */
export function validateImages(input: unknown): ImageValidationResult {
  if (input === undefined || input === null) return { ok: true, images: [] };
  if (!Array.isArray(input)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_image",
      message: "`images` must be an array of attachments.",
    };
  }
  if (input.length === 0) return { ok: true, images: [] };
  if (input.length > MAX_IMAGES) {
    return {
      ok: false,
      status: 400,
      code: "too_many_images",
      message: `At most ${MAX_IMAGES} images can be attached to one message (got ${input.length}).`,
    };
  }

  const images: ImageAttachment[] = [];
  let total = 0;
  for (const item of input) {
    const data = (item as { data?: unknown } | null)?.data;
    if (typeof data !== "string") return INVALID;
    const buf = decodeBase64(data);
    if (!buf) return INVALID;
    const mimeType = sniffMime(buf);
    if (!mimeType) return INVALID;
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "image_too_large",
        message: `Each image must be ${mib(MAX_IMAGE_BYTES)} or smaller (one is ${mib(buf.length)}).`,
      };
    }
    total += buf.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "image_too_large",
        message: `Attached images total more than the ${mib(MAX_TOTAL_IMAGE_BYTES)} limit.`,
      };
    }
    images.push({ mimeType, data: buf.toString("base64") });
  }
  return { ok: true, images };
}
