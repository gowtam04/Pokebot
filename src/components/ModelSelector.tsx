"use client";

/**
 * ModelSelector — a controlled dropdown that picks which LLM answers the chat
 * (Claude / GPT-5.5 / Grok 4.3).
 *
 * STATELESS, like `ChampionsToggle`: the parent (`page.tsx`) owns the selected
 * key + its localStorage persistence and just passes `{ value, onChange }`. The
 * options come straight from the shared `MODELS` registry so the dropdown and
 * the server-side whitelist never drift. A native `<select>` is used (3 options)
 * for free keyboard/screen-reader behavior; styling lives in `globals.css`
 * (`.model-selector-pill*`) to match the translucent-white header pills.
 */

import { MODELS, type ModelKey } from "@/agent/models";

type ModelSelectorProps = {
  value: ModelKey;
  onChange: (next: ModelKey) => void;
  /**
   * Which models the SERVER actually has configured (from GET /api/config).
   * Options not in this list are disabled (greyed out) since selecting them would
   * just 503. `undefined` (not yet fetched) means "don't disable anything".
   */
  configuredModels?: ModelKey[];
};

export default function ModelSelector({
  value,
  onChange,
  configuredModels,
}: ModelSelectorProps) {
  const isConfigured = (key: ModelKey): boolean =>
    configuredModels ? configuredModels.includes(key) : true;
  return (
    <label className="model-selector-pill" title="Choose which AI model answers">
      <select
        className="model-selector-pill__select"
        data-testid="model-selector"
        aria-label="Answering model"
        value={value}
        onChange={(e) => onChange(e.target.value as ModelKey)}
      >
        {MODELS.map((m) => {
          const configured = isConfigured(m.key);
          return (
            // Dark text on the native option list (rendered by the OS in its own
            // surface, not the translucent header), so set an explicit color.
            <option
              key={m.key}
              value={m.key}
              disabled={!configured}
              className="model-selector-pill__option"
            >
              {m.label}
              {configured ? "" : " (not configured)"}
            </option>
          );
        })}
      </select>
      {/* Caret — `appearance:none` strips the native one, so without this the
          pill reads as a static label on a phone rather than a tappable picker. */}
      <span aria-hidden="true" className="pill-caret" />
    </label>
  );
}
