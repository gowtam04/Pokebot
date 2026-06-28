/**
 * Unit tests for `validateImages` — the pure image-upload guard. No DB, no
 * network: it operates on decoded bytes. Covers the text-only passthrough, the
 * count cap, magic-byte MIME sniffing (incl. sniffed-overrides-declared), the
 * per-image and total size caps, and base64 rejection.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
  validateImages,
} from "./image-upload";

// --- Minimal real magic-byte headers -------------------------------------
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_HEADER = Buffer.from("GIF89a", "latin1");
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** Build a base64 `data` string from a header + `pad` filler bytes. */
function b64(header: Buffer, pad = 0): string {
  const buf = pad > 0 ? Buffer.concat([header, Buffer.alloc(pad)]) : header;
  return buf.toString("base64");
}

describe("validateImages — passthrough", () => {
  it("treats undefined / null / [] as a text-only turn", () => {
    for (const input of [undefined, null, []]) {
      const r = validateImages(input);
      expect(r).toEqual({ ok: true, images: [] });
    }
  });

  it("rejects a non-array images field", () => {
    const r = validateImages("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_image");
  });
});

describe("validateImages — MIME sniffing", () => {
  it("sniffs each supported type from its bytes", () => {
    const r = validateImages([
      { mimeType: "x", data: b64(PNG_HEADER, 16) },
      { mimeType: "x", data: b64(JPEG_HEADER, 16) },
      { mimeType: "x", data: b64(GIF_HEADER, 16) },
      { mimeType: "x", data: b64(WEBP_HEADER, 16) },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.images.map((i) => i.mimeType)).toEqual([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ]);
    }
  });

  it("the SNIFFED type wins over the client's declared mimeType", () => {
    // Client lies and says jpeg, but the bytes are PNG.
    const r = validateImages([{ mimeType: "image/jpeg", data: b64(PNG_HEADER, 8) }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images[0].mimeType).toBe("image/png");
  });

  it("rejects an unsupported / unrecognized format (e.g. a text blob)", () => {
    const r = validateImages([
      { mimeType: "image/png", data: Buffer.from("hello world").toString("base64") },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_image");
  });

  it("re-encodes data to clean base64 and tolerates a data: URL prefix", () => {
    const clean = b64(PNG_HEADER, 4);
    const r = validateImages([
      { mimeType: "image/png", data: `data:image/png;base64,${clean}` },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images[0].data).toBe(clean); // prefix stripped, payload intact
  });
});

describe("validateImages — bad input", () => {
  it("rejects an item whose data is not a string", () => {
    const r = validateImages([{ mimeType: "image/png", data: 123 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_image");
  });

  it("rejects malformed base64", () => {
    const r = validateImages([{ mimeType: "image/png", data: "@@@not base64@@@" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_image");
  });
});

describe("validateImages — caps", () => {
  it("rejects more than MAX_IMAGES", () => {
    const one = { mimeType: "image/png", data: b64(PNG_HEADER, 4) };
    const r = validateImages(Array.from({ length: MAX_IMAGES + 1 }, () => one));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("too_many_images");
      expect(r.status).toBe(400);
    }
  });

  it("accepts exactly MAX_IMAGES", () => {
    const one = { mimeType: "image/png", data: b64(PNG_HEADER, 4) };
    const r = validateImages(Array.from({ length: MAX_IMAGES }, () => one));
    expect(r.ok).toBe(true);
  });

  it("rejects a single image over the per-image byte cap (413)", () => {
    const r = validateImages([
      { mimeType: "image/png", data: b64(PNG_HEADER, MAX_IMAGE_BYTES) },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("image_too_large");
      expect(r.status).toBe(413);
    }
  });

  it("rejects when the combined total exceeds the total byte cap (413)", () => {
    // Three images each just under the per-image cap (3 × 3.75 MiB ≈ 11.25 MiB)
    // sum past the 10 MiB total cap.
    const each = MAX_IMAGE_BYTES - 1000;
    expect(each).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(each * 3).toBeGreaterThan(MAX_TOTAL_IMAGE_BYTES);
    const big = { mimeType: "image/png", data: b64(PNG_HEADER, each) };
    const r = validateImages([big, big, big]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("image_too_large");
  });
});
