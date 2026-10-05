#!/usr/bin/env node
// Controlled write-contention benchmark with database + host instrumentation.
// Disposable databases only (it writes thousands of orders / bench rows).
//
//   BENCH_BASE=http://127.0.0.1:3300 BENCH_ADMIN_URL=postgresql://postgres:...@host/<db> \
//   BENCH_METRICS_TOKEN=... node scripts/ops/contention-bench.mjs \
//       --workload pos_kot --n 1,2,5,10,20 --count 200 [--json out.json]
//
// Workloads (each request = one "operation"):
//   raw_serializable  DB only (no app): one SERIALIZABLE transaction inserting an
//                     order-shaped row + 3 item rows + 1 audit-shaped row into a
//                     bench schema, reading its own rows back (same shape as POS)
//   raw_readcommitted the same at READ COMMITTED (isolates SSI cost)
//   pos_nokot         POST /api/orders (atomic placement, submit=false)
//   pos_kot           POST /api/orders (submit=true: + KOTs)
//   pos_pay           pos_kot + cash payment create + verify (settlement: invoice
//                     number, stock consumption, loyalty)
//   pay_only          settlement alone: cash payment create + verify of orders
//                     placed (unmeasured) before the timed run
//   edit_round        existing-order edits: each worker adds rounds (+KOT) to its
//                     OWN running order (captains at different tables)
//   edit_same         every worker adds rounds to ONE order (contested row: the
//                     lost-update guard; correctness is checked afterwards)
//   mixed             representative POS mix per 20 ops: 9 placements with KOT,
//                     5 rounds on running orders, 3 settlements, 3 reads
//
// Per N it reports: ok / 503 / 500 / other, P2034 (server counter delta),
// p50 / p95 / p99 / max latency, duration, throughput, WAL bytes + FPI,
// checkpoints (timed / requested) + write/sync time, commits / rollbacks,
// pool connections (max active / idle-in-transaction), lock waits, the longest
// running transaction, postgres CPU seconds, disk throughput + latency
// (Windows typeperf), and the slowest liveness probe (= Node event-loop stall).
// Every second a sample of pg_stat_activity (state, wait events, checkpointer)
// is kept; seconds with no completed request are flagged as STALLS with the
// activity snapshot taken during them.
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs, psql } from "./pg-common.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = process.env.BENCH_BASE ?? "http://127.0.0.1:3300";
const ADMIN = process.env.BENCH_ADMIN_URL;
const TOKEN = process.env.BENCH_METRICS_TOKEN;
const WORKLOAD = args.workload ?? "pos_kot";
const NS = String(args.n ?? "1,2,5,10,20").split(",").map(Number);
const COUNT = Number(args.count ?? 200);
const PASSWORD = "Load@Test12345";
if (!ADMIN) throw new Error("BENCH_ADMIN_URL required");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0);

