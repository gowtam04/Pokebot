"use client";

import { useState } from "react";

export interface SpriteImgProps {
  /** Primary sprite URL (for a form, the Showdown `ani/<spriteid>.gif`). */
  src: string;
  /**
   * Shown if `src` fails to load — typically the base-species PokeAPI art by
   * national dex number. Lets an alternate form degrade to base art (the
   * pre-fix behaviour) instead of a broken image when a Showdown sprite is
   * missing. Omit it to leave a failed `src` as-is.
   */
  fallbackSrc?: string;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
}

/**
 * `<img>` that swaps to `fallbackSrc` the first time `src` fails to load.
 *
 * The error is tracked per-`src` (not a bare boolean) so that a later prop
 * change to a fresh, working `src` isn't stuck on the previous fallback; and
 * because we only swap while the errored value still equals `src`, a fallback
 * that also 404s can't loop.
 */
export default function SpriteImg({
  src,
  fallbackSrc,
  alt,
  className,
  width,
  height,
}: SpriteImgProps) {
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const useFallback = fallbackSrc != null && erroredSrc === src;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={useFallback ? fallbackSrc : src}
      alt={alt}
      className={className}
      width={width}
      height={height}
      onError={() => {
        if (fallbackSrc != null && fallbackSrc !== src) setErroredSrc(src);
      }}
    />
  );
}
