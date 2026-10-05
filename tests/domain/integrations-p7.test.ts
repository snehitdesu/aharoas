/**
 * Phase 7 integrations against the real services and database:
 *  - Razorpay (SANDBOX contract, fake Razorpay over fetch): guest checkout for the
 *    SERVER amount, tampered checkout refused, capture → PAID once (one invoice,
 *    one consumption), webhook capture / duplicate / bad signature / wrong account /
 *    amount mismatch, gateway refunds deduped with refund webhooks, provider down
 *    during checkout leaves a resumable PENDING payment
 *  - printing + cash drawer against a real TCP endpoint (raw ESC/POS): receipt,
 *    KOT routing + auto-print, first print once, audited reprint, printer down →
 *    FAILED → bounded retry, SSRF-safe addresses, RBAC, drawer kick after a cash sale
 *    that never touches the money records
 *  - customer messaging (MOCK + Twilio contract): opt-in, one per event, masked
 *    destination, failure/retry, status callback signature, no secret leakage
 *  - aggregator cancellation / status push / modifiers
 *  - accounting export: balanced vouchers, no duplicates, reversals, reconciliation
 *  - integration management: RBAC, secrets write-only, health, tenant isolation
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import { createHmac } from "node:crypto";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createMenuItem } from "@/server/services/menu";
import { rotateTableQr } from "@/server/services/masterData";
import { placeGuestOrder, startGuestPayment, confirmGuestPayment } from "@/server/services/guestOrdering";
import { receiveWebhook } from "@/server/services/webhooks";
import { upsertIntegration, listIntegrations, testConnection, integrationAudit } from "@/server/services/integrations";
import { createPrinter, updatePrinter, printReceipt, printKot, autoPrintKots, retryPrintJob, kickCashDrawer, listPrinters, testPrint, printerStatus } from "@/server/services/printing";
import { queueOrderMessage, listDeliveries, handleMessagingStatus, deliverMessage } from "@/server/services/messaging";
import { exportAccounting, accountingBatch } from "@/server/services/accounting";
import { createExpense, voidExpense } from "@/server/services/finance";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { signAggregatorPayload } from "@/integrations/aggregator";
import { isBalanced, type Voucher } from "@/integrations/accounting";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, A: string, B: string, foreignOrg: string;
let sys: AccessContext, owner: AccessContext, manager: AccessContext, cashier: AccessContext, kitchen: AccessContext, foreign: AccessContext;
let dosa: string, tea: string;
let n = 0;
const key = () => `p7-${RUN}-${++n}-key`;
const member = (id: string, role: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

// ---------------- fake Razorpay + Twilio over fetch ----------------
const KEY_ID = "rzp_test_P7KEY0001";
const KEY_SECRET = "p7-key-secret-0123456789abcdef";
const RZP_WH = "p7-razorpay-webhook-secret-0001";
type RzpOrder = { id: string; amount: number; amount_paid: number; status: string; payments: Array<{ id: string; amount: number; status: string }> };
const rzp = { orders: new Map<string, RzpOrder>(), down: false, ordersDown: false, refunds: [] as Array<{ id: string; payment: string; amount: number }>, seq: 0 };
const twilio = { sent: [] as URLSearchParams[], fail: false };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  if (url.startsWith("https://api.twilio.com/")) {
    if (twilio.fail) return json({ message: "Service unavailable" }, 503);
    if (url.endsWith("/Messages.json")) {
      const p = new URLSearchParams(String(init.body));
      twilio.sent.push(p);
      return json({ sid: `SM${String(twilio.sent.length).padStart(32, "0")}`, status: "queued" }, 201);
    }
    return json({ sid: "AC" });
  }
  if (!url.startsWith("https://api.razorpay.com/v1")) return json({}, 404);
  const path = url.slice("https://api.razorpay.com/v1".length).split("?")[0];
  if (rzp.down) return json({ error: { description: "down" } }, 503);
  if (method === "POST" && path === "/orders") {
    if (rzp.ordersDown) return json({ error: { description: "temporarily unavailable" } }, 503);
    const b = JSON.parse(String(init.body)) as { amount: number };
    const o: RzpOrder = { id: `order_${RUN}${++rzp.seq}`, amount: b.amount, amount_paid: 0, status: "created", payments: [] };
    rzp.orders.set(o.id, o);
    return json({ id: o.id, amount: o.amount, amount_paid: 0, status: "created" });
  }
  let m = /^\/orders\/([^/]+)$/.exec(path);
  if (m && rzp.orders.has(m[1])) { const o = rzp.orders.get(m[1])!; return json({ id: o.id, amount: o.amount, amount_paid: o.amount_paid, status: o.status }); }
  m = /^\/orders\/([^/]+)\/payments$/.exec(path);
  if (m && rzp.orders.has(m[1])) return json({ items: rzp.orders.get(m[1])!.payments.map((p) => ({ ...p, order_id: m![1] })) });
  m = /^\/payments\/([^/]+)$/.exec(path);
  if (m && method === "GET") {
    for (const o of rzp.orders.values()) { const p = o.payments.find((x) => x.id === m![1]); if (p) return json({ ...p, order_id: o.id, notes: {} }); }
    return json({ error: { description: "no such payment" } }, 400);
  }
  m = /^\/payments\/([^/]+)\/refund$/.exec(path);
  if (m && method === "POST") { const b = JSON.parse(String(init.body)) as { amount: number }; const r = { id: `rfnd_${RUN}${++rzp.seq}`, payment: m[1], amount: b.amount }; rzp.refunds.push(r); return json({ id: r.id, amount: r.amount }); }
  if (path === "/payments") return json({ items: [] });
  return json({ error: { description: "not found" } }, 404);
}
/** The guest pays on Razorpay's page: the order is captured there. */
function captureAtRazorpay(orderId: string) {
  const o = rzp.orders.get(orderId)!;
  const p = { id: `pay_${RUN}${++rzp.seq}`, amount: o.amount, status: "captured" };
  o.payments.push(p);
  o.status = "paid";
  o.amount_paid = o.amount;
  return { razorpay_payment_id: p.id, razorpay_order_id: o.id, razorpay_signature: createHmac("sha256", KEY_SECRET).update(`${o.id}|${p.id}`).digest("hex") };
}
const rzpWebhook = (event: string, order: RzpOrder, extra: Record<string, unknown> = {}) => {
  const pay = order.payments[0] ?? { id: `pay_${RUN}x`, amount: order.amount, status: "captured" };
  return JSON.stringify({ entity: "event", account_id: `acc_${RUN}`, event, payload: { payment: { entity: { ...pay, order_id: order.id } }, ...extra } });
};
const signed = (body: string, secret = RZP_WH) => createHmac("sha256", secret).update(body).digest("hex");

