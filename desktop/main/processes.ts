/**
 * Child processes of the desktop shell. Both run in Electron `utilityProcess`es —
 * Electron's embedded Node — so the installed app needs no separate Node.js:
 *
 *  - DbTool: short-lived, one command at a time (migrate / status / bootstrap / backup / verify).
 *  - AharosServer: the production Next.js standalone server, bound to 127.0.0.1.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import net from "node:net";
import path from "node:path";
import type { Logger } from "./log";

export type ToolError = { name: string; message: string; fieldErrors?: Record<string, string[]> };
export class DbToolError extends Error {
  constructor(readonly detail: ToolError) {
    super(detail.message);
    this.name = detail.name;
  }
}

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: ToolError };

export class DbTool {
  private proc: UtilityProcess;
  private nextId = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  private ready: Promise<void>;
  private exited = false;

  constructor(serverDir: string, env: Record<string, string>, log: Logger) {
    this.proc = utilityProcess.fork(path.join(serverDir, "dbtool.js"), [], { env, cwd: serverDir, stdio: "pipe", serviceName: "Aharos DB tool" });
    this.proc.stdout?.on("data", (d) => log.info(`[dbtool] ${String(d).trimEnd()}`));
    this.proc.stderr?.on("data", (d) => log.warn(`[dbtool] ${String(d).trimEnd()}`));
    this.ready = new Promise((resolve, reject) => {
      this.waiting.set(0, { resolve: () => resolve(), reject });
    });
    this.proc.on("message", (msg: Reply) => {
      const w = this.waiting.get(msg?.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new DbToolError(msg.error));
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const w of this.waiting.values()) w.reject(new Error(`DB tool exited (code ${code})`));
      this.waiting.clear();
    });
  }

  async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    await this.ready;
    if (this.exited) throw new Error("DB tool is not running");
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.proc.postMessage({ id, cmd, args });
    return p;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
    this.proc.postMessage({ id: -1, cmd: "exit" });
    await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))]);
    if (!this.exited) this.proc.kill();
  }
}

/** Is `port` free on 127.0.0.1? */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export class AharosServer {
  private proc: UtilityProcess | null = null;
  private stopping = false;
  private crashes: number[] = [];

  constructor(
    private readonly serverDir: string,
    private readonly env: Record<string, string>,
    readonly port: number,
    private readonly log: Logger,
    /** Called when the server died unexpectedly and was (or could not be) restarted. */
    private readonly onCrash: (restarted: boolean) => void
  ) {}

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(timeoutMs = 60_000): Promise<number> {
    const started = Date.now();
    this.stopping = false;
    this.proc = utilityProcess.fork(path.join(this.serverDir, "server.js"), [], {
      env: { ...this.env, PORT: String(this.port), HOSTNAME: "127.0.0.1" },
      cwd: this.serverDir,
      stdio: "pipe",
      serviceName: "Aharos server",
    });
    const proc = this.proc;
    proc.stdout?.on("data", (d) => this.log.server(String(d)));
    proc.stderr?.on("data", (d) => this.log.server(String(d)));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopping) return;
      this.log.error(`Aharos server exited unexpectedly (code ${code})`);
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
      if (this.crashes.length > 3) return this.onCrash(false);
      setTimeout(() => {
        this.start().then(() => this.onCrash(true), (e) => {
          this.log.error(`Restart failed: ${(e as Error).message}`);
          this.onCrash(false);
        });
      }, 1_000);
    });
    await this.waitHealthy(timeoutMs, proc);
    return Date.now() - started;
  }

  private async waitHealthy(timeoutMs: number, proc: UtilityProcess): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc !== proc) throw new Error("Aharos server exited during startup (see logs/server.log)");
      try {
        const res = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Aharos server did not become healthy in time (see logs/server.log)");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    const done = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))]);
    this.proc = null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
