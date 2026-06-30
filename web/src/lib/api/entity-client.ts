/**
 * entity-client — the typed `fetch` helper over `GET /api/entity` (B-4, Phase 4).
 *
 * The artifact viewer's only call into the entity-detail read path. Mirrors
 * history-client.ts: it NEVER throws — a transport fault, a non-2xx (e.g. a 400
 * for a malformed param), or a body that fails the shared contract all fold to
 * `null`, which the provider surfaces as the viewer's "couldn't load" state
 * (BR-AV-5, AV-US-11). A 200 `not_found` / `unavailable` envelope is a VALID
 * result (it parses) and is returned as-is for the panel to render.
 */

import {
  entityArtifactResponseSchema,
  type ArtifactFormat,
  type EntityArtifactResponse,
  type EntityKind,
} from "@/lib/entity-artifact";

/**
 * Fetch the full entity-detail artifact for `(kind, q)` in `format`. Returns the
 * validated envelope, or `null` on any transport / HTTP / contract failure.
 */
export async function fetchEntityArtifact(
  kind: EntityKind,
  q: string,
  format: ArtifactFormat,
): Promise<EntityArtifactResponse | null> {
  try {
    const params = new URLSearchParams({ kind, q, format });
    const res = await fetch(`/api/entity?${params.toString()}`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const parsed = entityArtifactResponseSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
