/**
 * Readiness: should this instance receive traffic? 200 when the database
 * answers and has this build's migrations and the process is not shutting
 * down; otherwise 503 with coarse states only (see server/ops/readiness.ts).
 * Load balancers route on THIS probe; it never restarts the process.
 */
import { readiness } from "@/server/ops/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await readiness();
  return Response.json({ ok: r.ready, status: r.status, checks: r.checks }, { status: r.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
