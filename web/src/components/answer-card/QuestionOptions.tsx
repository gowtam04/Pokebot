"use client";

import type { QuestionOptionsProps } from "@/components/types";

/**
 * QuestionOptions — the "ask the user" affordance. Rendered when a
 * `clarification_needed` answer carries a structured `question.options` (the
 * agent chose to STOP and ask rather than answer generally).
 *
 * Each option is a stacked, card-style button: the `label` is the user's reply
 * and `description` (optional) is helper text. Clicking calls `onSelect(label)`,
 * which the parent turns into a normal follow-up POST with the label verbatim as
 * the new user message — the same mechanism as SuggestionChips / CandidateTable
 * (ux-design.md UI → Agent Input Map). The always-present Composer covers the
 * free-text path, so no "type your own" button is needed here.
 *
 * Returns null when there are no options.
 */
export default function QuestionOptions({
  options,
  onSelect,
}: QuestionOptionsProps) {
  if (options.length === 0) return null;

  return (
    <div className="question-options" data-testid="question-options">
      {options.map((option, i) => (
        <button
          key={i}
          type="button"
          className="question-options__option"
          onClick={() => onSelect(option.label)}
          data-testid={`question-option-${i}`}
        >
          <span className="question-options__label">{option.label}</span>
          {option.description && (
            <span className="question-options__desc">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}
