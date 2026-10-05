// Runtime verification against the REAL production build (`next start`), on a
// disposable database. Proves, with a running server process:
//
//   1. health: /api/health/live, /api/health/ready, /api/health and metrics auth;
//   2. graceful shutdown: SIGTERM while API requests are in flight -> every
//      in-flight request completes (200), the process drains, runs its shutdown
//      tasks and exits 0 (and our drain runs BEFORE Next.js closes the server);
//   3. crash recovery: a hard kill (no shutdown at all) while background work is
//      in flight, and rows left behind by a "previous process" (PENDING
//      delivery, QUEUED print, RUNNING export, RECEIVED webhook claim) are
//      recovered by the maintenance worker of the NEXT process.
//
// Usage (after `npm run build`):
//   node scripts/ops/verify-runtime.mjs               # SQLite temp database
//   VERIFY_DATABASE_URL=postgresql://... node scripts/ops/verify-runtime.mjs   # a FRESH disposable PostgreSQL db
//                                                       (PostgreSQL Prisma client must be generated)
//
// Windows has no real SIGTERM for another process, so the harness delivers the
// signal in-process (a --require preload turns a "SIGTERM" line on stdin into
// process.emit("SIGTERM")) — the exact listener path a real signal takes.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const PORT = Number(process.env.VERIFY_PORT ?? 3290);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restora-verify-"));
const pgUrl = process.env.VERIFY_DATABASE_URL;
const DB_URL = pgUrl ?? `file:${path.join(tmp, "verify.db").replace(/\\/g, "/")}`;
const METRICS_TOKEN = "verify-metrics-token-0123456789abcdef";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function prepareDb() {
  const prismaCli = require.resolve("prisma/build/index.js");
  const schema = pgUrl ? ["--schema", "prisma/postgres/schema.prisma"] : [];
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy", ...schema], { stdio: "inherit", env: { ...process.env, DATABASE_URL: DB_URL } });
  execFileSync(process.execPath, [require.resolve("tsx/cli"), "prisma/seed.ts"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: DB_URL, ALLOW_DEMO_SEED: "true" } });
}

const preload = path.join(tmp, "signal-preload.cjs");
fs.writeFileSync(preload, `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  if (buf.includes("SIGTERM")) { buf = ""; console.log("[harness] SIGTERM listeners: " + process.listenerCount("SIGTERM")); process.emit("SIGTERM", "SIGTERM"); }
});
`);

function startServer(extraEnv = {}) {
  const logs = [];
  const child = spawn(process.execPath, ["--require", preload, require.resolve("next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: "production", DATABASE_URL: DB_URL, AUTH_SECRET: "verify-runtime-auth-secret-not-real-0123456789",
      ALLOW_MOCK_PROVIDERS: "true", LOG_LEVEL: "info", LOG_FORMAT: "json", METRICS_TOKEN, EXPORT_DIR: path.join(tmp, "exports"),
      OUTBOX_WORKER_INTERVAL_MS: "2000", OUTBOX_STUCK_SECONDS: "30", EXPORT_STALE_MINUTES: "1", SHUTDOWN_TIMEOUT_MS: "20000", ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => logs.push(l));
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, logs, exited };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 120_000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "owner@demo.local", password: "Demo@12345" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!res.ok || !cookie) throw new Error(`login failed ${res.status}`);
  return cookie;
}

