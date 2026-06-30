/**
 * Typed transport error for the OpenAI-SDK providers — `GrokProvider` (native xAI
 * Responses) and `OpenAICompatibleProvider` (GPT-5.5 Chat Completions).
 *
 * Thrown when the upstream returns a 4xx/5xx (bad/expired key, unsupported
 * parameter, rate limit, unknown model). The chat
 * route recognizes it and renders a MODEL-SCOPED error message — so the user knows
 * to switch models or fix the provider key — instead of the generic
 * "transport error". Kept in its own tiny module (no SDK import) so both the
 * provider and the route can depend on it without an import cycle.
 */
export class ProviderTransportError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly upstreamMessage?: string,
  ) {
    super(
      upstreamMessage ??
        `Provider transport error${status ? ` (HTTP ${status})` : ""}`,
    );
    this.name = "ProviderTransportError";
  }
}
