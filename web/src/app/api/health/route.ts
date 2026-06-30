/**
 * Liveness probe for the Fly http_service check (fly.toml [[http_service.checks]]).
 *
 * Intentionally does NO database work and imports NOTHING from `@/env` or
 * `@/data`: a transient DB blip must never fail this check, because a failed check
 * restarts the single always-on machine — which would wipe the in-memory guest
 * session store / rate limiter / OTP throttle. Real DB faults are handled
 * gracefully in the request path (the chat route already does this). Build-safe:
 * no env evaluation. For a readiness check that pings the DB, add a SEPARATE route
 * (e.g. /api/health/ready) that is NOT wired into the fly.toml check.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
