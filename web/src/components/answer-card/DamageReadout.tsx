import type { DamageReadoutProps } from "@/components/types";

/**
 * DamageReadout — renders `damage_calc`: the computed value(s), every assumption
 * used, the worked breakdown, and a prominent "Estimate" tag (BR-6, US-9).
 *
 * `is_estimate` is always `true` per the schema; the tag is always shown.
 * `breakdown` is optional in the schema but always shown when present.
 *
 * Assumptions are expandable via a `<details>` element to avoid visual clutter.
 * Visual styling deferred to `frontend-design`.
 */
export default function DamageReadout({ damageCalc }: DamageReadoutProps) {
  const { assumptions, result, breakdown } = damageCalc;

  return (
    <div className="damage-readout" data-testid="damage-readout">
      <span
        className="damage-readout__estimate-tag"
        data-testid="damage-estimate-tag"
      >
        Estimate
      </span>

      <div className="damage-readout__result" data-testid="damage-result">
        {Object.entries(result).map(([k, v]) => (
          <span key={k} className="damage-readout__result-item">
            <span className="damage-readout__result-key">{k}</span>
            {": "}
            <strong className="damage-readout__result-value">
              {String(v)}
            </strong>
          </span>
        ))}
      </div>

      {breakdown && (
        <pre
          className="damage-readout__breakdown"
          data-testid="damage-breakdown"
        >
          {breakdown}
        </pre>
      )}

      <details
        className="damage-readout__assumptions"
        data-testid="damage-assumptions"
      >
        <summary className="damage-readout__assumptions-summary">
          Assumptions
        </summary>
        <ul className="damage-readout__assumptions-list">
          {Object.entries(assumptions).map(([k, v]) => (
            <li key={k} className="damage-readout__assumption-item">
              <span className="damage-readout__assumption-key">{k}</span>
              {": "}
              <span className="damage-readout__assumption-value">
                {String(v)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