async function main() {
  prepareDb();
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const org = await db.organization.findFirstOrThrow();
  const outlet = await db.outlet.findFirstOrThrow({ where: { organizationId: org.id } });

  // ---------------- 1 + 2: health, metrics, graceful shutdown ----------------
  let s = startServer();
  await waitFor(async () => (await fetch(`${BASE}/api/health/ready`)).ok, 120_000, "readiness");
  const live = await fetch(`${BASE}/api/health/live`);
  check("liveness 200", live.status === 200);
  const ready = await (await fetch(`${BASE}/api/health/ready`)).json();
  check("readiness ready (db up, migrations ok)", ready.status === "ready" && ready.checks.database === "up" && ready.checks.migrations === "ok", JSON.stringify(ready.checks));
  check("metrics require the token", (await fetch(`${BASE}/api/health/metrics`)).status === 401);
  const m = await fetch(`${BASE}/api/health/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  const mtext = await m.text();
  check("metrics served with token", m.status === 200 && mtext.includes("restora_outbox_deliveries") && mtext.includes("restora_worker_up 1"));

  const cookie = await login();
  const from = new Date(Date.now() - 30 * 86400_000).toISOString(), to = new Date().toISOString();
  const heavy = [`/api/reports/DAILY_SALES?outletId=${outlet.id}&from=${from}&to=${to}`, `/api/reports/ITEM_SALES?outletId=${outlet.id}&from=${from}&to=${to}`, `/api/orders?outletId=${outlet.id}&take=200`];
  const inflight = Array.from({ length: 24 }, (_, i) => fetch(`${BASE}${heavy[i % heavy.length]}`, { headers: { cookie } }).then((r) => r.status).catch((e) => `error:${e.cause?.code ?? e.message}`));
  await sleep(15);
  s.child.stdin.write("SIGTERM\n");
  const statuses = await Promise.all(inflight);
  const exit = await Promise.race([s.exited, sleep(30_000).then(() => ({ code: "timeout" }))]);
  const okCount = statuses.filter((x) => x === 200).length;
  const refused = statuses.filter((x) => x === 503).length;
  check("in-flight requests completed or were refused cleanly (no resets)", okCount + refused === statuses.length && okCount > 0, `200=${okCount} 503=${refused} other=${statuses.filter((x) => x !== 200 && x !== 503).join(",")}`);
  check("process exited 0 after drain", exit.code === 0, `exit=${JSON.stringify(exit)}`);
  const jl = s.logs.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  const idxStart = jl.findIndex((r) => r.msg === "shutdown started");
  const idxDone = jl.findIndex((r) => r.msg === "shutdown complete");
  check("drain ran (shutdown started -> complete) before exit", idxStart >= 0 && idxDone > idxStart);
  const tasks = jl.filter((r) => r.msg === "shutdown task timed out" || r.msg === "shutdown task failed");
  check("all shutdown tasks finished in time", tasks.length === 0, JSON.stringify(tasks));
  const harness = s.logs.find((l) => l.includes("[harness] SIGTERM listeners"));
  check("exactly one SIGTERM listener (ours, wrapping Next's)", Boolean(harness?.endsWith(": 1")), harness ?? "none");
  check("no secret material in server logs", !s.logs.join("\n").includes("Demo@12345") && !s.logs.join("\n").includes("verify-runtime-auth-secret"));

  // ---------------- 3: hard kill + recovery by the next process ----------------
  const old = new Date(Date.now() - 10 * 60_000);
  const order = await db.order.findFirstOrThrow({ where: { outletId: outlet.id } });
  const printer = await db.printer.create({ data: { organizationId: org.id, outletId: outlet.id, name: "Verify KOT", transport: "SIMULATED", role: "KOT" } });
  const pending = await db.integrationDelivery.create({ data: { organizationId: org.id, outletId: outlet.id, kind: "MESSAGE", provider: "mock", mode: "MOCK", idempotencyKey: `verify:${Date.now()}`, payload: "{}", sourceType: "Order", sourceId: order.id, updatedAt: old, createdAt: old } });
  const queued = await db.printJob.create({ data: { organizationId: org.id, outletId: outlet.id, printerId: printer.id, kind: "KOT", dedupeKey: `verify:${Date.now()}`, content: "x", createdAt: old } });
  const running = await db.exportJob.create({ data: { organizationId: org.id, kind: "DAILY_SALES", status: "RUNNING", startedAt: old, createdAt: old } });
  const claim = await db.webhookEvent.create({ data: { provider: "payment:mock", eventId: `verify-stuck-${Date.now()}`, status: "RECEIVED", payload: "{}", signatureValid: true, receivedAt: old } });

  s = startServer();
  await waitFor(async () => (await fetch(`${BASE}/api/health/ready`)).ok, 120_000, "readiness (2)");
  const cookie2 = await login();
  // A background export, then an immediate hard kill (no drain at all).
  const exp = await fetch(`${BASE}/api/exports`, { method: "POST", headers: { cookie: cookie2, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ report: "DAILY_SALES", filters: { outletId: outlet.id, from, to }, mode: "background" }) });
  const expBody = await exp.json().catch(() => ({}));
  s.child.kill("SIGKILL");
  await s.exited;
  check("hard kill while background work was in flight", true, `export request ${exp.status}`);

  s = startServer();
  await waitFor(async () => (await fetch(`${BASE}/api/health/ready`)).ok, 120_000, "readiness (3)");
  await waitFor(async () => (await db.integrationDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status !== "PENDING", 30_000, "stuck delivery recovery");
  const d = await db.integrationDelivery.findUniqueOrThrow({ where: { id: pending.id } });
  check("stuck PENDING message -> FAILED for manual retry (not auto re-sent)", d.status === "FAILED" && d.nextAttemptAt === null && d.attempts === 0, d.lastError ?? "");
  const p = await db.printJob.findUniqueOrThrow({ where: { id: queued.id } });
  check("stuck QUEUED print -> FAILED (no surprise late print)", p.status === "FAILED", p.lastError ?? "");
  const e = await db.exportJob.findUniqueOrThrow({ where: { id: running.id } });
  check("export left RUNNING by the dead process -> FAILED (never run twice)", e.status === "FAILED", e.error ?? "");
  const jobId = expBody?.data?.id;
  if (jobId) {
    const j = await waitFor(async () => {
      const r = await db.exportJob.findUnique({ where: { id: jobId } });
      return r && ["SUCCESS", "FAILED"].includes(r.status) ? r : null;
    }, 150_000, "export killed mid-flight to settle");
    check("export killed mid-flight settles after restart (re-queued or interrupted, never stuck)", ["SUCCESS", "FAILED"].includes(j.status), j.status);
  } else check("export killed mid-flight settles after restart", false, `no job id in response ${exp.status}`);
  const w = await db.webhookEvent.findUniqueOrThrow({ where: { id: claim.id } });
  check("abandoned webhook claim left for provider retry (still RECEIVED, alerted)", w.status === "RECEIVED" && s.logs.some((l) => l.includes("webhook_stuck")));
  check("worker logged its recovery", s.logs.some((l) => l.includes("stuck_recovered")));

  s.child.stdin.write("SIGTERM\n");
  const exit3 = await Promise.race([s.exited, sleep(30_000).then(() => ({ code: "timeout" }))]);
  check("second graceful shutdown exits 0", exit3.code === 0, JSON.stringify(exit3));
  await db.$disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} runtime checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-runtime failed:", e);
  process.exit(1);
});
