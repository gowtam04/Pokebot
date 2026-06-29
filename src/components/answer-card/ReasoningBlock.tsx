"use client";

import { useState } from "react";
import type { ReasoningBlockProps } from "@/components/types";
import Markdown from "@/components/Markdown";

/**
 * ReasoningBlock — collapsible "why" section driven by `reasoning_markdown`.
 *
 * Collapsed by default (`defaultExpanded={false}`). The `<details>`/`<summary>`
 * HTML elements provide native disclosure behaviour.  Visual styling deferred to
 * `frontend-design`.
 */
export default function ReasoningBlock({
  markdown,
  defaultExpanded = false,
}: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    setExpanded((e.target as HTMLDetailsElement).open);
  }

  return (
    <details
      className="reasoning-block"
      open={expanded}
      onToggle={handleToggle}
      data-testid="reasoning-block"
    >
      <summary className="reasoning-block__summary">Reasoning</summary>
      <div
        className="reasoning-block__content"
        data-testid="reasoning-block-content"
      >
        <Markdown markdown={markdown} />
      </div>
    </details>
  );
}
