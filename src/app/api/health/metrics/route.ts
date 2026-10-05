/**
 * Prometheus-format operational metrics for a scraper / monitoring agent.
 *
 * Disabled (404) unless METRICS_TOKEN is configured; then the caller must send
 * `Authorization: Bearer <METRICS_TOKEN>` (constant-time comparison). Metrics
 * are deployment-wide aggregates with fixed label vocabularies: no tenant ids,
 * user data, secrets or error text.
 */
import { renderPrometheus } from "@/server/observability/metrics";
import { metricsAuthorized, operationalGauges } from "@/server/ops/opsStatus";
import { log } from "@/server/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!process.env.METRICS_TOKEN) return Response.json({ ok: false, error: { code: "NotFound", message: "Not found" } }, { status: 404, headers });
  if (!metricsAuthorized(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: { code: "UnauthorizedError", message: "Authentication required" } }, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
  }
  let gauges: Awaited<ReturnType<typeof operationalGauges>> = [];
  try {
    gauges = await operationalGauges();
  } catch (e) {
    // Counters are still useful when the database is down; the gap itself is visible (no gauges).
    log.error("metrics: could not compute operational gauges", { event: "metrics_failed", error: e });
  }
  return new Response(renderPrometheus(gauges), { headers: { ...headers, "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } });
}
