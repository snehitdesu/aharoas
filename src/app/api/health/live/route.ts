/**
 * Liveness: the process is running and its event loop answers. No database or
 * other I/O, so a slow dependency never gets a healthy process restarted.
 * Orchestrators restart the instance only when THIS fails.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, status: "alive" }, { headers: { "Cache-Control": "no-store" } });
}
