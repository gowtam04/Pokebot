import type { CaveatStripProps } from "@/components/types";

/**
 * CaveatStrip — prominent banner combining `uncertainty_flags[]` and the
 * generation-fallback signal (`generation_basis.fallback` + its note).
 *
 * Renders nothing when there are no uncertainty flags and
 * `generationBasis.fallback === false`.
 *
 * Covers: BR-1 (generation fallback), US-13 (uncertainty surfacing).
 * Visual styling deferred to `frontend-design`.
 */
export default function CaveatStrip({
  uncertaintyFlags,
  generationBasis,
}: CaveatStripProps) {
  const hasFallback = generationBasis.fallback;
  const hasFlags = uncertaintyFlags.length > 0;

  if (!hasFallback && !hasFlags) return null;

  return (
    <div className="caveat-strip" data-testid="caveat-strip">
      {hasFallback && (
        <div className="caveat-strip__fallback" data-testid="caveat-fallback">
          {generationBasis.note ??
            `Based on ${generationBasis.generation} data — this Pokémon is not in Gen 9.`}
        </div>
      )}
      {uncertaintyFlags.map((flag, i) => (
        <div
          key={i}
          className="caveat-strip__flag"
          data-testid={`caveat-flag-${i}`}
        >
          {flag}
        </div>
      ))}
    </div>
  );
}
