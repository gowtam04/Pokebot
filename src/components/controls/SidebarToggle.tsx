"use client";

/**
 * SidebarToggle — collapses/expands the chat-history sidebar.
 *
 * Lives in the header band (signed-in only) and reuses the `.theme-toggle`
 * pill style (globals.css) so it reads as a peer chrome control. Purely
 * presentational: `collapsed` + `onToggle` come from the page, which owns the
 * state and its localStorage persistence. One glyph for both states — only the
 * label flips (mirrors how ThemeToggle keeps a single button).
 */

interface SidebarToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  /** id of the <aside> this controls, for `aria-controls`. */
  controlsId: string;
}

export default function SidebarToggle({
  collapsed,
  onToggle,
  controlsId,
}: SidebarToggleProps) {
  const label = collapsed
    ? "Show conversation history"
    : "Collapse conversation history";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      aria-label={label}
      title={label}
      data-testid="sidebar-toggle"
    >
      <PanelLeftIcon />
    </button>
  );
}

function PanelLeftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={3} y={4} width={18} height={16} rx={2} />
      <path d="M9 4v16" />
    </svg>
  );
}
