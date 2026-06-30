import type { SpriteCardProps } from "@/components/types";
import TypeBadge from "@/components/TypeBadge";
import EntityLink from "@/components/artifact/EntityLink";

/**
 * SpriteCard — renders one entry from `subjects[]`: sprite image, display
 * name, optional Dex number, type badges, and a fallback indicator when
 * `is_fallback` is true (pre-Gen-9 data used per BR-1).
 *
 * The sprite and name open the Pokémon's artifact and each type badge opens that
 * type's artifact (B-4, AV-US-1) via `EntityLink` — whose no-op default keeps the
 * card fully renderable in isolation tests with no viewer provider mounted (TD-5).
 *
 * Sprite URL comes directly from the agent payload (PokeAPI CDN). Visual layout
 * deferred to `frontend-design`.
 */
export default function SpriteCard({ subject }: SpriteCardProps) {
  const {
    name,
    dex_number,
    sprite_url,
    types,
    is_fallback,
    source_generation,
  } = subject;

  return (
    <div className="sprite-card" data-testid="sprite-card">
      <EntityLink
        kind="pokemon"
        q={name}
        className="sprite-card__sprite-link"
        testid="sprite-card-sprite-link"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="sprite-card__sprite"
          src={sprite_url}
          alt={name}
          width={96}
          height={96}
        />
      </EntityLink>
      <div className="sprite-card__info">
        <EntityLink
          kind="pokemon"
          q={name}
          className="sprite-card__name-link"
          testid="sprite-card-link"
        >
          <span className="sprite-card__name">
            {name}
            {dex_number != null && (
              <span className="sprite-card__dex"> #{dex_number}</span>
            )}
          </span>
        </EntityLink>
        {is_fallback && (
          <span
            className="sprite-card__fallback-badge"
            title={
              source_generation
                ? `Data from ${source_generation}`
                : "Pre-Gen 9 data"
            }
            data-testid="sprite-card-fallback"
          >
            {source_generation ?? "Fallback"}
          </span>
        )}
        <div className="sprite-card__types">
          {types.map((type) => (
            <EntityLink
              key={type}
              kind="type"
              q={type}
              className="entity-link--type"
            >
              <TypeBadge type={type} />
            </EntityLink>
          ))}
        </div>
      </div>
    </div>
  );
}
