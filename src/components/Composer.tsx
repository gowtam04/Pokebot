"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ComposerProps } from "@/components/types";

/**
 * Composer — the chat input box. Submits a trimmed, non-empty message via
 * `onSend` and clears the field. While a turn is streaming the input is disabled
 * and the Send button is swapped for a Stop button (`onStop`) so the user can
 * abort the running request. A new `prefill` object reloads the input (used to
 * restore a stopped message). Visual styling deferred to the `frontend-design`
 * skill.
 */
export default function Composer({
  onSend,
  disabled = false,
  streaming = false,
  onStop,
  prefill = null,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reload the input whenever the parent pushes a fresh `prefill` object (e.g.
  // restoring the message after a quick Stop). Keyed on object identity so the
  // same text can be re-applied across separate stops.
  useEffect(() => {
    if (prefill) setValue(prefill.text);
  }, [prefill]);

  // Keep the dock above the iOS on-screen keyboard. iOS does NOT shrink the
  // layout viewport (or dvh/svh) when the keyboard opens, so a `bottom:0` sticky
  // dock ends up hidden behind it. We measure the occluded height via
  // visualViewport and expose it as --kb-inset; the .composer rule translates
  // up by that amount. The whole thing is a no-op on desktop (no visualViewport
  // resize → inset stays 0 → identity transform).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
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

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form className="composer" data-testid="composer" onSubmit={handleSubmit}>
      <div className="composer__field">
        <span className="composer__leading" aria-hidden="true" />
        <input
          ref={inputRef}
          className="composer__input"
          data-testid="composer-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
            disabled={disabled || value.trim().length === 0}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
