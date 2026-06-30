import type { InferenceCalloutProps } from "@/components/types";

/**
 * InferenceCallout — visually distinct callouts for `inferences[]`, clearly
 * separating deductions from stated data (BR-3).
 *
 * Each callout shows the confidence level, the claim, and an optional note on
 * what the inference hinges on.  Returns null when `inferences` is empty.
 *
 * Visual styling (icon, colour-coding per confidence level) deferred to
 * `frontend-design`.
 */
export default function InferenceCallout({
  inferences,
}: InferenceCalloutProps) {
  if (inferences.length === 0) return null;

  return (
    <div className="inference-callout" data-testid="inference-callout">
      {inferences.map((inference, i) => (
        <div
          key={i}
          className={`inference-callout__item inference-callout__item--${inference.confidence}`}
          data-testid={`inference-item-${i}`}
        >
          <span
            className="inference-callout__confidence"
            data-testid={`inference-confidence-${i}`}
          >
            [{inference.confidence}]
          </span>{" "}
          <span className="inference-callout__claim">{inference.claim}</span>
          {inference.note && (
            <span
              className="inference-callout__note"
              data-testid={`inference-note-${i}`}
            >
              {" — "}
              {inference.note}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
