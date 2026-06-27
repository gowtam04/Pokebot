"use client";

/**
 * ModelSelector — a controlled dropdown that picks which LLM answers the chat
 * (Claude / GPT-5.5 / Grok 4.3).
 *
 * STATELESS, like `ChampionsToggle`: the parent (`page.tsx`) owns the selected
 * key + its localStorage persistence and just passes `{ value, onChange }`. The
 * options come straight from the shared `MODELS` registry so the dropdown and
 * the server-side whitelist never drift. A native `<select>` is used (3 options)
 * for free keyboard/screen-reader behavior; styling is inline to match the
 * translucent-white header pills it sits beside.
 */

import { MODELS, type ModelKey } from "@/agent/models";

type ModelSelectorProps = {
  value: ModelKey;
  onChange: (next: ModelKey) => void;
};

export default function ModelSelector({ value, onChange }: ModelSelectorProps) {
  return (
    <label
      title="Choose which AI model answers"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "40px",
        paddingInline: "var(--space-3)",
        borderRadius: "var(--radius-pill)",
        border: "1px solid rgba(255, 255, 255, 0.45)",
        background: "rgba(255, 255, 255, 0.16)",
        color: "var(--neutral-0)",
        font: "inherit",
        fontSize: "14px",
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">Model</span>
      <select
        data-testid="model-selector"
        aria-label="Answering model"
        value={value}
        onChange={(e) => onChange(e.target.value as ModelKey)}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          border: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          fontWeight: 600,
          cursor: "pointer",
          paddingInlineEnd: "var(--space-1)",
        }}
      >
        {MODELS.map((m) => (
          // Dark text on the native option list (rendered by the OS in its own
          // surface, not the translucent header), so set an explicit color.
          <option key={m.key} value={m.key} style={{ color: "var(--neutral-900, #111)" }}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
