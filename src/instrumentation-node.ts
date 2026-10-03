/**
 * Node-runtime startup (loaded by instrumentation.ts only when NEXT_RUNTIME is
 * "nodejs").
 *
 * 1. Production env validation — a no-op outside production, so `next dev` and
 *    the test harness are unaffected.
 * 2. Background export recovery: stale RUNNING -> FAILED, PENDING re-queued on the
 *    process-wide runner (the claim makes this idempotent), expired files purged.
 *    Runs in the background — startup never waits on it — and never during
 *    `next build`, which also loads instrumentation but serves nothing.
 */
import { validateProductionEnv } from "@/server/config/env";

export async function registerNode(): Promise<void> {
  validateProductionEnv();
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { recoverExportJobs } = await import("@/server/services/exportJobs");
  setImmediate(() => {
    recoverExportJobs()
      .then((r) => {
        if (r.interrupted || r.requeued || r.purged) console.info(`[exports] startup recovery: ${JSON.stringify(r)}`);
      })
      .catch((e) => console.error("[exports] startup recovery failed:", e));
  });
}