// ---------------- local "network printer" ----------------
let printerServer: net.Server | null = null;
let printerPort = 0;
const received: Buffer[] = [];
function startPrinter(port = 0) {
  return new Promise<number>((resolve) => {
    printerServer = net.createServer((s) => { const chunks: Buffer[] = []; s.on("data", (d) => chunks.push(d)); s.on("end", () => received.push(Buffer.concat(chunks))); });
    printerServer.listen(port, "127.0.0.1", () => resolve((printerServer!.address() as net.AddressInfo).port));
  });
}
const stopPrinter = () => new Promise<void>((r) => (printerServer ? printerServer.close(() => r()) : r()));

const envBefore = { ...process.env };
beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  Object.assign(process.env, { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: "deployment-wide-not-used-0001", PRINTER_ALLOW_LOOPBACK: "true" });
  printerPort = await startPrinter();
  process.env.PRINTER_EXTRA_PORTS = String(printerPort);
  orgId = (await prisma.organization.create({ data: { name: `P7 Org ${RUN}`, legalName: "P7 Foods" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P7A${RUN}`, name: "P7 A", gstin: "36ABCDE1234F1Z1", invoiceSeries: `P7A${RUN.slice(-3)}` } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P7B${RUN}`, name: "P7 B" } })).id;
  sys = systemContext(orgId, [A, B]);
  owner = { ...systemContext(orgId, [A, B]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  manager = member(`mgr-${RUN}`, "MANAGER", A);
  cashier = member(`cash-${RUN}`, "CASHIER", A);
  kitchen = member(`kit-${RUN}`, "KITCHEN", A);
  foreignOrg = (await prisma.organization.create({ data: { name: `P7 Foreign ${RUN}` } })).id;
  foreign = { ...systemContext(foreignOrg, [(await prisma.outlet.create({ data: { organizationId: foreignOrg, code: `P7F${RUN}`, name: "F" } })).id]), userId: `fowner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: A, name: "KITCHEN", kind: "KITCHEN" } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5, station: "KITCHEN" })).id;
  tea = (await createMenuItem(sys, { name: `Tea ${RUN}`, price: 20, taxPct: 5, station: "KITCHEN" })).id;
});

afterAll(async () => {
  await settleAfterCommit();
  await stopPrinter();
  vi.unstubAllGlobals();
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "PRINTER_ALLOW_LOOPBACK", "PRINTER_EXTRA_PORTS", "PAYMENT_PROVIDER"]) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
  await prisma.$disconnect();
});

async function guestTableToken(code: string) {
  const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: A, code: `${code}-${RUN}` } });
  return (await rotateTableQr(sys, t.id)).qrToken!;
}

describe("payment gateway — Razorpay (SANDBOX contract)", () => {
  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = "razorpay";
    await upsertIntegration(owner, { kind: "PAYMENT", provider: "razorpay", externalRef: `acc_${RUN}`, webhookSecret: RZP_WH, mode: "SANDBOX" });
  });
  afterAll(() => {
    if (envBefore.PAYMENT_PROVIDER === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = envBefore.PAYMENT_PROVIDER;
  });

  it("guest checkout uses the server's amount; a tampered checkout is refused; capture settles once", async () => {
    const placed = await placeGuestOrder(await guestTableToken("G1"), { items: [{ menuItemId: dosa, qty: 2 }] }, key());
    const k = key();
    const start = await startGuestPayment(placed.orderId, placed.accessKey, k);
    expect(start).toMatchObject({ provider: "razorpay", mode: "SANDBOX", amount: "210.00", checkout: { keyId: KEY_ID, amount: 21000 } });
    const orderRef = String(start.checkout!.orderId);
    expect((await startGuestPayment(placed.orderId, placed.accessKey, k)).checkout?.orderId ?? (await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).providerRef).toBe(orderRef); // no second gateway order
    expect([...rzp.orders.values()].filter((o) => o.id === orderRef)).toHaveLength(1);

    const real = captureAtRazorpay(orderRef);
    const forged = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: { ...real, razorpay_signature: "0".repeat(64) } });
    expect(forged).toMatchObject({ paymentStatus: "FAILED", status: "OPEN" });

    const retry = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const ref2 = String(retry.checkout!.orderId);
    const done = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: retry.paymentId, gateway: captureAtRazorpay(ref2) });
    expect(done).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID" });
    expect(await prisma.taxInvoice.count({ where: { orderId: placed.orderId, kind: "INVOICE" } })).toBe(1);
    // Re-confirming the same capture changes nothing.
    await expect(confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: retry.paymentId, gateway: { razorpay_payment_id: "x", razorpay_order_id: ref2, razorpay_signature: "y" } })).resolves.toMatchObject({ status: "PAID" });
    expect(await prisma.payment.count({ where: { orderId: placed.orderId, status: "SUCCESS" } })).toBe(1);
  });

  it("webhook capture settles a payment once; duplicate, bad signature, other account and wrong amount change nothing", async () => {
    const placed = await placeGuestOrder(await guestTableToken("G2"), { items: [{ menuItemId: tea, qty: 5 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const order = rzp.orders.get(String(start.checkout!.orderId))!;
    captureAtRazorpay(order.id);
    const body = rzpWebhook("payment.captured", order);
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: body, signature: signed(body, "wrong-secret-000000000") })).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("OPEN");
    const first = await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: body, signature: signed(body) });
    expect(first).toMatchObject({ status: "PROCESSED", orderId: placed.orderId });
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: body, signature: signed(body) })).toMatchObject({ status: "DUPLICATE" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("PAID");
    expect(await prisma.taxInvoice.count({ where: { orderId: placed.orderId, kind: "INVOICE" } })).toBe(1);
    const consumed = await prisma.inventoryLedger.count({ where: { sourceType: "ORDER", sourceId: placed.orderId } });
    await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: body, signature: signed(body) });
    expect(await prisma.inventoryLedger.count({ where: { sourceType: "ORDER", sourceId: placed.orderId } })).toBe(consumed);

    const other = body.replace(`acc_${RUN}`, `acc_unknown_${RUN}`);
    expect((await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: other, signature: signed(other) })).ok).toBe(false);

    const p2 = await placeGuestOrder(await guestTableToken("G3"), { items: [{ menuItemId: tea, qty: 1 }] }, key());
    const s2 = await startGuestPayment(p2.orderId, p2.accessKey, key());
    const o2 = rzp.orders.get(String(s2.checkout!.orderId))!;
    captureAtRazorpay(o2.id);
    const tampered = rzpWebhook("payment.captured", { ...o2, payments: [{ ...o2.payments[0], amount: 1 }] });
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: tampered, signature: signed(tampered) })).toMatchObject({ status: "FAILED", reason: "Amount mismatch" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p2.orderId } })).status).toBe("OPEN");
  });

  it("refunds go to Razorpay once; the gateway's refund webhook is recognized, not applied again; partial refunds add up", async () => {
    const placed = await placeGuestOrder(await guestTableToken("G4"), { items: [{ menuItemId: dosa, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: captureAtRazorpay(String(start.checkout!.orderId)) });
    const r1 = await refundPayment(sys, start.paymentId, { amount: 40, reason: "Cold", idempotencyKey: key() });
    expect(r1.refund.providerRef).toMatch(/^rfnd_/);
    expect(rzp.refunds.at(-1)).toMatchObject({ amount: 4000 });
    const order = rzp.orders.get(String(start.checkout!.orderId))!;
    const wh = rzpWebhook("refund.processed", order, { refund: { entity: { id: r1.refund.providerRef, payment_id: order.payments[0].id, amount: 4000 } } });
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: wh, signature: signed(wh) })).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.refund.count({ where: { paymentId: start.paymentId } })).toBe(1);
    await refundPayment(sys, start.paymentId, { amount: 65, reason: "Rest", idempotencyKey: key() });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("REFUNDED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("REFUNDED");
    expect(await prisma.taxInvoice.count({ where: { orderId: placed.orderId, kind: "CREDIT_NOTE" } })).toBe(2);
  });

  it("gateway unhealthy: online payment is refused before anything is created", async () => {
    const placed = await placeGuestOrder(await guestTableToken("G6"), { items: [{ menuItemId: tea, qty: 2 }] }, key());
    rzp.down = true;
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key())).rejects.toThrow(/not available/);
    rzp.down = false;
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it("gateway fails while creating the checkout: the payment stays PENDING without a reference and the next attempt resumes it", async () => {
    const placed = await placeGuestOrder(await guestTableToken("G5"), { items: [{ menuItemId: tea, qty: 2 }] }, key());
    rzp.ordersDown = true;
    const k = key();
    await expect(startGuestPayment(placed.orderId, placed.accessKey, k)).rejects.toBeTruthy();
    const pending = await prisma.payment.findMany({ where: { orderId: placed.orderId } });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "PENDING", providerRef: null });
    rzp.ordersDown = false;
    const again = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(again.paymentId).toBe(pending[0].id);
    expect(again.checkout?.orderId).toMatch(/^order_/);
  });
});

describe("printing and cash drawer (raw ESC/POS over TCP)", () => {
  let receipt: string, kotPrinter: string, simulated: string;
  beforeAll(async () => {
    receipt = (await createPrinter(manager, { outletId: A, name: `Front ${RUN}`, role: "RECEIPT", transport: "NETWORK_ESCPOS", host: "127.0.0.1", port: printerPort, cashDrawer: true })).id;
    kotPrinter = (await createPrinter(manager, { outletId: A, name: `Kitchen ${RUN}`, role: "KOT", station: "KITCHEN", transport: "NETWORK_ESCPOS", host: "127.0.0.1", port: printerPort })).id;
    simulated = (await createPrinter(manager, { outletId: B, name: `Sim ${RUN}`, role: "RECEIPT", transport: "SIMULATED" } as never).catch(() => createPrinter(sys, { outletId: B, name: `Sim ${RUN}`, role: "RECEIPT", transport: "SIMULATED" }))).id;
  });

  async function paidCashOrder(outletId = A) {
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }, { menuItemId: tea, qty: 2, notes: "less sugar" }] });
    const p = await createPayment(cashier, o.id, { method: "CASH", amount: num((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total), idempotencyKey: key() });
    await verifyPayment(cashier, p.id);
    await settleAfterCommit();
    return o.id;
  }

  it("refuses unsafe printer addresses and roles without outlet.manage", async () => {
    for (const host of ["169.254.169.254", "8.8.8.8", "printer.local", "10.0.0.5:22"]) await expect(createPrinter(manager, { outletId: A, name: `Bad ${host} ${RUN}`, role: "RECEIPT", transport: "NETWORK_ESCPOS", host, port: 9100 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPrinter(manager, { outletId: A, name: `Bad port ${RUN}`, role: "RECEIPT", transport: "NETWORK_ESCPOS", host: "192.168.1.20", port: 22 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPrinter(cashier, { outletId: A, name: `Nope ${RUN}`, role: "RECEIPT", transport: "SIMULATED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPrinter(foreign, { outletId: A, name: `X ${RUN}`, role: "RECEIPT", transport: "SIMULATED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listPrinters(prisma, member(`cap-${RUN}`, "CAPTAIN", B), A)).rejects.toBeTruthy();
    expect((await createPrinter(manager, { outletId: A, name: `LAN ${RUN}`, role: "RECEIPT", transport: "NETWORK_ESCPOS", host: "192.168.1.20", port: 9100, active: false })).host).toBe("192.168.1.20");
  });

  it("a cash sale prints its KOT automatically and kicks the drawer after the commit; the receipt prints once, reprints are audited", async () => {
    const before = received.length;
    const orderId = await paidCashOrder();
    const jobs = await prisma.printJob.findMany({ where: { organizationId: orgId, OR: [{ sourceId: orderId }, { kind: "DRAWER" }] } });
    expect(jobs.filter((j) => j.kind === "DRAWER" && j.status === "PRINTED").length).toBeGreaterThanOrEqual(1);
    const kotJobs = await prisma.printJob.findMany({ where: { kind: "KOT", printerId: kotPrinter, status: "PRINTED" } });
    expect(kotJobs.length).toBeGreaterThanOrEqual(1);
    const kotBytes = received.slice(before).map((b) => b.toString("latin1")).find((t) => t.includes("KOT "))!;
    expect(kotBytes).toContain("less sugar");
    expect(received.slice(before).some((b) => b.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])))).toBe(true); // drawer kick

    const first = await printReceipt(cashier, orderId);
    expect(first).toMatchObject({ status: "PRINTED", duplicate: false });
    const text = received.at(-1)!.toString("latin1");
    expect(text).toContain("TOTAL");
    expect(text).toContain("Rs.");
    expect(received.at(-1)!.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true); // cut
    const count = received.length;
    expect(await printReceipt(cashier, orderId)).toMatchObject({ id: first.id, duplicate: true });
    expect(received.length).toBe(count); // not printed again
    await expect(printReceipt(cashier, orderId, { reprint: true })).rejects.toBeInstanceOf(ZodError);
    const again = await printReceipt(cashier, orderId, { reprint: true, reason: "Guest asked for a copy" });
    expect(again).toMatchObject({ status: "PRINTED", duplicate: false, reason: "Guest asked for a copy" });
    expect(received.at(-1)!.toString("latin1")).toContain("REPRINT");
    expect(await prisma.auditLog.count({ where: { entityType: "PrintJob", entityId: again.id, action: "PRINT" } })).toBe(1);
    // KOT auto-print never repeats; reprint of a KOT is explicit.
    expect(await autoPrintKots(cashier, orderId)).toBe(0);
    const kot = await prisma.kot.findFirstOrThrow({ where: { orderId } });
    expect((await printKot(cashier, kot.id))[0]).toMatchObject({ duplicate: true });
    expect((await printKot(kitchen, kot.id, { reprint: true, reason: "Ticket lost" }))[0]).toMatchObject({ status: "PRINTED", reason: "Ticket lost" });
  });

  it("printer down: the payment still settles, the job FAILS, a retry prints it, attempts are bounded", async () => {
    await stopPrinter();
    const orderId = await paidCashOrder();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PAID"); // hardware never affects the sale
    const drawer = await prisma.printJob.findFirstOrThrow({ where: { kind: "DRAWER", status: "FAILED" }, orderBy: { createdAt: "desc" } });
    expect(drawer.lastError).toMatch(/refused|unreachable|connection/i);
    const r = await printReceipt(cashier, orderId);
    expect(r).toMatchObject({ status: "FAILED" });
    expect((await prisma.printer.findUniqueOrThrow({ where: { id: receipt } })).lastStatus).toBe("OFFLINE");
    expect((await printerStatus(manager, receipt)).lastStatus).toBe("OFFLINE");
    await startPrinter(printerPort);
    expect(await retryPrintJob(cashier, r.id)).toMatchObject({ status: "PRINTED", attempts: 2 });
    await expect(retryPrintJob(cashier, r.id)).rejects.toThrow(/Only failed jobs/);
    await prisma.printJob.update({ where: { id: drawer.id }, data: { attempts: 5 } });
    await expect(retryPrintJob(cashier, drawer.id)).rejects.toThrow(/Gave up after 5/);
    await expect(retryPrintJob(kitchen, drawer.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("drawer kick needs payment.take; no drawer = no-op; a simulated printer is never 'printed'", async () => {
    await expect(kickCashDrawer(kitchen, { outletId: A, reason: "open please" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await kickCashDrawer(sys, { outletId: B, reason: "No drawer here" })).toMatchObject({ kicked: false });
    const k = await kickCashDrawer(cashier, { outletId: A, reason: "Change for a guest" });
    expect(k).toMatchObject({ kicked: true, simulated: false });
    const t = await testPrint(sys, simulated);
    expect(t.status).toBe("SIMULATED");
    await updatePrinter(sys, simulated, { active: false });
    expect((await listPrinters(prisma, sys, B)).find((p) => p.id === simulated)).toMatchObject({ active: false, mode: "MOCK" });
  });
});

describe("customer messaging", () => {
  async function orderWithCustomer(phone: string | null) {
    const cust = phone ? await prisma.customer.create({ data: { organizationId: orgId, name: "Guest", phone } }) : null;
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, customerId: cust?.id, items: [{ menuItemId: tea, qty: 1 }] });
    return o.id;
  }

  it("nothing is sent until a provider is connected and the message type is enabled; then once per event, masked", async () => {
    const orderId = await orderWithCustomer("9876543210");
    expect(await queueOrderMessage(sys, { template: "PAYMENT_RECEIVED", orderId, auto: true })).toMatchObject({ status: "SKIPPED", reason: "Messaging is not connected" });
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", config: { channel: "SMS", templates: { PAYMENT_RECEIVED: true } } });
    expect(await queueOrderMessage(sys, { template: "ORDER_READY", orderId, auto: true })).toMatchObject({ status: "SKIPPED" });
    const p = await createPayment(sys, orderId, { method: "UPI", amount: 21, idempotencyKey: key() });
    await verifyPayment(sys, p.id);
    await settleAfterCommit();
    const sent = (await listDeliveries(prisma, owner, { kind: "MESSAGE" })).filter((d) => d.sourceId === orderId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "SENT", mode: "MOCK", provider: "mock", target: "+91******3210" });
    expect(await queueOrderMessage(sys, { template: "PAYMENT_RECEIVED", orderId, auto: true })).toMatchObject({ status: "DUPLICATE" });
    expect(await queueOrderMessage(sys, { template: "ORDER_READY", orderId: await orderWithCustomer(null) })).toMatchObject({ status: "SKIPPED", reason: "The order has no customer mobile number" });
    await expect(listDeliveries(prisma, manager)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Twilio: send, provider failure → FAILED with backoff → retry; status callbacks are signature-checked and only move forward; no secret leaks", async () => {
    const token = "twilio-auth-token-value-12345678";
    const sid = `AC${"a".repeat(32)}`;
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", status: "DISCONNECTED" });
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "twilio", mode: "SANDBOX", credentials: { accountSid: sid, authToken: token, smsFrom: "+15005550006" }, config: { channel: "SMS", templates: {} } });
    const orderId = await orderWithCustomer("9123456789");
    twilio.fail = true;
    const q = await queueOrderMessage(sys, { template: "ORDER_READY", orderId });
    const failed = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: q.deliveryId! } });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1, mode: "SANDBOX" });
    expect(failed.nextAttemptAt).not.toBeNull();
    twilio.fail = false;
    const ok = await deliverMessage(sys, failed.id);
    expect(ok).toMatchObject({ status: "SENT", attempts: 2 });
    expect(twilio.sent.at(-1)!.get("To")).toBe("+919123456789");
    expect(twilio.sent.at(-1)!.get("Body")).toContain("is ready");
    const params = { MessageSid: ok.providerRef!, MessageStatus: "delivered" };
    const url = "https://restora.example/api/webhooks/messaging/twilio";
    const good = createHmac("sha1", token).update(url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("")).digest("base64");
    expect(await handleMessagingStatus(prisma, "twilio", url, params, "bad")).toMatchObject({ httpStatus: 401 });
    expect(await handleMessagingStatus(prisma, "twilio", url, params, good)).toMatchObject({ status: "PROCESSED" });
    expect(await handleMessagingStatus(prisma, "twilio", url, params, good)).toMatchObject({ status: "DUPLICATE" });
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("DELIVERED");
    expect(await handleMessagingStatus(prisma, "twilio", url, { MessageSid: "SMunknown", MessageStatus: "delivered" }, good)).toMatchObject({ httpStatus: 404 });
    const everything = JSON.stringify([await listIntegrations(prisma, owner), await integrationAudit(prisma, owner), await listDeliveries(prisma, owner)]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("9123456789");
  });
});

describe("aggregator orders", () => {
  const AGG_SECRET = "p7-aggregator-secret-000001";
  beforeAll(async () => {
    await prisma.aggregator.create({ data: { organizationId: orgId, name: "MOCK", commissionPct: 20 } });
    await upsertIntegration(owner, { kind: "AGGREGATOR", provider: "mock", outletId: A, externalRef: `store_${RUN}`, webhookSecret: AGG_SECRET });
  });
  const send = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    return receiveWebhook({ kind: "AGGREGATOR", provider: "mock", rawBody: raw, signature: signAggregatorPayload(raw, AGG_SECRET) });
  };

  it("modifiers are part of the line; a cancellation refunds the platform's payment once; unknown / other-outlet cancellations change nothing", async () => {
    const placed = await send({ eventId: `e1-${RUN}`, externalId: `X1-${RUN}`, storeId: `store_${RUN}`, items: [{ posItemCode: "BURGER", name: "Burger", qty: 2, unitPrice: 100, modifiers: [{ name: "Cheese", priceDelta: 15 }] }] });
    expect(placed.status).toBe("PROCESSED");
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(num(line.lineTotal)).toBe(230);
    expect(num((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).subtotal)).toBe(230);
    expect(await send({ eventId: `c0-${RUN}`, event: "order.cancelled", externalId: `NOPE-${RUN}`, storeId: `store_${RUN}` })).toMatchObject({ status: "FAILED", reason: "Unknown order" });
    expect(await send({ eventId: `c1-${RUN}`, event: "order.cancelled", externalId: `X1-${RUN}`, storeId: `store_${RUN}`, outletId: B })).toMatchObject({ status: "REJECTED" });
    const cancel = { eventId: `c2-${RUN}`, event: "order.cancelled", externalId: `X1-${RUN}`, storeId: `store_${RUN}`, reason: "Customer cancelled" };
    expect(await send(cancel)).toMatchObject({ status: "PROCESSED", orderId: placed.orderId });
    expect(await send(cancel)).toMatchObject({ status: "DUPLICATE" });
    expect(await send({ ...cancel, eventId: `c3-${RUN}` })).toMatchObject({ status: "DUPLICATE" }); // already closed
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("REFUNDED");
    expect(await prisma.refund.count({ where: { payment: { orderId: placed.orderId } } })).toBe(1);
    expect(num((await prisma.aggregatorOrder.findFirstOrThrow({ where: { orderId: placed.orderId } })).netPayout)).toBe(0);
    expect(await send({ eventId: `u-${RUN}`, event: "menu.updated", storeId: `store_${RUN}` })).toMatchObject({ status: "IGNORED" });
  });

  it("order ready is reported to the platform through the outbox, once (MOCK adapter)", async () => {
    const { pushAggregatorStatus } = await import("@/server/services/aggregatorSync");
    const placed = await send({ eventId: `e2-${RUN}`, externalId: `X2-${RUN}`, storeId: `store_${RUN}`, items: [{ posItemCode: "TEA", name: "Tea", qty: 1, unitPrice: 20 }] });
    const d1 = await pushAggregatorStatus(sys, placed.orderId!, "READY");
    expect(d1).toMatchObject({ status: "SENT", mode: "MOCK", kind: "AGGREGATOR_STATUS" });
    const d2 = await pushAggregatorStatus(sys, placed.orderId!, "READY");
    expect(d2!.id).toBe(d1!.id);
  });
});

describe("accounting export", () => {
  it("balanced vouchers from the books, exported once; a later void exports only its reversal; reconciliation matches", async () => {
    const from = new Date(Date.now() - 2 * 86400000);
    const to = new Date(Date.now() + 86400000);
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }] });
    const p = await createPayment(sys, o.id, { method: "CASH", amount: 105, idempotencyKey: key() });
    await verifyPayment(sys, p.id);
    const exp = await createExpense(sys, { outletId: A, category: "GAS", amount: 250, paidVia: "BANK" });
    await expect(exportAccounting(kitchen, { format: "generic", outletId: A, from, to })).rejects.toBeInstanceOf(ForbiddenError);
    const first = await exportAccounting(sys, { format: "generic", outletId: A, from, to });
    expect(first.empty).toBe(false);
    if (first.empty) return;
    const rows = await prisma.integrationDelivery.findMany({ where: { organizationId: orgId, batchId: first.batchId } });
    const vouchers = rows.map((r) => JSON.parse(r.payload) as Voucher);
    expect(vouchers.every(isBalanced)).toBe(true);
    expect(vouchers.some((v) => v.sourceKey === `exp:${exp.id}`)).toBe(true);
    expect(vouchers.some((v) => v.type === "SALES" && v.sourceKey.startsWith("inv:"))).toBe(true);
    expect(first.file.split("\r\n")[0]).toBe("Date,Voucher Type,Voucher No,Ledger,Debit,Credit,Party,Narration,Source");
    expect(first.reconciliation!.every((c) => c.matches)).toBe(true);
    expect((await accountingBatch(sys, first.batchId)).checksum).toBe(first.checksum); // byte-identical re-download

    const second = await exportAccounting(sys, { format: "generic", outletId: A, from, to });
    expect(second).toMatchObject({ empty: true });
    await voidExpense(sys, exp.id, "Entered twice");
    const third = await exportAccounting(sys, { format: "generic", outletId: A, from, to });
    expect(third.empty).toBe(false);
    if (third.empty) return;
    expect(third.vouchers).toBe(1);
    expect(third.file).toContain("EXPENSE_VOID");
    const tally = await exportAccounting(sys, { format: "tally", outletId: A, from, to });
    expect(tally.empty).toBe(false);
    if (tally.empty) return;
    expect(tally.file).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><ENVELOPE>/);
    expect(tally.file).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create">');
    expect(tally.file).not.toContain(`exp:${exp.id}]`); // voided before the first Tally export: never exported to Tally
    // Another tenant sees none of it.
    const f = await exportAccounting(foreign, { format: "generic", from, to });
    expect(f).toMatchObject({ empty: true });
  });
});

describe("integration management", () => {
  it("only integration.manage; mocks cannot be LIVE; secrets are write-only; health is recorded; tenants are isolated", async () => {
    await expect(listIntegrations(prisma, manager)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertIntegration(manager, { kind: "MESSAGING", provider: "mock" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", mode: "LIVE" })).rejects.toThrow(/cannot be LIVE/);
    await expect(upsertIntegration(owner, { kind: "MESSAGING", provider: "carrier-pigeon" })).rejects.toThrow(/Unsupported messaging provider/);
    await expect(upsertIntegration(owner, { kind: "MESSAGING", provider: "twilio", credentials: { accountSid: "nope", authToken: "x" } })).rejects.toThrow(/Invalid Twilio credentials/);
    const list = await listIntegrations(prisma, owner);
    const pay = list.find((c) => c.kind === "PAYMENT" && c.provider === "razorpay")!;
    expect(pay).toMatchObject({ mode: "SANDBOX", hasWebhookSecret: true });
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${RZP_WH}|webhookSecretEnc|credentialsEnc`));
    const tested = await testConnection(owner, pay.id);
    expect(tested.lastCheckedAt).not.toBeNull();
    await expect(testConnection(foreign, pay.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(upsertIntegration(foreign, { kind: "PAYMENT", provider: "razorpay", externalRef: `acc_${RUN}` })).rejects.toThrow(/already connected elsewhere/);
    const audit = await integrationAudit(prisma, owner);
    expect(audit.some((a) => a.entityType === "IntegrationConnection")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(RZP_WH);
  });
});
