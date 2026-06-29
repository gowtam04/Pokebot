"use client";

import { useState } from "react";
import type { SourceListProps } from "@/components/types";
import EntityLink from "@/components/artifact/EntityLink";
import { parseCitationSource } from "@/components/artifact/parse-citation";

/**
 * SourceList — collapsible "Sources" section rendering `citations[]`.
 *
 * Each citation shows the source resource key, the specific datum used, and an
 * optional link to the canonical PokeAPI endpoint (BR-4). When the source parses
 * to a known entity (`<kind>/<slug>`) it opens that entity's artifact on click
 * (B-4, AV-US-3); the external `↗` link is retained alongside (AV-3.2).
 *
 * Visual styling (icon, indent, link treatment) deferred to `frontend-design`.
 */
export default function SourceList({
  citations,
  defaultExpanded = false,
}: SourceListProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    setExpanded((e.target as HTMLDetailsElement).open);
  }

  return (
    <details
      className="source-list"
      open={expanded}
      onToggle={handleToggle}
      data-testid="source-list"
    >
      <summary
        className="source-list__summary"
        data-testid="source-list-summary"
      >
        Sources ({citations.length})
      </summary>
      <ul className="source-list__list" data-testid="source-list-items">
        {citations.map((citation, i) => {
          const parsed = parseCitationSource(citation.source);
          return (
            <li
              key={i}
              className="source-list__item"
              data-testid={`citation-${i}`}
            >
              {parsed ? (
                <EntityLink
                  kind={parsed.kind}
                  q={parsed.q}
                  className="source-list__source-link"
                  testid={`citation-entity-${i}`}
                >
                  {citation.source}
                </EntityLink>
              ) : (
                <span className="source-list__source">{citation.source}</span>
              )}
              <span className="source-list__detail"> — {citation.detail}</span>
              {citation.endpoint_url && (
                <a
                  href={citation.endpoint_url}
                  className="source-list__link"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`citation-link-${i}`}
                >
                  {" "}
                  ↗
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
