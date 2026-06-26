"use client";

import { useState, type FormEvent } from "react";
import type { ComposerProps } from "@/components/types";

/**
 * Composer — the chat input box. Submits a trimmed, non-empty message via
 * `onSend` and clears the field. Disabled (input + button) while a turn is
 * streaming so only one turn is ever in flight. Visual styling deferred to the
 * `frontend-design` skill.
 */
export default function Composer({ onSend, disabled = false }: ComposerProps) {
  const [value, setValue] = useState("");

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
          className="composer__input"
          data-testid="composer-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask a Pokémon question…"
          aria-label="Ask a Pokémon question"
          disabled={disabled}
        />
        <button
          className="composer__send"
          data-testid="composer-send"
          type="submit"
          disabled={disabled || value.trim().length === 0}
        >
          Send
        </button>
      </div>
    </form>
  );
}
