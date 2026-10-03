/**
 * Next.js instrumentation: runs once when the server process starts (before any
 * request is served). Node-only startup work lives in instrumentation-node.ts:
 * production configuration validation (a misconfigured deployment fails to boot
 * instead of serving insecure defaults) and background export recovery.
 *
 * Next compiles this file for the Node AND Edge runtimes; the import must sit
 * inside this exact `NEXT_RUNTIME === "nodejs"` check so webpack drops it (and its
 * node: built-ins) from the Edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
