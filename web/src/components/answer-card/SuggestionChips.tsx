"use client";

import type { SuggestionChipsProps } from "@/components/types";

/**
 * SuggestionChips — clickable chips rendered from `suggestions[]` when
 * `status` is `clarification_needed` or `resolution_failed` (BR-9, AC-1.3).
 *
 * Clicking a chip calls `onSelect(suggestion)` which the parent translates into
 * a normal follow-up POST with the suggestion text as the new user message
 * (ux-design.md UI → Agent Input Map).
 *
 * Returns null when `suggestions` is empty.
 * Visual styling (chip shape, hover, status-specific label) deferred to
 * `frontend-design`.
 */
export default function SuggestionChips({
  suggestions,
  status,
  onSelect,
  disabled = false,
}: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;

  const label =
    status === "resolution_failed" ? "Did you mean:" : "Suggestions:";

  return (
    <div className="suggestion-chips" data-testid="suggestion-chips">
      <span
        className="suggestion-chips__label"
        data-testid="suggestion-chips-label"
      >
        {label}
      </span>
      <div className="suggestion-chips__list">
        {suggestions.map((suggestion, i) => (
          <button
            key={i}
            type="button"
            className="suggestion-chips__chip"
            onClick={() => onSelect(suggestion)}
            disabled={disabled}
            data-testid={`suggestion-chip-${i}`}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
