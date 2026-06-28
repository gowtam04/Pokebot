/**
 * Client-side image attachment processing (browser-only — uses Image + canvas).
 *
 * Picked or pasted files are decoded, downscaled to a sane longest edge, and
 * re-encoded to a provider-friendly format BEFORE upload. This is not just a
 * size optimization — it is required for correctness:
 *  - It bounds the payload + per-turn vision-token cost (the tool loop resends
 *    each image on every iteration), and
 *  - It transcodes formats the providers can't read (notably iPhone HEIC) into
 *    WebP/JPEG. A file the browser itself can't decode surfaces as an error.
 *
 * Output is a {@link PendingImage}: the wire fields (`mimeType` + raw-base64
 * `data`) plus a `previewUrl` data URL for the thumbnail.
 */

import type { PendingImage } from "@/components/types";

/** Max images per message (mirrors the server's `MAX_IMAGES`). */
export const MAX_ATTACHMENTS = 4;

/** Longest-edge cap; Anthropic's vision sweet spot, ample for reading a team. */
const MAX_DIM = 1568;

/** Re-encode quality for the lossy formats. */
const ENCODE_QUALITY = 0.85;

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `img-${idSeq}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Load a File into a decoded HTMLImageElement (rejects if undecodable). */
function decodeImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          `Couldn't read "${file.name}". Try a PNG, JPEG, or WebP screenshot.`,
        ),
      );
    };
    img.src = url;
  });
}

/** Compute scaled dimensions that cap the longest edge at MAX_DIM (no upscaling). */
function fit(width: number, height: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_DIM || longest === 0) return { w: width, h: height };
  const scale = MAX_DIM / longest;
  return { w: Math.round(width * scale), h: Math.round(height * scale) };
}

/**
 * Process one file into a {@link PendingImage}: decode → downscale → re-encode
 * to WebP (falling back to JPEG when the canvas can't emit WebP). Rejects if the
 * browser cannot decode the source (e.g. HEIC on a browser without support) or
 * the canvas is unavailable.
 */
export async function fileToPendingImage(file: File): Promise<PendingImage> {
  const img = await decodeImage(file);
  const { w, h } = fit(img.naturalWidth || img.width, img.naturalHeight || img.height);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images right now.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Prefer WebP (crisp on text-heavy team screenshots, small); fall back to JPEG
  // when the canvas ignores the request and returns PNG.
  let dataUrl = canvas.toDataURL("image/webp", ENCODE_QUALITY);
  if (!dataUrl.startsWith("data:image/webp")) {
    dataUrl = canvas.toDataURL("image/jpeg", ENCODE_QUALITY);
  }

  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma); // e.g. "data:image/webp;base64"
  const mimeType = header.slice("data:".length, header.indexOf(";"));
  const data = dataUrl.slice(comma + 1);

  return { id: nextId(), mimeType, data, previewUrl: dataUrl, name: file.name };
}

/**
 * Process a batch of files (e.g. a multi-select or paste), preserving order.
 * Returns the successfully-processed images plus a list of human-readable error
 * messages for the ones that failed — so the caller can attach what worked and
 * surface the rest.
 */
export async function filesToPendingImages(
  files: File[],
): Promise<{ images: PendingImage[]; errors: string[] }> {
  const images: PendingImage[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      images.push(await fileToPendingImage(file));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `Couldn't read "${file.name}".`);
    }
  }
  return { images, errors };
}
