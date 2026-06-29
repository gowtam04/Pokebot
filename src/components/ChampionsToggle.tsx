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
 * Styling lives in `globals.css` (`.champions-toggle*`) — the on/off look is
 * driven off the `aria-checked` attribute (no inline style branches), so it sits
 * cleanly beside the theme toggle in the header band.
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
    >
      <span>Champions</span>
      {/* The switch track + sliding thumb (purely decorative; state is on the
          button via role/aria-checked, which the CSS reads to drive the look). */}
      <span aria-hidden="true" className="champions-toggle__track">
        <span className="champions-toggle__thumb" />
      </span>
    </button>
  );
}
