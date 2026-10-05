#!/usr/bin/env node
// Production-oriented load test for RESTORA (real HTTP against `next start`).
//
//   LOAD_BASE=http://127.0.0.1:3300 LOAD_DATABASE_URL=postgresql://postgres:...@127.0.0.1:55433/restora_load \
//   LOAD_METRICS_TOKEN=... node scripts/ops/load-test.mjs [--scale 1] [--json report.json]
//
// LOAD_DATABASE_URL is an ADMIN connection to the SAME (disposable!) database the
// server uses: fixtures (load users, QR tables, printers, messaging, webhook
// binding) are created through it, pg_stat_statements / pg_stat_activity /
// pg_locks are sampled through it, and the business invariants are checked
// through it afterwards. NEVER point this at a production database.
//
// Measured per scenario: requests, throughput, p50/p95/p99 latency, error rate
// (unexpected statuses), plus database connections in use, lock waits, deadlocks,
// serialization retries, top statements by total time, server CPU / RSS.
import fs from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { psql, parseArgs } from "./pg-common.mjs";

const require = createRequire(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const BASE = process.env.LOAD_BASE ?? "http://127.0.0.1:3300";
const DB = process.env.LOAD_DATABASE_URL;
const METRICS_TOKEN = process.env.LOAD_METRICS_TOKEN;
const SCALE = Number(args.scale ?? 1);
// --conc 0.25 = a quarter of the default worker counts (20 -> 5 writers): realistic vs stress profiles.
const CONC = Number(args.conc ?? 1);
const c = (n) => Math.max(1, Math.round(n * CONC));
const PASSWORD = "Load@Test12345";
if (!DB) throw new Error("LOAD_DATABASE_URL is required (admin URL of the disposable database the server uses)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 0;
const fakeIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

// ---------------- HTTP ----------------
async function http(method, path, { cookie, body, headers = {}, ip } = {}) {
  const t0 = performance.now();
  let status, data;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json", origin: BASE } : {}), ...(cookie ? { cookie } : {}), ...(ip ? { "x-forwarded-for": ip } : {}), ...headers },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    status = res.status;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status, data, ms: performance.now() - t0, res };
  } catch (e) {
    return { status: 0, data: String(e.cause?.code ?? e.message), ms: performance.now() - t0 };
  }
}

// ---------------- stats ----------------
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
class Recorder {
  constructor(name) { this.name = name; this.samples = []; this.errors = new Map(); this.statuses = new Map(); this.t0 = 0; this.t1 = 0; this.n = 0; }
  add(label, r, expected) {
    this.n++;
    this.samples.push(r.ms);
    const key = `${label}:${r.status}`;
    this.statuses.set(key, (this.statuses.get(key) ?? 0) + 1);
    if (!expected.includes(r.status)) {
      const k = `${label} ${r.status} ${typeof r.data === "object" ? r.data?.error?.code ?? "" : String(r.data).slice(0, 60)}`;
      this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
    }
  }
  summary() {
    const s = [...this.samples].sort((a, b) => a - b);
    const secs = (this.t1 - this.t0) / 1000;
    const errs = [...this.errors.values()].reduce((a, b) => a + b, 0);
    return {
      scenario: this.name, requests: this.n, seconds: +secs.toFixed(2), throughputRps: +(this.n / secs).toFixed(1),
      p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), p99: +pct(s, 99).toFixed(1), max: +(s.at(-1) ?? 0).toFixed(1),
      errorRatePct: +((errs / Math.max(1, this.n)) * 100).toFixed(2), unexpected: Object.fromEntries(this.errors), statuses: Object.fromEntries(this.statuses),
    };
  }
}

async function pool(concurrency, jobs, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      await worker(j);
    }
  }));
}