// ---------------- probes ----------------
async function metric(name) {
  if (!TOKEN) return NaN;
  const t = await fetch(`${BASE}/api/health/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text()).catch(() => "");
  return Number((new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "m").exec(t) ?? [])[1] ?? 0);
}
const pgStats = async () => {
  const [[wal, fpi, ckT, ckR, ckW, ckS, commits, rollbacks]] = await psql(ADMIN, `SELECT (SELECT wal_bytes FROM pg_stat_wal), (SELECT wal_fpi FROM pg_stat_wal), checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time, (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()), (SELECT xact_rollback FROM pg_stat_database WHERE datname = current_database()) FROM pg_stat_bgwriter`);
  return { wal: +wal, fpi: +fpi, ckT: +ckT, ckR: +ckR, ckW: +ckW, ckS: +ckS, commits: +commits, rollbacks: +rollbacks };
};
function postgresCpuSeconds() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process postgres -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum"], { encoding: "utf8" });
    return Number(out.trim()) || 0;
  } catch { return NaN; }
}
function startDiskCounters() {
  if (process.platform !== "win32") return { stop: () => null };
  const p = spawn("typeperf", ["\\PhysicalDisk(_Total)\\Disk Bytes/sec", "\\PhysicalDisk(_Total)\\Avg. Disk sec/Transfer", "\\PhysicalDisk(_Total)\\Current Disk Queue Length", "-si", "1"], { stdio: ["ignore", "pipe", "ignore"] });
  const rows = [];
  p.stdout.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => {
    const m = l.match(/^"[^"]+","([0-9.]+)","([0-9.]+)","([0-9.]+)"/);
    if (m) rows.push({ bps: +m[1], lat: +m[2], q: +m[3] });
  }));
  return {
    stop: () => {
      p.kill();
      if (!rows.length) return null;
      const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
      return { avgMBps: +(avg("bps") / 1048576).toFixed(2), maxMBps: +(Math.max(...rows.map((r) => r.bps)) / 1048576).toFixed(2), avgLatencyMs: +(avg("lat") * 1000).toFixed(2), maxLatencyMs: +(Math.max(...rows.map((r) => r.lat)) * 1000).toFixed(1), maxQueue: Math.max(...rows.map((r) => r.q)) };
    },
  };
}
function startSampler(state) {
  const s = { stop: false, samples: [], liveMax: 0 };
  (async () => {
    while (!s.stop) {
      const t = Date.now();
      try {
        const rows = await psql(ADMIN, `SELECT backend_type, coalesce(state,''), coalesce(wait_event_type,''), coalesce(wait_event,''), coalesce(extract(epoch from (now() - xact_start))::int, -1), left(regexp_replace(coalesce(query,''), '\\s+', ' ', 'g'), 80) FROM pg_stat_activity WHERE (datname = current_database() AND usename = coalesce(nullif(current_setting('restora.bench_user', true), ''), 'restora_app') AND pid <> pg_backend_pid()) OR backend_type IN ('checkpointer','walwriter','archiver','background writer')`);
        const [[waits]] = await psql(ADMIN, "SELECT count(*) FROM pg_locks WHERE NOT granted");
        const app = rows.filter((r) => r[0] === "client backend");
        s.samples.push({
          t, done: state.done, inFlight: state.inFlight, lockWaits: +waits,
          active: app.filter((r) => r[1] === "active").length, idleInTx: app.filter((r) => r[1].startsWith("idle in transaction")).length, conns: app.length,
          oldestXactS: Math.max(-1, ...app.map((r) => +r[4])),
          waits: Object.entries(app.filter((r) => r[1] === "active" && r[2]).reduce((a, r) => ((a[`${r[2]}:${r[3]}`] = (a[`${r[2]}:${r[3]}`] ?? 0) + 1), a), {})),
          checkpointer: rows.find((r) => r[0] === "checkpointer")?.slice(2, 4).join(":") ?? "",
          activeQueries: app.filter((r) => r[1] !== "idle").map((r) => `${r[1]}|${r[2]}:${r[3]}|${r[4]}s|${r[5]}`).slice(0, 8),
        });
      } catch (e) {
        s.samples.push({ t, error: String(e.message).slice(0, 120) });
      }
      const l0 = performance.now();
      await fetch(`${BASE}/api/health/live`).catch(() => null);
      s.liveMax = Math.max(s.liveMax, performance.now() - l0);
      await sleep(Math.max(0, 1000 - (Date.now() - t)));
    }
  })();
  return s;
}

// ---------------- workloads ----------------
let fx;
async function http(method, path, cookie, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json", origin: BASE } : {}), cookie, "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
async function setupApp() {
  const sessions = [];
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": `10.8.0.${i}` }, body: JSON.stringify({ email: `load-cashier-${i}@load.test`, password: PASSWORD }) });
    if (!res.ok) throw new Error(`login load-cashier-${i} -> ${res.status} (run scripts/ops/load-test.mjs once to create the load users)`);
    sessions.push(res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "));
  }
  const [[outletId]] = await psql(ADMIN, `SELECT id FROM "Outlet" ORDER BY "createdAt" LIMIT 1`);
  const items = (await psql(ADMIN, `SELECT id FROM "MenuItem" WHERE "organizationId" = (SELECT "organizationId" FROM "Outlet" WHERE id = '${outletId}') ORDER BY name LIMIT 12`)).map((r) => r[0]);
  return { sessions, outletId, items };
}
async function setupRaw() {
  await psql(ADMIN, `CREATE SCHEMA IF NOT EXISTS bench; CREATE TABLE IF NOT EXISTS bench.ord (id text PRIMARY KEY, outlet text NOT NULL, total numeric(14,2), status text, created timestamptz DEFAULT now()); CREATE INDEX IF NOT EXISTS ord_outlet ON bench.ord(outlet, status); CREATE TABLE IF NOT EXISTS bench.item (id text PRIMARY KEY, ord text REFERENCES bench.ord(id), qty numeric(16,4), price numeric(14,2)); CREATE INDEX IF NOT EXISTS item_ord ON bench.item(ord); CREATE TABLE IF NOT EXISTS bench.audit (id text PRIMARY KEY, entity text, payload text, created timestamptz DEFAULT now())`);
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: process.env.BENCH_APP_URL ?? ADMIN } } });
}
// cuid-like, time-ordered ids (same key-locality as the app's cuid()).
let idSeq = 0;
const tid = () => `c${Date.now().toString(36)}${(idSeq++).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 8)}`;

async function rawOp(db, iso) {
  const { Prisma } = await import("@prisma/client");
  const level = iso === "serializable" ? Prisma.TransactionIsolationLevel.Serializable : Prisma.TransactionIsolationLevel.ReadCommitted;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.$transaction(async (tx) => {
        const id = tid();
        await tx.$executeRawUnsafe(`INSERT INTO bench.ord (id, outlet, total, status) VALUES ($1, 'o1', 0, 'OPEN')`, id);
        for (let k = 0; k < 3; k++) {
          await tx.$queryRawUnsafe(`SELECT id, status FROM bench.ord WHERE id = $1`, id);
          await tx.$executeRawUnsafe(`INSERT INTO bench.item (id, ord, qty, price) VALUES ($1, $2, 1, 50)`, tid(), id);
          await tx.$executeRawUnsafe(`UPDATE bench.ord SET total = (SELECT sum(qty*price) FROM bench.item WHERE ord = $1) WHERE id = $1`, id);
        }
        await tx.$executeRawUnsafe(`UPDATE bench.ord SET status = 'SENT' WHERE id = $1`, id);
        await tx.$executeRawUnsafe(`INSERT INTO bench.audit (id, entity, payload) VALUES ($1, 'ord', $2)`, tid(), id);
      }, { isolationLevel: level, maxWait: 10_000, timeout: 20_000 });
      return { status: 200, retries: attempt - 1 };
    } catch (e) {
      // Raw queries surface SQLSTATE 40001 as P2010 instead of P2034: both are serialization conflicts.
      const conflict = e?.code === "P2034" || (e?.code === "P2010" && /40001|could not serialize/i.test(String(e?.message)));
      if (conflict && attempt < 8) { await sleep(Math.random() * Math.min(400, 20 * 2 ** (attempt - 1)) + 5); continue; }
      return { status: conflict ? 503 : 500, retries: attempt - 1, err: conflict ? "conflict" : e?.code ?? e?.message };
    }
  }
}

async function place(i, submit = true) {
  const cookie = fx.sessions[i % fx.sessions.length];
  const items = [{ menuItemId: fx.items[i % fx.items.length], qty: 1 }, { menuItemId: fx.items[(i + 5) % fx.items.length], qty: 2 }];
  return http("POST", "/api/orders", cookie, { outletId: fx.outletId, channel: "TAKEAWAY", submit, items }, { "idempotency-key": `bench-${randomUUID()}` });
}
async function settle(i, order) {
  const cookie = fx.sessions[i % fx.sessions.length];
  const p = await http("POST", "/api/payments", cookie, { orderId: order.id, method: "CASH", amount: Number(order.total) });
  if (p.status !== 200) return { status: p.status, err: `pay:${p.data?.error?.code}` };
  const v = await http("POST", `/api/payments/${p.data.data.id}/verify`, cookie, {});
  return { status: v.status, err: v.status === 200 ? undefined : `verify:${v.data?.error?.code}` };
}
async function round(i, orderId) {
  const cookie = fx.sessions[i % fx.sessions.length];
  const r = await http("POST", `/api/orders/${orderId}/rounds`, cookie, { items: [{ menuItemId: fx.items[(i + 3) % fx.items.length], qty: 1 }], fire: true }, { "idempotency-key": `bench-r-${randomUUID()}` });
  return { status: r.status, err: r.status === 200 ? undefined : `round:${r.data?.error?.code}` };
}

async function appOp(i, w, workload) {
  if (workload === "pos_nokot" || workload === "pos_kot" || workload === "pos_pay") {
    const o = await place(i, workload !== "pos_nokot");
    if (o.status !== 200 || workload !== "pos_pay") return { status: o.status, err: o.data?.error?.code };
    return settle(i, o.data.data);
  }
  if (workload === "pay_only") return settle(i, fx.prePlaced[i]);
  if (workload === "edit_round") return round(i, fx.running[w % fx.running.length]);
  if (workload === "edit_same") return round(i, fx.running[0]);
  // mixed
  const k = i % 20;
  if (k < 9) { const o = await place(i, true); if (o.status === 200) fx.running.push(o.data.data.id); return { status: o.status, err: o.data?.error?.code }; }
  if (k < 14) return round(i, fx.running[Math.floor(Math.random() * fx.running.length)]);
  if (k < 17) { const o = await place(i, true); return o.status === 200 ? settle(i, o.data.data) : { status: o.status, err: o.data?.error?.code }; }
  const r = await http("GET", `/api/orders?outletId=${fx.outletId}&active=true&take=50`, fx.sessions[i % fx.sessions.length]);
  return { status: r.status };
}

/** Before a run: orders the edit / settlement workloads act on (not timed). */
async function prepare(workload, n) {
  fx.running = [];
  fx.prePlaced = [];
  if (workload === "pay_only") {
    for (let i = 0; i < COUNT; i += 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, COUNT - i) }, (_, k) => place(i + k, true)));
      for (const b of batch) if (b.status === 200) fx.prePlaced.push(b.data.data);
    }
  }
  if (workload.startsWith("edit_") || workload === "mixed") {
    for (let w = 0; w < Math.max(n, 5); w++) {
      const o = await place(w, true);
      if (o.status === 200) fx.running.push(o.data.data.id);
    }
  }
}

/** After a run: every touched order is internally consistent (no lost update, every line on exactly one KOT). */
async function verifyOrders(ids) {
  if (!ids.length) return null;
  const list = ids.map((x) => `'${x}'`).join(",");
  const [[bad, kotBad, n]] = await psql(ADMIN, `SELECT
      (SELECT count(*) FROM "Order" o WHERE o.id IN (${list}) AND o.subtotal <> (SELECT coalesce(sum(i."lineTotal"),0) FROM "OrderItem" i WHERE i."orderId" = o.id)),
      (SELECT count(*) FROM "OrderItem" i WHERE i."orderId" IN (${list}) AND (SELECT count(*) FROM "KotItem" k WHERE k."orderItemId" = i.id) <> 1),
      (SELECT count(*) FROM "Order" o WHERE o.id IN (${list}))`);
  return { orders: +n, subtotalMismatch: +bad, itemsNotOnExactlyOneKot: +kotBad };
}

// ---------------- run ----------------
async function runN(n, op) {
  const state = { done: 0, inFlight: 0 };
  const lat = [], statuses = {};
  let retries = 0;
  const before = await pgStats();
  const cpu0 = postgresCpuSeconds();
  const p2034_0 = await metric("restora_db_serialization_conflicts_total");
  const disk = startDiskCounters();
  const sampler = startSampler(state);
  const t0 = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: n }, async (_, w) => {
    while (next < COUNT) {
      const i = next++;
      state.inFlight++;
      const s = performance.now();
      const r = await op(i, w).catch((e) => ({ status: 0, err: e.message }));
      lat.push(performance.now() - s);
      state.inFlight--;
      state.done++;
      retries += r.retries ?? 0;
      const k = r.status === 200 ? "ok" : `${r.status}${r.err ? `:${r.err}` : ""}`;
      statuses[k] = (statuses[k] ?? 0) + 1;
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  sampler.stop = true;
  await sleep(1100);
  const diskStats = disk.stop();
  const after = await pgStats();
  const cpu1 = postgresCpuSeconds();
  const p2034_1 = await metric("restora_db_serialization_conflicts_total");
  const s = lat.sort((a, b) => a - b);
  const samples = sampler.samples.filter((x) => !x.error);
  // Stall = a sampled second in which requests were in flight but none completed, for >= 3 consecutive samples.
  const stalls = [];
  let run = [];
  for (let k = 1; k < samples.length; k++) {
    const stalled = samples[k].inFlight > 0 && samples[k].done === samples[k - 1].done;
    if (stalled) run.push(samples[k]);
    if ((!stalled || k === samples.length - 1) && run.length >= 3) stalls.push({ seconds: run.length, snapshot: run[Math.floor(run.length / 2)] });
    if (!stalled) run = [];
  }
  const ok = statuses.ok ?? 0;
  return {
    n, operations: COUNT, ok, statuses, durationS: +secs.toFixed(1), throughputOps: +(ok / secs).toFixed(2),
    p50: Math.round(pct(s, 50)), p95: Math.round(pct(s, 95)), p99: Math.round(pct(s, 99)), max: Math.round(s.at(-1) ?? 0),
    serializationConflicts: WORKLOAD.startsWith("raw") ? retries : p2034_1 - p2034_0, clientRetries: retries,
    walMB: +((after.wal - before.wal) / 1048576).toFixed(2), walFpi: after.fpi - before.fpi,
    checkpoints: { timed: after.ckT - before.ckT, requested: after.ckR - before.ckR, writeS: +((after.ckW - before.ckW) / 1000).toFixed(1), syncS: +((after.ckS - before.ckS) / 1000).toFixed(2) },
    commits: after.commits - before.commits, rollbacks: after.rollbacks - before.rollbacks,
    pool: { maxConns: Math.max(0, ...samples.map((x) => x.conns)), maxActive: Math.max(0, ...samples.map((x) => x.active)), maxIdleInTx: Math.max(0, ...samples.map((x) => x.idleInTx)), maxLockWaits: Math.max(0, ...samples.map((x) => x.lockWaits)), longestXactS: Math.max(-1, ...samples.map((x) => x.oldestXactS)) },
    postgresCpuS: +(cpu1 - cpu0).toFixed(1), disk: diskStats, slowestLivenessMs: Math.round(sampler.liveMax),
    checkpointerWaits: [...new Set(samples.map((x) => x.checkpointer).filter(Boolean))],
    stalls,
  };
}

async function main() {
  const raw = WORKLOAD.startsWith("raw");
  let op;
  if (raw) {
    const db = await setupRaw();
    op = () => rawOp(db, WORKLOAD === "raw_serializable" ? "serializable" : "readcommitted");
  } else {
    fx = await setupApp();
    op = (i, w) => appOp(i, w, WORKLOAD);
  }
  const results = [];
  console.log(`workload=${WORKLOAD} count=${COUNT} per N`);
  for (const n of NS) {
    if (!raw) await prepare(WORKLOAD, n);
    const itemsBefore = WORKLOAD === "edit_same" && fx.running[0] ? +(await psql(ADMIN, `SELECT count(*) FROM "OrderItem" WHERE "orderId" = '${fx.running[0]}'`))[0][0] : null;
    const r = await runN(n, op);
    if (!raw && fx.running.length) r.integrity = await verifyOrders(fx.running);
    if (itemsBefore !== null) {
      const after = +(await psql(ADMIN, `SELECT count(*) FROM "OrderItem" WHERE "orderId" = '${fx.running[0]}'`))[0][0];
      r.integrity.linesAdded = after - itemsBefore; // must equal the number of successful rounds (1 line each)
      r.integrity.lostRounds = (r.statuses.ok ?? 0) - (after - itemsBefore);
    }
    results.push(r);
    console.log(`N=${String(n).padStart(2)} ok=${r.ok}/${r.operations} ${JSON.stringify(r.statuses)} p50=${r.p50} p95=${r.p95} p99=${r.p99} max=${r.max}ms ${r.throughputOps}/s conflicts=${r.serializationConflicts} WAL=${r.walMB}MB fpi=${r.walFpi} ckpt=${JSON.stringify(r.checkpoints)} pgCPU=${r.postgresCpuS}s disk=${JSON.stringify(r.disk)} live<=${r.slowestLivenessMs}ms pool=${JSON.stringify(r.pool)} stalls=${r.stalls.length}${r.integrity ? ` integrity=${JSON.stringify(r.integrity)}` : ""}`);
    for (const st of r.stalls) console.log(`   STALL ${st.seconds}s: ${JSON.stringify(st.snapshot)}`);
    await sleep(2000);
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ workload: WORKLOAD, count: COUNT, at: new Date().toISOString(), results }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
