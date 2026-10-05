/**
 * Process lifecycle: readiness phase, in-flight API request tracking and
 * graceful shutdown.
 *
 *   starting -> ready (instrumentation finished startup work)
 *            -> draining (SIGTERM / SIGINT): readiness answers 503 so the load
 *               balancer stops routing here; after SHUTDOWN_DELAY_MS new API
 *               requests are refused with 503 + Retry-After; in-flight API
 *               requests are awaited (bounded by SHUTDOWN_TIMEOUT_MS)
 *            -> shutdown tasks (stop background workers, settle post-commit
 *               side effects, let the export runner finish, disconnect the
 *               database) -> stopped -> Next.js closes the HTTP server and exits.
 *
 * Nothing durable depends on the drain completing: every side effect is a row
 * (PrintJob / IntegrationDelivery / ExportJob / WebhookEvent) that the
 * maintenance worker or the provider's retry recovers after a hard kill. The
 * drain only makes a normal deploy/restart lose nothing in flight.
 */
import { log } from "@/server/observability/log";

export type Phase = "starting" | "ready" | "draining" | "stopped";

type State = { phase: Phase; inFlight: number; refusing: boolean; tasks: { name: string; fn: () => Promise<unknown> }[]; shutdown: Promise<void> | null; signalsInstalled: boolean; startedAt: number };
// Survives dev hot reloads and the separate module graphs Next.js may build for routes vs instrumentation.
const g = globalThis as unknown as { __restoraLifecycle?: State };
const state: State = (g.__restoraLifecycle ??= { phase: "starting", inFlight: 0, refusing: false, tasks: [], shutdown: null, signalsInstalled: false, startedAt: Date.now() });

export const phase = (): Phase => state.phase;
export const inFlight = (): number => state.inFlight;
export const isDraining = (): boolean => state.phase === "draining" || state.phase === "stopped";

export function markReady(): void {
  if (state.phase === "starting") state.phase = "ready";
}

/**
 * Count an API request. Returns a release function, or null when the process
 * is shutting down and the request must be refused (503).
 */
export function beginRequest(): (() => void) | null {
  if (state.refusing) return null;
  state.inFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight--;
  };
}

/** Register work to run (in order) when the process shuts down. */
export function onShutdown(name: string, fn: () => Promise<unknown>): void {
  if (!state.tasks.some((t) => t.name === name)) state.tasks.push({ name, fn });
}

const envMs = (name: string, d: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<"done" | "timeout"> {
  let t: NodeJS.Timeout | undefined;
  const r = await Promise.race([p.then(() => "done" as const), new Promise<"timeout">((res) => (t = setTimeout(() => res("timeout"), ms)))]);
  clearTimeout(t);
  return r;
}

/** Drain and run shutdown tasks once (idempotent). Never throws. */
export function shutdown(reason: string, opts: { delayMs?: number; timeoutMs?: number } = {}): Promise<void> {
  state.shutdown ??= (async () => {
    const delayMs = opts.delayMs ?? envMs("SHUTDOWN_DELAY_MS", 0);
    const timeoutMs = opts.timeoutMs ?? envMs("SHUTDOWN_TIMEOUT_MS", 25_000);
    const t0 = Date.now();
    state.phase = "draining";
    log.info("shutdown started", { event: "shutdown", reason, inFlight: state.inFlight, delayMs, timeoutMs });
    if (delayMs) await sleep(delayMs); // let the load balancer notice readiness = 503
    state.refusing = true;
    const deadline = t0 + delayMs + timeoutMs;
    while (state.inFlight > 0 && Date.now() < deadline) await sleep(25);
    if (state.inFlight > 0) log.warn("shutdown: in-flight requests did not finish in time", { event: "shutdown", inFlight: state.inFlight });
    for (const t of state.tasks) {
      const left = Math.max(1_000, deadline - Date.now());
      try {
        const r = await withDeadline(t.fn(), left);
        if (r === "timeout") log.warn("shutdown task timed out", { event: "shutdown", task: t.name });
      } catch (e) {
        log.error("shutdown task failed", { event: "shutdown", task: t.name, error: e });
      }
    }
    state.phase = "stopped";
    log.info("shutdown complete", { event: "shutdown", durationMs: Date.now() - t0 });
  })();
  return state.shutdown;
}

/**
 * Install SIGTERM / SIGINT handling. Next.js (`next start` / standalone
 * server.js) registers its own handler that closes the HTTP server and exits;
 * we run our drain FIRST and then hand over to it, so in-flight work finishes
 * before the process exits. Without a Next handler (NEXT_MANUAL_SIG_HANDLE)
 * we exit ourselves.
 */
export function installSignalHandlers(): void {
  if (state.signalsInstalled) return;
  state.signalsInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const previous = process.listeners(sig) as ((s: NodeJS.Signals) => void)[];
    for (const l of previous) process.removeListener(sig, l);
    process.on(sig, () => {
      void shutdown(sig).finally(() => {
        if (previous.length) for (const l of previous) l(sig);
        else process.exit(0);
      });
    });
  }
  // Never die silently: record the crash (the process manager restarts us).
  process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", { event: "unhandledRejection", error: reason }));
  process.on("uncaughtExceptionMonitor", (err, origin) => log.fatal("uncaught exception", { event: "uncaughtException", origin, error: err }));
}

/** Tests only. */
export function resetLifecycleForTests(): void {
  state.phase = "starting";
  state.inFlight = 0;
  state.tasks = [];
  state.shutdown = null;
  state.refusing = false;
}
