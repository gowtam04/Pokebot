"use client";

/**
 * ChampionsToggle — a controlled switch that scopes the chat to Pokémon
 * Champions.
 *
 * Modeled on `ThemeToggle` (lives in the header band, translucent-white look)
 * but STATELESS: the parent (`page.tsx`) owns the on/off boolean and its
 * localStorage persistence. This component only renders the switch and reports
 * intent via `onChange(!checked)`.
 *
 * Styling is inline (rather than a `globals.css` class like `.theme-toggle`)
 * so the whole control is self-contained; it reuses the same design tokens as
 * the header so it sits cleanly beside the theme toggle.
 */
type ChampionsToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
};

export default function ChampionsToggle({
  checked,
  onChange,
}: ChampionsToggleProps) {
  const label = checked
    ? "Champions mode on — answers are scoped to Pokémon Champions"
    : "Champions mode off — answers use Generation 9";

  return (
    <button
      type="button"
      role="switch"
      className="champions-toggle"
      aria-checked={checked}
      aria-pressed={checked}
      aria-label={label}
      title={label}
      data-testid="champions-toggle"
      onClick={() => onChange(!checked)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "40px",
        paddingInline: "var(--space-3)",
        borderRadius: "var(--radius-pill)",
        border: "1px solid rgba(255, 255, 255, 0.45)",
        background: checked
          ? "rgba(255, 255, 255, 0.32)"
          : "rgba(255, 255, 255, 0.16)",
        color: "var(--neutral-0)",
        font: "inherit",
        fontSize: "14px",
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: "background var(--motion-fast)",
      }}
    >
      <span>Champions</span>
      {/* The switch track + sliding thumb (purely decorative; state is on
          the button via role/aria above). */}
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          display: "inline-block",
          width: "34px",
          height: "20px",
          flexShrink: 0,
          borderRadius: "var(--radius-pill)",
          background: checked
            ? "var(--neutral-0)"
            : "rgba(255, 255, 255, 0.3)",
          transition: "background var(--motion-fast)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "16px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "var(--radius-pill)",
            background: checked ? "var(--poke-red)" : "var(--neutral-0)",
            transition: "left var(--motion-fast), background var(--motion-fast)",
          }}
        />
      </span>
    </button>
  );
}
