"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { ComposerProps, PendingImage } from "@/components/types";
import {
  filesToPendingImages,
  MAX_ATTACHMENTS,
} from "@/lib/image-attachments";

/** Max auto-grow height (px) for the textarea before it starts scrolling. */
const MAX_INPUT_PX = 160;

/**
 * Composer — the chat input box. Submits via `onSend(message, images)` and clears
 * the field. A message is sendable when it has non-empty text OR at least one
 * attached image (an image-only "what is this?" upload). Images are picked (the
 * attach button) or pasted, downscaled + re-encoded client-side, shown as
 * removable thumbnails, and capped at {@link MAX_ATTACHMENTS}. While a turn is
 * streaming the input is disabled and Send becomes Stop (`onStop`). A new
 * `prefill` object reloads the text input (used to restore a stopped message).
 *
 * The field is a multi-line textarea that auto-grows up to {@link MAX_INPUT_PX}.
 * Enter submits and Shift+Enter inserts a newline on desktop; on touch devices
 * (coarse pointer) Enter always inserts a newline and Send is the only submit.
 */
export default function Composer({
  onSend,
  disabled = false,
  streaming = false,
  onStop,
  prefill = null,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reload the input whenever the parent pushes a fresh `prefill` object (e.g.
  // restoring the message after a quick Stop). Keyed on object identity so the
  // same text can be re-applied across separate stops.
  useEffect(() => {
    if (prefill) setValue(prefill.text);
  }, [prefill]);

  // Auto-grow the textarea to fit its content, capped at MAX_INPUT_PX (past
  // which it scrolls). Runs on every value change so typing, prefill, and the
  // post-send reset all re-measure. Collapsing to "auto" first lets it shrink
  // back down when text is deleted. A CSS min-height floors the single-line
  // case (and keeps jsdom, where scrollHeight is 0, at its resting height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
  }, [value]);

  // Keep the dock above the iOS on-screen keyboard. iOS does NOT shrink the
  // layout viewport (or dvh/svh) when the keyboard opens, so a `bottom:0` sticky
  // dock ends up hidden behind it. We measure the occluded height via
  // visualViewport and expose it as --kb-inset; the .composer rule translates
  // up by that amount. The whole thing is a no-op on desktop (no visualViewport
  // resize → inset stays 0 → identity transform).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    // Touch only. On desktop, trackpad pinch-zoom shrinks visualViewport too, so
    // running this there would set --kb-inset > 0 and shove the sticky dock
    // off-screen. Gating on a coarse pointer keeps desktop fully inert.
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    const update = () => {
      const occluded = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      );
      root.style.setProperty("--kb-inset", `${occluded}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb-inset");
    };
  }, []);

  // Decode + downscale picked/pasted files, capping the total at MAX_ATTACHMENTS
  // and surfacing any per-file decode failures (e.g. an unsupported HEIC).
  async function addFiles(files: File[]) {
    if (files.length === 0 || disabled) return;
    setAttachError(null);
    const room = Math.max(0, MAX_ATTACHMENTS - pendingImages.length);
    const accepted = files.slice(0, room);
    const overflow = files.length - accepted.length;
    const { images, errors } = await filesToPendingImages(accepted);
    if (images.length > 0) {
      setPendingImages((prev) =>
        [...prev, ...images].slice(0, MAX_ATTACHMENTS),
      );
    }
    const msgs = [...errors];
    if (overflow > 0)
      msgs.push(`You can attach up to ${MAX_ATTACHMENTS} images.`);
    if (msgs.length > 0) setAttachError(msgs.join(" "));
  }

  function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    void addFiles(files);
    e.target.value = ""; // allow re-selecting the same file
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // don't also paste the image's name as text
      void addFiles(files);
    }
  }

  function removeImage(id: string) {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
    setAttachError(null);
  }

  function submit() {
    if (disabled) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && pendingImages.length === 0) return;
    onSend(trimmed, pendingImages);
    setValue("");
    setPendingImages([]);
    setAttachError(null);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    // Shift+Enter always inserts a newline (the textarea default).
    if (e.shiftKey) return;
    // Don't submit mid-IME-composition (e.g. an unconfirmed CJK candidate);
    // the Enter is committing the candidate, not the message.
    if (e.nativeEvent.isComposing) return;
    // On touch devices the on-screen return key inserts a newline; Send is the
    // only way to submit. On desktop, a bare Enter sends.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    e.preventDefault();
    submit();
  }

  const atCapacity = pendingImages.length >= MAX_ATTACHMENTS;
  const nothingToSend = value.trim().length === 0 && pendingImages.length === 0;

  return (
    <form className="composer" data-testid="composer" onSubmit={handleSubmit}>
      {pendingImages.length > 0 && (
        <div
          className="composer__attachments"
          data-testid="composer-attachments"
        >
          {pendingImages.map((img) => (
            <div key={img.id} className="composer__thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="composer__thumb-img"
                src={img.previewUrl}
                alt={img.name}
              />
              <button
                type="button"
                className="composer__thumb-remove"
                onClick={() => removeImage(img.id)}
                aria-label={`Remove ${img.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && (
        <div className="composer__attach-error" role="alert">
          {attachError}
        </div>
      )}
      <div className="composer__field">
        <button
          className="composer__attach"
          data-testid="composer-attach"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || atCapacity}
          aria-label="Attach an image"
          title={
            atCapacity
              ? `Up to ${MAX_ATTACHMENTS} images`
              : "Attach an image"
          }
        />
        <input
          ref={fileInputRef}
          className="composer__file-input"
          data-testid="composer-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/*"
          multiple
          hidden
          onChange={handleFiles}
        />
        <textarea
          ref={inputRef}
          className="composer__input"
          data-testid="composer-input"
          rows={1}
          enterKeyHint="enter"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => {
            // Fallback for browsers without visualViewport handling: nudge the
            // field into view once the keyboard has had a moment to open.
            setTimeout(
              () => inputRef.current?.scrollIntoView?.({ block: "center" }),
              100,
            );
          }}
          placeholder="Ask a Pokémon question…"
          aria-label="Ask a Pokémon question"
          disabled={disabled}
        />
        {streaming ? (
          <button
            className="composer__stop"
            data-testid="composer-stop"
            type="button"
            onClick={onStop}
            aria-label="Stop the current response"
          >
            Stop
          </button>
        ) : (
          <button
            className="composer__send"
            data-testid="composer-send"
            type="submit"
            disabled={disabled || nothingToSend}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
