#!/usr/bin/env node
// Post-deploy / post-restore smoke test against a RUNNING RESTORA server.
//
//   SMOKE_BASE=https://pos.example.com SMOKE_EMAIL=owner@example.com \
//   SMOKE_PASSWORD=... node scripts/ops/smoke-test.mjs [--write] [--outlet <id>]
//
// Read-only by default: health + readiness, sign-in, session, dashboard data
// (menu, open orders, kitchen tickets, stock, notifications, one report),
// sign-out (and that the session is really gone).
// --write additionally runs ONE real transaction end to end: a takeaway order
// with the first two active menu items -> KOT -> KDS sees it -> cash payment ->
// verify -> PAID with an invoice number -> bill renders. Use --write only where
// a test order is acceptable (staging, a restored copy, or production with a
// manager who will void/refund it). The order is tagged "SMOKE TEST" in notes.
//
// Exit 0 only if every step passed. The password is read from the environment
// only and never printed. Plain Node 20+ (no app imports).
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : null)).filter(Boolean));
const BASE = (process.env.SMOKE_BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const WRITE = Boolean(args.write);
if (!EMAIL || !PASSWORD) {
  console.error("set SMOKE_EMAIL and SMOKE_PASSWORD (and SMOKE_BASE)");
  process.exit(2);
}

let cookie = "";
const results = [];
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Math.round(performance.now() - t0)} ms${detail ? `; ${detail}` : ""})`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  (${String(e?.message ?? e).slice(0, 300)})`);
    throw e;
  }
}
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { origin: BASE } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers, text };
}
const expectOk = (r, what) => {
  if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${r.data?.error?.code ?? ""} ${r.data?.error?.message ?? ""}`.trim());
  return r.data?.data ?? r.data;
};

async function main() {
  console.log(`RESTORA smoke test -> ${BASE}${WRITE ? " (with one test transaction)" : " (read-only)"}`);
  await step("liveness", async () => expectOk(await call("GET", "/api/health/live"), "live") && "");
  await step("readiness (database + migrations)", async () => {
    const r = await call("GET", "/api/health/ready");
    if (r.status !== 200 || r.data?.status !== "ready") throw new Error(`ready: HTTP ${r.status} ${JSON.stringify(r.data?.checks ?? {})}`);
    return JSON.stringify(r.data.checks);
  });
  await step("security headers", async () => {
    const r = await call("GET", "/login");
    const missing = ["content-security-policy", "x-content-type-options", "referrer-policy"].filter((h) => !r.headers.get(h));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    return BASE.startsWith("https:") ? (r.headers.get("strict-transport-security") ? "HSTS on" : "no HSTS (check proxy)") : "http (HSTS n/a)";
  });
  await step("sign in", async () => {
    const r = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
    expectOk(r, "login");
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("no session cookie returned");
  });
  let me;
  await step("session (/api/auth/me)", async () => {
    me = expectOk(await call("GET", "/api/auth/me"), "me");
    return `roles ${me.access.roles?.join?.(",") ?? "?"}, outlets ${me.access.outletIds?.length ?? 0}${me.access.isOrgWide ? " (org-wide)" : ""}`;
  });
  let outletId = args.outlet;
  if (!outletId) {
    const list = expectOk(await call("GET", "/api/master/outlets"), "outlets");
    outletId = (Array.isArray(list) ? list : list.items ?? [])[0]?.id ?? me.access.outletIds?.[0];
  }
  if (!outletId) throw new Error("no outlet visible to this account (pass --outlet)");
  let menu = [];
  await step("menu", async () => {
    const m = expectOk(await call("GET", `/api/menu?outletId=${outletId}&activeOnly=true`), "menu");
    menu = (Array.isArray(m) ? m : m.items ?? []).filter((i) => i.active !== false && !i.soldOut);
    return `${menu.length} active items`;
  });
  await step("open orders (POS / dashboard)", async () => `${(expectOk(await call("GET", `/api/orders?outletId=${outletId}&active=true&take=20`), "orders").items ?? []).length} shown`);
  await step("kitchen tickets (KDS)", async () => `${expectOk(await call("GET", `/api/kitchen/kots?outletId=${outletId}`), "kots").length} live`);
  await step("stock", async () => `${expectOk(await call("GET", `/api/inventory/stock?outletId=${outletId}`), "stock").length} materials`);
  await step("notifications", async () => expectOk(await call("GET", "/api/notifications/unread-count"), "notifications") && "");
  await step("report (DAILY_SALES, last 7 days)", async () => {
    const to = new Date(), from = new Date(Date.now() - 7 * 864e5);
    const r = expectOk(await call("GET", `/api/reports/DAILY_SALES?outletId=${outletId}&from=${from.toISOString()}&to=${to.toISOString()}`), "report");
    return `${r.rowCount ?? r.rows?.length ?? "?"} rows`;
  });
  await step("integration health", async () => {
    const r = await call("GET", "/api/integrations");
    if (r.status === 403) return "skipped: this account may not manage integrations (run as the owner for this check)";
    const body = expectOk(r, "integrations") ?? {};
    const list = Array.isArray(body) ? body : body.connections ?? [];
    const broken = list.filter((c) => c.status && !["CONNECTED", "ACTIVE", "OK"].includes(c.status));
    return `${list.length} connections${broken.length ? `, ${broken.length} not connected: ${broken.map((c) => `${c.kind}/${c.provider}=${c.status}`).join(", ")}` : ""}`;
  });

  if (WRITE) {
    if (menu.length === 0) throw new Error("no active menu item to order");
    let order, payment;
    await step("place order + send to kitchen", async () => {
      order = expectOk(await call("POST", "/api/orders", { outletId, channel: "TAKEAWAY", submit: true, notes: "SMOKE TEST", items: menu.slice(0, 2).map((m) => ({ menuItemId: m.id, qty: 1 })) }, { "idempotency-key": `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }), "place");
      if (!order.kots?.length) throw new Error("no KOT created");
      return `total ₹${order.total}, KOT ${order.kots.map((k) => k.number).join(",")}`;
    });
    await step("kitchen ticket is live (KDS)", async () => {
      const o = expectOk(await call("GET", `/api/orders/${order.id}`), "order");
      if (!o.kots?.length || !o.kots.every((k) => k.status === "NEW")) throw new Error("ticket missing or not NEW");
      const kots = expectOk(await call("GET", `/api/kitchen/kots?outletId=${outletId}`), "kots");
      const onBoard = kots.some((k) => k.orderId === order.id || k.order?.id === order.id);
      if (!onBoard && kots.length < 200) throw new Error("ticket not on the KDS board");
      return onBoard ? "on the board" : "board full (200 older live tickets) — bump/clear stale tickets";
    });
    await step("cash payment + verify -> PAID", async () => {
      payment = expectOk(await call("POST", "/api/payments", { orderId: order.id, method: "CASH", amount: Number(order.total) }), "payment");
      const v = expectOk(await call("POST", `/api/payments/${payment.id}/verify`, {}), "verify");
      if (!v.orderSettled) throw new Error("order not settled");
      const o = expectOk(await call("GET", `/api/orders/${order.id}`), "order");
      if (o.status !== "PAID") throw new Error(`status ${o.status}`);
      return `invoice ${o.invoiceNo ?? "(none)"}`;
    });
    await step("bill / receipt renders", async () => expectOk(await call("GET", `/api/orders/${order.id}/bill`), "bill") && "");
  }

  await step("sign out", async () => expectOk(await call("POST", "/api/auth/logout", {}), "logout") && "");
  await step("session is gone after sign-out", async () => {
    const r = await call("GET", "/api/auth/me");
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });
}

main()
  .then(() => {
    console.log(`\nSMOKE PASSED: ${results.length}/${results.length}`);
    process.exit(0);
  })
  .catch(() => {
    console.log(`\nSMOKE FAILED: ${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(1);
  });