// ---------------- DB sampling ----------------
let sampling = null;
function startSampler() {
  const s = { conns: [], waiting: [], stop: false };
  (async () => {
    while (!s.stop) {
      try {
        const [[active, total, idleTx]] = await psql(DB, `SELECT count(*) FILTER (WHERE state = 'active'), count(*), count(*) FILTER (WHERE state LIKE 'idle in transaction%') FROM pg_stat_activity WHERE datname = current_database() AND usename = 'restora_app'`);
        const [[waits]] = await psql(DB, `SELECT count(*) FROM pg_locks WHERE NOT granted`);
        s.conns.push({ active: +active, total: +total, idleTx: +idleTx });
        s.waiting.push(+waits);
      } catch { /* sampler must not break the test */ }
      await sleep(300);
    }
  })();
  return s;
}
async function serverMetrics() {
  if (!METRICS_TOKEN) return null;
  const r = await fetch(`${BASE}/api/health/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } }).then((x) => x.text()).catch(() => "");
  const g = (n) => Number((new RegExp(`^${n}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "m").exec(r) ?? [])[1] ?? NaN);
  return { cpuSeconds: g("restora_process_cpu_seconds_total"), rssMb: Math.round(g("restora_process_resident_memory_bytes") / 1048576), heapMb: Math.round(g("restora_process_heap_used_bytes") / 1048576), r };
}
const dbStats = async () => {
  const [[deadlocks, rollbacks, conflicts, commits]] = await psql(DB, `SELECT deadlocks, xact_rollback, conflicts, xact_commit FROM pg_stat_database WHERE datname = current_database()`);
  return { deadlocks: +deadlocks, rollbacks: +rollbacks, conflicts: +conflicts, commits: +commits };
};

const results = [];
async function scenario(name, fn) {
  const rec = new Recorder(name);
  const before = await dbStats();
  const m0 = await serverMetrics();
  sampling = startSampler();
  rec.t0 = performance.now();
  await fn(rec);
  rec.t1 = performance.now();
  sampling.stop = true;
  const after = await dbStats();
  const m1 = await serverMetrics();
  const sum = rec.summary();
  sum.db = {
    maxAppConnections: Math.max(0, ...sampling.conns.map((c) => c.total)), maxActive: Math.max(0, ...sampling.conns.map((c) => c.active)),
    maxIdleInTx: Math.max(0, ...sampling.conns.map((c) => c.idleTx)), maxLockWaits: Math.max(0, ...sampling.waiting),
    deadlocks: after.deadlocks - before.deadlocks, rollbacks: after.rollbacks - before.rollbacks, commits: after.commits - before.commits,
  };
  if (m0 && m1) sum.server = { cpuPct: Math.round(((m1.cpuSeconds - m0.cpuSeconds) / sum.seconds) * 100), rssMb: m1.rssMb, heapMb: m1.heapMb };
  results.push(sum);
  console.log(`${name.padEnd(28)} n=${String(sum.requests).padStart(5)}  ${String(sum.throughputRps).padStart(7)} rps  p50 ${sum.p50}ms  p95 ${sum.p95}ms  p99 ${sum.p99}ms  err ${sum.errorRatePct}%  conns<=${sum.db.maxAppConnections} lockWaits<=${sum.db.maxLockWaits} deadlocks=${sum.db.deadlocks}${sum.server ? ` cpu~${sum.server.cpuPct}% rss=${sum.server.rssMb}MB` : ""}`);
  if (Object.keys(sum.unexpected).length) console.log(`   unexpected: ${JSON.stringify(sum.unexpected)}`);
  return sum;
}

