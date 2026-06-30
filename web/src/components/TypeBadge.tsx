import type { TypeBadgeProps } from "@/components/types";

/**
 * TypeBadge — renders a single Pokémon type as a labeled badge.
 *
 * Visual polish (the 18-type color palette) is deferred to the
 * `frontend-design` skill. Structure only here.
 */
export default function TypeBadge({ type }: TypeBadgeProps) {
  return (
    <span
      className={`type-badge type-badge--${type}`}
      data-testid={`type-badge-${type}`}
    >
      {type}
    </span>
  );
}
