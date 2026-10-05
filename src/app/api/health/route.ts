/**
 * Combined probe kept for existing callers (load balancers configured before
 * Phase 9, the desktop launcher, the E2E suite): 200 = process up AND database
 * answers; 503 = database down or the process is shutting down. Unauthenticated
 * by design (middleware leaves /api/health* open), so it reveals nothing but
 * up/down: no version, configuration or error details.
 *
 * Prefer the split probes: /api/health/live (liveness, no I/O) and
 * /api/health/ready (readiness: database + migrations + not draining).
 */
import { checkDatabase } from "@/server/ops/readiness";
import { isDraining } from "@/server/ops/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  const started = Date.now();
  if (isDraining()) return Response.json({ ok: false, db: "unknown", status: "draining" }, { status: 503, headers });
  const db = await checkDatabase();
  if (db === "up") return Response.json({ ok: true, db: "up", latencyMs: Date.now() - started }, { headers });
  return Response.json({ ok: false, db: "down" }, { status: 503, headers });
}
