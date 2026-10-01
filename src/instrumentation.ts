/**
 * Next.js instrumentation: runs once when the server process starts (before any
 * request is served). We use it to validate production configuration up front so
 * a misconfigured deployment fails to boot instead of serving insecure defaults.
 *
 * The validator is a no-op outside production, so `next dev` and the test harness
 * are unaffected.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // env validation only applies to the Node server runtime
  const { validateProductionEnv } = await import("@/server/config/env");
  validateProductionEnv();
}
