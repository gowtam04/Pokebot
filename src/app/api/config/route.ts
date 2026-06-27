/**
 * `GET /api/config` — public, client-safe server configuration.
 *
 * Currently exposes ONLY which model-switcher providers are configured on this
 * server (i.e. their API key is present), so the frontend can disable the models
 * it can't actually use instead of letting the user pick one and hit a 503. No
 * secrets are returned — just the list of usable {@link ModelKey}s.
 *
 * `nodejs` + `force-dynamic`: the factory's `isModelConfigured` reads `@/env`
 * (server-only, validated at use), so this must not be statically optimized; the
 * factory is dynamically imported to defer that env evaluation to request time
 * (the same reason the chat route defers its runtime import).
 */

import { MODELS, type ModelKey } from "@/agent/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { isModelConfigured } = await import("@/agent/providers/factory");
  const configuredModels: ModelKey[] = MODELS.filter((m) =>
    isModelConfigured(m.key),
  ).map((m) => m.key);
  return Response.json({ configuredModels });
}
