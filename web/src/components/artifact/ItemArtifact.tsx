/**
 * ItemArtifact — an item's effect text, plus its wild-held holders when the
 * index records them.
 */

"use client";

import type { ItemArtifactData } from "@/lib/entity-artifact";

export interface ItemArtifactProps {
  data: ItemArtifactData;
}

export default function ItemArtifact({
  data,
}: ItemArtifactProps): React.JSX.Element {
  return (
    <div className="item-artifact" data-testid="item-artifact">
      <section className="item-artifact__effect">
        <h3 className="artifact-section__title">Effect</h3>
        <p className="artifact-text" data-testid="item-effect">
          {data.effect_full || data.effect_short}
        </p>
      </section>

      {data.held_by_wild && data.held_by_wild.length > 0 && (
        <section className="item-artifact__held">
          <h3 className="artifact-section__title">Held in the wild</h3>
          <ul className="held-list" data-testid="item-held-by">
            {data.held_by_wild.map((h) => (
              <li key={h.pokemon} className="held-list__row">
                <span className="held-list__name">{h.pokemon}</span>
                <span className="held-list__rarity">{h.rarity_percent}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
