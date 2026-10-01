/**
 * Liveness + readiness probe for load balancers / orchestrators. Unauthenticated
 * by design (middleware leaves /api/health open), so it reveals nothing but
 * "up" / "down": no version, configuration or error details.
 */
import { prisma } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, db: "up", latencyMs: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[health] database check failed:", e);
    return Response.json({ ok: false, db: "down" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