// ---------------- fixtures ----------------
async function setup() {
  const { PrismaClient } = await import("@prisma/client");
  const bcrypt = require("bcryptjs");
  const db = new PrismaClient({ datasources: { db: { url: DB } } });
  const org = await db.organization.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const outlet = await db.outlet.findFirstOrThrow({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" } });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const users = { cashier: [], manager: [] };
  for (const [role, n] of [["CASHIER", 40], ["MANAGER", 10]]) {
    for (let i = 0; i < n; i++) {
      const email = `load-${role.toLowerCase()}-${i}@load.test`;
      const u = await db.user.upsert({ where: { email }, update: { passwordHash: hash, active: true }, create: { organizationId: org.id, email, name: `Load ${role} ${i}`, passwordHash: hash } });
      await db.membership.upsert({ where: { userId_outletId_role: { userId: u.id, outletId: outlet.id, role } }, update: { active: true }, create: { organizationId: org.id, userId: u.id, outletId: outlet.id, role } });
      users[role === "CASHIER" ? "cashier" : "manager"].push(email);
    }
  }
  const items = await db.menuItem.findMany({ where: { organizationId: org.id, active: true }, take: 12, orderBy: { name: "asc" }, select: { id: true } }).catch(() => db.menuItem.findMany({ where: { organizationId: org.id }, take: 12, select: { id: true } }));
  const tables = [];
  for (let i = 0; i < 80; i++) {
    const code = `LD${i}`;
    const t = await db.restaurantTable.upsert({ where: { outletId_code: { outletId: outlet.id, code } }, update: {}, create: { organizationId: org.id, outletId: outlet.id, code, qrToken: `load-${randomUUID()}` } });
    if (!t.qrToken) await db.restaurantTable.update({ where: { id: t.id }, data: { qrToken: `load-${randomUUID()}` } });
    tables.push((await db.restaurantTable.findUniqueOrThrow({ where: { id: t.id } })).qrToken);
  }
  const customers = [];
  for (let i = 0; i < 200; i++) {
    const phone = `90000${String(i).padStart(5, "0")}`;
    customers.push((await db.customer.upsert({ where: { organizationId_phone: { organizationId: org.id, phone } }, update: {}, create: { organizationId: org.id, name: `Load Guest ${i}`, phone } })).id);
  }
  // Integrations the side effects go through: simulated printers, mock messaging (all templates), payment webhook binding.
  for (const [name, role] of [["Load KOT", "KOT"], ["Load Receipt", "RECEIPT"]]) {
    await db.printer.upsert({ where: { outletId_name: { outletId: outlet.id, name } }, update: {}, create: { organizationId: org.id, outletId: outlet.id, name, role, transport: "SIMULATED", autoPrint: true, cashDrawer: role === "RECEIPT" } });
  }
  const msgConfig = JSON.stringify({ channel: "SMS", templates: { ORDER_CONFIRMED: true, ORDER_READY: true, PAYMENT_RECEIVED: true } });
  const existingMsg = await db.integrationConnection.findFirst({ where: { organizationId: org.id, kind: "MESSAGING", provider: "mock" } });
  if (existingMsg) await db.integrationConnection.update({ where: { id: existingMsg.id }, data: { status: "CONNECTED", config: msgConfig } });
  else await db.integrationConnection.create({ data: { organizationId: org.id, kind: "MESSAGING", provider: "mock", status: "CONNECTED", config: msgConfig } });
  const acct = `acct-load-${org.id}`;
  await db.integrationConnection.upsert({ where: { kind_provider_externalRef: { kind: "PAYMENT", provider: "mock", externalRef: acct } }, update: { status: "CONNECTED" }, create: { organizationId: org.id, kind: "PAYMENT", provider: "mock", externalRef: acct, status: "CONNECTED" } });
  const vendor = await db.vendor.findFirst({ where: { organizationId: org.id } });
  const materials = await db.material.findMany({ where: { organizationId: org.id }, take: 3, select: { id: true } });
  await db.$disconnect();
  return { org, outlet, users, items: items.map((i) => i.id), tables, customers, acct, vendorId: vendor?.id, materials: materials.map((m) => m.id) };
}

async function login(email, ip) {
  const r = await http("POST", "/api/auth/login", { body: { email, password: PASSWORD }, ip });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return { cookie: r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), ip, r };
}

// ---------------- main ----------------
async function main() {
  console.log(`load test against ${BASE} (scale ${SCALE}, concurrency x${CONC})`);
  const fx = await setup();
  const outletId = fx.outlet.id;
  await psql(DB, "SELECT pg_stat_statements_reset()").catch(() => console.log("(pg_stat_statements not available)"));
  const n = (x) => Math.max(1, Math.round(x * SCALE));

  // 1. Login (bcrypt cost 10; per-email limit 10 / 15 min -> 4 logins per account)
  const cashiers = [], managers = [];
  await scenario("login", async (rec) => {
    const jobs = [];
    for (const e of fx.users.cashier) for (let k = 0; k < 4; k++) jobs.push(e);
    await pool(c(10), jobs, async (email) => {
      const ip = fakeIp();
      const r = await http("POST", "/api/auth/login", { body: { email, password: PASSWORD }, ip });
      rec.add("login", r, [200]);
    });
  });
  for (const e of fx.users.cashier.slice(0, 30)) cashiers.push(await login(e, fakeIp()));
  for (const e of fx.users.manager) managers.push(await login(e, fakeIp()));

  const item = (i) => fx.items[i % fx.items.length];
  let seq = 0;
  const createdOrders = [];

  // 2. POS order creation (atomic placement + KOTs; after-commit auto KOT print + confirmation message)
  await scenario("pos_order_create", async (rec) => {
    await pool(c(20), Array.from({ length: n(600) }, (_, i) => i), async (i) => {
      const s = cashiers[i % cashiers.length];
      const r = await http("POST", "/api/orders", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-ord-${randomUUID()}` }, body: { outletId, channel: "TAKEAWAY", submit: true, customerId: fx.customers[i % fx.customers.length], items: [{ menuItemId: item(i), qty: 1 + (i % 3) }, { menuItemId: item(i + 5), qty: 1 }] } });
      rec.add("order", r, [200]);
      if (r.status === 200) createdOrders.push({ id: r.data.data.id, total: Number(r.data.data.total) });
    });
  });

  // 3. Payment creation + verification (cash: settles the order -> invoice, stock consumption, loyalty; receipt message, drawer kick)
  await scenario("payment_create_verify", async (rec) => {
    await pool(c(20), createdOrders.slice(0, n(500)), async (o) => {
      const s = cashiers[seq++ % cashiers.length];
      const c = await http("POST", "/api/payments", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-pay-${o.id.slice(-12)}-${randomUUID().slice(0, 8)}` }, body: { orderId: o.id, method: "CASH", amount: o.total } });
      rec.add("create", c, [200]);
      if (c.status !== 200) return;
      const v = await http("POST", `/api/payments/${c.data.data.id}/verify`, { cookie: s.cookie, ip: s.ip, body: {} });
      rec.add("verify", v, [200]);
    });
  });

  // 4. Concurrent payments racing for the SAME order (5 tills, full amount each): exactly one may succeed (H1)
  const raceOrders = [];
  for (let i = 0; i < n(40); i++) {
    const s = cashiers[i % cashiers.length];
    const r = await http("POST", "/api/orders", { cookie: s.cookie, ip: s.ip, body: { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: item(i), qty: 2 }] } });
    if (r.status === 200) raceOrders.push({ id: r.data.data.id, total: Number(r.data.data.total) });
  }
  await scenario("concurrent_same_order_pay", async (rec) => {
    await pool(c(8), raceOrders, async (o) => {
      await Promise.all(Array.from({ length: 5 }, async (_, k) => {
        const s = cashiers[(seq++ + k) % cashiers.length];
        const c = await http("POST", "/api/payments", { cookie: s.cookie, ip: s.ip, body: { orderId: o.id, method: k % 2 ? "CARD" : "CASH", amount: o.total } });
        rec.add("create", c, [200, 422, 409]);
        if (c.status !== 200) return;
        const v = await http("POST", `/api/payments/${c.data.data.id}/verify`, { cookie: s.cookie, ip: s.ip, body: {} });
        rec.add("verify", v, [200, 422, 409]);
      }));
    });
  });

  // 5. Duplicate requests: the same Idempotency-Key sent 5x concurrently -> one order
  const dupKeys = [];
  await scenario("duplicate_order_requests", async (rec) => {
    await pool(c(10), Array.from({ length: n(60) }, (_, i) => i), async (i) => {
      const key = `load-dup-${randomUUID()}`;
      dupKeys.push(key);
      const s = cashiers[i % cashiers.length];
      const body = { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: item(i), qty: 1 }] };
      const rs = await Promise.all(Array.from({ length: 5 }, () => http("POST", "/api/orders", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": key }, body })));
      rs.forEach((r) => rec.add("order", r, [200, 409]));
    });
  });

  // 6. QR guest ordering: menu -> order -> online payment (mock gateway) -> confirm
  await scenario("qr_guest_order_pay", async (rec) => {
    await pool(c(15), Array.from({ length: n(150) }, (_, i) => i), async (i) => {
      const token = fx.tables[i % fx.tables.length];
      const ip = fakeIp();
      const m = await http("GET", `/api/qr/t/${token}`, { ip });
      rec.add("menu", m, [200]);
      const o = await http("POST", `/api/qr/t/${token}/orders`, { ip, headers: { "idempotency-key": `load-qr-${randomUUID()}` }, body: { items: [{ menuItemId: item(i), qty: 1 }] } });
      rec.add("order", o, [200]);
      if (o.status !== 200) return;
      const key = o.data.data.accessKey ?? o.data.data.key ?? o.data.data.orderKey;
      const id = o.data.data.id ?? o.data.data.orderId;
      const p = await http("POST", `/api/qr/orders/${id}/payments`, { ip, headers: { "x-order-key": key, "idempotency-key": `load-qrp-${randomUUID()}` }, body: {} });
      rec.add("pay_start", p, [200]);
      if (p.status !== 200) return;
      const c = await http("POST", `/api/qr/orders/${id}/payments/confirm`, { ip, headers: { "x-order-key": key }, body: { paymentId: p.data.data.paymentId, providerRef: `mockref_${randomUUID().slice(0, 12)}` } });
      rec.add("pay_confirm", c, [200]);
    });
  });

  // 7. Payment webhooks with provider retries: each capture event delivered 4x concurrently
  const hookOrders = [];
  for (let i = 0; i < n(60); i++) {
    const s = cashiers[i % cashiers.length];
    const o = await http("POST", "/api/orders", { cookie: s.cookie, ip: s.ip, body: { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: item(i), qty: 1 }] } });
    if (o.status !== 200) continue;
    const ref = `load-gw-${randomUUID().slice(0, 12)}`;
    const p = await http("POST", "/api/payments", { cookie: s.cookie, ip: s.ip, body: { orderId: o.data.data.id, method: "ONLINE", amount: Number(o.data.data.total), provider: "mock", providerRef: ref } });
    if (p.status === 200) hookOrders.push({ orderId: o.data.data.id, ref, amount: Number(o.data.data.total) });
  }
  const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-webhook-secret";
  await scenario("payment_webhook_retries", async (rec) => {
    await pool(c(10), hookOrders, async (h) => {
      const raw = JSON.stringify({ accountId: fx.acct, eventId: `load-ev-${h.ref}`, event: "payment.captured", providerRef: h.ref, amount: h.amount });
      const sig = createHmac("sha256", secret).update(raw).digest("hex");
      const rs = await Promise.all(Array.from({ length: 4 }, () => http("POST", "/api/webhooks/payment/mock", { body: raw, headers: { "x-signature": sig }, ip: "203.0.113.10" })));
      rs.forEach((r) => rec.add("webhook", r, [200]));
    });
  });

  // 8. Kitchen display polling + KOT status changes
  await scenario("kitchen_kds", async (rec) => {
    const kitchenUser = managers[0];
    await pool(c(10), Array.from({ length: n(200) }, (_, i) => i), async () => {
      const r = await http("GET", `/api/kitchen/kots?outletId=${outletId}`, { cookie: kitchenUser.cookie, ip: kitchenUser.ip, headers: { "x-aharos-background": "1" } });
      rec.add("kots", r, [200]);
    });
  });

  // 9 + 10. Reports and analytics (30-day window) — manager sessions (report limit 120/min/user)
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
  await scenario("sales_reports", async (rec) => {
    const rs = ["DAILY_SALES", "ITEM_SALES", "CATEGORY_SALES", "ORDERS"];
    await pool(c(8), Array.from({ length: n(160) }, (_, i) => i), async (i) => {
      const s = managers[i % managers.length];
      const r = await http("GET", `/api/reports/${rs[i % rs.length]}?outletId=${outletId}&from=${from}&to=${to}`, { cookie: s.cookie, ip: s.ip });
      rec.add(rs[i % rs.length], r, [200]);
    });
  });
  await scenario("analytics", async (rec) => {
    const ms = ["dashboard", "sales-summary", "daily-sales", "items", "payments", "categories", "food-cost", "inventory-value", "day-parts"];
    await pool(c(8), Array.from({ length: n(180) }, (_, i) => i), async (i) => {
      const s = managers[i % managers.length];
      const r = await http("GET", `/api/analytics/${ms[i % ms.length]}?outletId=${outletId}&from=${from}&to=${to}`, { cookie: s.cookie, ip: s.ip });
      rec.add(ms[i % ms.length], r, [200]);
    });
  });

  // 11 + 12. Procurement: GRN (stock in) -> post -> purchase bill -> vendor payment
  if (fx.vendorId && fx.materials.length) {
    await scenario("procurement_vendor_payment", async (rec) => {
      await pool(c(5), Array.from({ length: n(40) }, (_, i) => i), async (i) => {
        const s = managers[i % managers.length];
        const lines = fx.materials.map((m) => ({ materialId: m, qty: 5, rate: 40 }));
        const g = await http("POST", "/api/procurement/grns", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-grn-${randomUUID()}` }, body: { outletId, vendorId: fx.vendorId, lines } });
        rec.add("grn", g, [200]);
        if (g.status !== 200) return;
        const p = await http("POST", `/api/procurement/grns/${g.data.data.id}/post`, { cookie: s.cookie, ip: s.ip, body: {} });
        rec.add("grn_post", p, [200]);
        const b = await http("POST", "/api/procurement/bills", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-bill-${randomUUID()}` }, body: { outletId, vendorId: fx.vendorId, grnId: g.data.data.id, vendorInvoiceNo: `LD-${randomUUID().slice(0, 10)}`, lines } });
        rec.add("bill", b, [200]);
        if (b.status !== 200) return;
        const v = await http("POST", "/api/procurement/vendor-payments", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-vp-${randomUUID()}` }, body: { outletId, vendorId: fx.vendorId, billId: b.data.data.id, amount: Number(b.data.data.total), method: "BANK" } });
        rec.add("vendor_pay", v, [200]);
      });
    });
  }

  // 13. Peak-hour mix for a fixed duration
  const peakSecs = Number(args.peak ?? 60);
  await scenario(`peak_mix_${peakSecs}s`, async (rec) => {
    const end = Date.now() + peakSecs * 1000;
    let k = 0;
    await Promise.all(Array.from({ length: c(24) }, async (_, w) => {
      while (Date.now() < end) {
        const i = k++;
        const roll = i % 10;
        const s = cashiers[(w + i) % cashiers.length];
        if (roll < 7) {
          const o = await http("POST", "/api/orders", { cookie: s.cookie, ip: s.ip, headers: { "idempotency-key": `load-pk-${randomUUID()}` }, body: { outletId, channel: "DINE_IN", submit: true, customerId: fx.customers[i % fx.customers.length], items: [{ menuItemId: item(i), qty: 1 }, { menuItemId: item(i + 3), qty: 2 }] } });
          rec.add("order", o, [200]);
          if (o.status !== 200) continue;
          const c = await http("POST", "/api/payments", { cookie: s.cookie, ip: s.ip, body: { orderId: o.data.data.id, method: i % 2 ? "UPI" : "CASH", amount: Number(o.data.data.total) } });
          rec.add("pay", c, [200]);
          if (c.status === 200) rec.add("verify", await http("POST", `/api/payments/${c.data.data.id}/verify`, { cookie: s.cookie, ip: s.ip, body: {} }), [200]);
        } else if (roll === 7) {
          rec.add("kds", await http("GET", `/api/kitchen/kots?outletId=${outletId}`, { cookie: managers[0].cookie, ip: managers[0].ip, headers: { "x-aharos-background": "1" } }), [200]);
        } else if (roll === 8) {
          const m = managers[i % managers.length];
          rec.add("analytics", await http("GET", `/api/analytics/dashboard?outletId=${outletId}`, { cookie: m.cookie, ip: m.ip }), [200]);
        } else {
          rec.add("orders_list", await http("GET", `/api/orders?outletId=${outletId}&take=50`, { cookie: s.cookie, ip: s.ip, headers: { "x-aharos-background": "1" } }), [200]);
        }
      }
    }));
  });

  // ---------------- outbox drain + correctness ----------------
  const t0 = Date.now();
  let backlog;
  for (;;) {
    const [[pd, pq]] = await psql(DB, `SELECT (SELECT count(*) FROM "IntegrationDelivery" WHERE status = 'PENDING'), (SELECT count(*) FROM "PrintJob" WHERE status = 'QUEUED')`);
    backlog = { pendingDeliveries: +pd, queuedPrints: +pq };
    if ((!+pd && !+pq) || Date.now() - t0 > 60000) break;
    await sleep(500);
  }
  const outbox = Object.fromEntries((await psql(DB, `SELECT kind || ':' || status, count(*) FROM "IntegrationDelivery" GROUP BY 1 ORDER BY 1`)).map(([k, v]) => [k, +v]));
  const prints = Object.fromEntries((await psql(DB, `SELECT kind || ':' || status, count(*) FROM "PrintJob" GROUP BY 1 ORDER BY 1`)).map(([k, v]) => [k, +v]));
  const checks = {
    overpaidOrders: +(await psql(DB, `SELECT count(*) FROM "Order" o JOIN (SELECT "orderId", sum(amount) s FROM "Payment" WHERE status IN ('SUCCESS','PARTIAL','REFUNDED') GROUP BY 1) p ON p."orderId" = o.id WHERE p.s > o.total`))[0][0],
    raceOrdersWithMoreThanOneSuccess: +(await psql(DB, `SELECT count(*) FROM (SELECT "orderId" FROM "Payment" WHERE status = 'SUCCESS' AND "orderId" IN (${raceOrders.map((o) => `'${o.id}'`).join(",") || "''"}) GROUP BY 1 HAVING count(*) > 1) x`))[0][0],
    raceOrdersPaid: +(await psql(DB, `SELECT count(*) FROM "Order" WHERE status = 'PAID' AND id IN (${raceOrders.map((o) => `'${o.id}'`).join(",") || "''"})`))[0][0],
    raceOrders: raceOrders.length,
    duplicateKeysWithMoreThanOneOrder: +(await psql(DB, `SELECT count(*) FROM (SELECT "idempotencyKey" FROM "Order" WHERE "idempotencyKey" IN (${dupKeys.map((k) => `'${k}'`).join(",") || "''"}) GROUP BY 1 HAVING count(*) > 1) x`).catch(() => [["n/a"]]))[0][0],
    webhookPaymentsSucceeded: +(await psql(DB, `SELECT count(*) FROM "Payment" WHERE "providerRef" IN (${hookOrders.map((h) => `'${h.ref}'`).join(",") || "''"}) AND status = 'SUCCESS'`))[0][0],
    webhookPayments: hookOrders.length,
    webhookEventsProcessed: +(await psql(DB, `SELECT count(*) FROM "WebhookEvent" WHERE "eventId" LIKE '%load-ev-%' AND status = 'PROCESSED'`))[0][0],
    paidOrdersWithoutConsumption: +(await psql(DB, `SELECT count(*) FROM "Order" o WHERE o.status = 'PAID' AND o."outletId" = '${outletId}' AND o."createdAt" > now() - interval '2 hours' AND EXISTS (SELECT 1 FROM "OrderItem" i JOIN "Recipe" r ON r."menuItemId" = i."menuItemId" WHERE i."orderId" = o.id) AND NOT EXISTS (SELECT 1 FROM "InventoryLedger" l WHERE l."sourceRef" LIKE 'order:' || o.id || ':%')`).catch(() => [["n/a"]]))[0][0],
  };
  const top = (await psql(DB, `SELECT calls, round(total_exec_time)::int, round(mean_exec_time::numeric, 2), round(max_exec_time::numeric, 1), rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY total_exec_time DESC LIMIT 15`).catch(() => [])).map(([calls, total, mean, max, rows, q]) => ({ calls: +calls, totalMs: +total, meanMs: +mean, maxMs: +max, rows: +rows, query: q }));
  const report = { at: new Date().toISOString(), base: BASE, scale: SCALE, concurrency: CONC, scenarios: results, outbox: { drainMs: Date.now() - t0, backlogAfter: backlog, deliveries: outbox, prints }, correctness: checks, topStatements: top };
  console.log("\noutbox:", JSON.stringify(report.outbox));
  console.log("correctness:", JSON.stringify(checks));
  console.log("top statements by total time:");
  for (const t of top.slice(0, 10)) console.log(`  ${String(t.totalMs).padStart(7)}ms total  ${String(t.calls).padStart(6)} calls  mean ${t.meanMs}ms  max ${t.maxMs}ms  ${t.query}`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("load test failed:", e);
  process.exit(1);
});
