/**
 * RosterStrip — the 6-slot team roster shown above the focused member editor.
 *
 * Each slot is a sprite chip (species sprite + name + type dots) the user clicks
 * to focus that member in the editor below; an empty member renders a neutral
 * "Empty" chip, and a trailing dashed "+ Add" tile appends a new blank slot
 * (until the team is full at six). Sprites/types come from the page's batch
 * `resolveSprites` lookup; an unknown species falls back to a Showdown sprite by
 * slug, then to a pokéball glyph. Pure presentational — selection, add, and the
 * member array all live in {@link TeamEditor}.
 */

"use client";

import type { TeamMember } from "@/data/teams/team-schema";
import type { SpriteRef } from "@/lib/api/sprites-client";
import { showdownAniSprite, showdownSpriteId } from "@/lib/sprites";
import { titleizeSlug } from "./display-names";

export interface RosterStripProps {
  members: TeamMember[];
  selectedSlot: number;
  spriteBySpecies: Record<string, SpriteRef | undefined>;
  onSelect: (index: number) => void;
  onAdd: () => void;
}

export default function RosterStrip({
  members,
  selectedSlot,
  spriteBySpecies,
  onSelect,
  onAdd,
}: RosterStripProps) {
  return (
    <div className="roster-strip" data-testid="roster-strip" role="tablist" aria-label="Team roster">
      {members.map((member, i) => {
        const species = member.species;
        const ref = species ? spriteBySpecies[species] : undefined;
        const spriteUrl =
          ref?.sprite_url ??
          (species
            ? showdownAniSprite(showdownSpriteId(species, null))
            : null);
        const types = ref?.types ?? [];
        const selected = i === selectedSlot;
        return (
          <button
            type="button"
            key={i}
            role="tab"
            aria-selected={selected}
            data-testid={`roster-slot-${i}`}
            data-selected={selected ? "true" : "false"}
            data-empty={species ? "false" : "true"}
            className="roster-slot"
            onClick={() => onSelect(i)}
          >
            <span className="roster-slot__index">{i + 1}</span>
            <span className="roster-slot__sprite">
              {spriteUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={spriteUrl} alt="" aria-hidden loading="lazy" />
              ) : (
                <span className="roster-slot__sprite-empty" aria-hidden />
              )}
            </span>
            <span className="roster-slot__name">{titleizeSlug(species)}</span>
            {types.length > 0 && (
              <span className="roster-slot__types" aria-hidden>
                {types.map((t) => (
                  <span
                    key={t}
                    className={`roster-slot__type-dot type-badge--${t}`}
                  />
                ))}
              </span>
            )}
          </button>
        );
      })}

      {members.length < 6 && (
        <button
          type="button"
          className="roster-slot roster-slot--add"
          data-testid="team-add-member"
          onClick={onAdd}
        >
          <span className="roster-slot__plus" aria-hidden>
            +
          </span>
          <span className="roster-slot__name">Add Pokémon</span>
        </button>
      )}
    </div>
  );
}
