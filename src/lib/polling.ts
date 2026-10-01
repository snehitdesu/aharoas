/**
 * Framework-agnostic poller (used by the KDS; SSE/WebSocket can replace the
 * transport later behind the same onData/onError contract).
 *
 * Guarantees:
 *  - no overlapping requests (the next tick is scheduled after the current one settles);
 *  - stale-response protection (a response from before stop()/refresh() is dropped);
 *  - visibility-aware: pauses while the page is hidden, refreshes on return;
 *  - clean stop (timers cleared, in-flight request aborted).
 */
export type PollerOptions<T> = {
  fetch: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  onData: (data: T) => void;
  onError?: (e: unknown) => void;
  /** Injected for tests; defaults to document.visibilityState. */
  isVisible?: () => boolean;
  /** Injected for tests; defaults to document visibilitychange listeners. */
  onVisibilityChange?: (cb: () => void) => () => void;
};

export type Poller = { start(): void; stop(): void; refresh(): Promise<void>; setInterval(ms: number): void; readonly running: boolean };

export function createPoller<T>(opts: PollerOptions<T>): Poller {
  let interval = opts.intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let inFlight: AbortController | null = null;
  let running = false;
  let unsubscribe: (() => void) | null = null;
  const visible = opts.isVisible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const subscribe =
    opts.onVisibilityChange ??
    ((cb: () => void) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    });

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (running && visible()) timer = setTimeout(() => void tick(), interval);
  };
  async function tick() {
    if (!running || inFlight) return; // never overlap
    const gen = generation;
    const ctrl = new AbortController();
    inFlight = ctrl;
    try {
      const data = await opts.fetch(ctrl.signal);
      if (gen === generation && running) opts.onData(data);
    } catch (e) {
      if (gen === generation && running && (e as { name?: string })?.name !== "AbortError") opts.onError?.(e);
    } finally {
      if (inFlight === ctrl) inFlight = null;
      if (gen === generation) schedule();
    }
  }

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      unsubscribe = subscribe(() => {
        if (visible()) void this.refresh();
        else clear();
      });
      void tick();
    },
    stop() {
      running = false;
      generation++;
      clear();
      inFlight?.abort();
      inFlight = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    async refresh() {
      if (!running) return;
      generation++; // drop any response still in flight
      inFlight?.abort();
      inFlight = null;
      clear();
      await tick();
    },
    setInterval(ms: number) {
      interval = ms;
      if (running) schedule();
    },
  };
}
