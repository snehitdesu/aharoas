/**
 * The real restaurant menu (Coders' Cafe, prisma/coders-cafe) through the
 * complete guest transaction with the Razorpay adapter:
 *
 *   table QR -> real menu -> cart -> server-priced order -> Razorpay order
 *   (server amount) -> Checkout attempt -> signed response / webhooks ->
 *   server verification with "Razorpay" -> PAID -> KOT -> kitchen -> invoice
 *   -> sales / payments analytics
 *
 * plus every failure path the gateway can produce: decline then retry inside
 * the same checkout, window closed before paying, authorized-not-captured,
 * late capture, duplicate / forged / mismatched webhooks, unknown accounts,
 * and a capture for an order that was meanwhile paid in cash.
 *
 * "Razorpay" here is tests/support/razorpayEmulator.ts (RAZORPAY_API_BASE):
 * the adapter, payment service, webhook pipeline and database are the real
 * code paths; only the gateway on the far end of HTTP is emulated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { type AccessContext } from "@/server/db/scope";
import { guestMenu, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment, resolveTable } from "@/server/services/guestOrdering";
import { submitOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { listKOTs, updateKOTStatus } from "@/server/services/kot";
import { getOrderBill } from "@/server/services/bill";
import { paymentsByMethod, salesSummary } from "@/server/services/analytics";
import { receiveWebhook } from "@/server/services/webhooks";
import { revokeTableQr } from "@/server/services/masterData";
import { num } from "@/domain/money";
import { seedCodersCafe, cafeTableToken, type CafeSeedResult } from "../../prisma/coders-cafe/seed";
import { CODERS_CAFE_MENU, menuItemCount } from "../../prisma/coders-cafe/menu";
import { RazorpayEmulator } from "../support/razorpayEmulator";
import { bindWebhook } from "./webhookBinding";

const RUN = Date.now().toString(36);
const ACCOUNT = `acc_cafe${RUN}`;
const emu = new RazorpayEmulator({ keyId: `rzp_test_cafe${RUN}`, keySecret: `cafe-secret-${RUN}`, webhookSecret: `cafe-webhook-${RUN}`, accountId: ACCOUNT });
const ENV = ["PAYMENT_PROVIDER", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_API_BASE"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

let cafe: CafeSeedResult;
let table07: string;
let manager: AccessContext, cashier: AccessContext, chef: AccessContext, owner: AccessContext;
const items = new Map<string, { id: string; variants: Map<string, string>; options: Map<string, string> }>();
let keySeq = 0;
const key = () => `cafe-${RUN}-${++keySeq}-abcdef`;

const ctxFor = async (email: string): Promise<AccessContext> => {
  const { buildAccessContext } = await import("@/server/auth/context");
  const u = await prisma.user.findFirstOrThrow({ where: { email, organizationId: cafe.organizationId } });
  return buildAccessContext(prisma, u.id);
};
const sendWebhook = (w: { rawBody: string; signature: string }) => receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: w.rawBody, signature: w.signature });
const item = (name: string) => {
  const it = items.get(name);
  if (!it) throw new Error(`not on the Coders' Cafe menu: ${name}`);
  return it;
};
/** Classic Margherita Pizza (Medium) + Make It a Cheese Melt, and 2 × Classic Fries (Large). */
const investorCart = () => ({
  items: [
    { menuItemId: item("Classic Margherita Pizza").id, variantId: item("Classic Margherita Pizza").variants.get("Medium"), modifierOptionIds: [item("Classic Margherita Pizza").options.get("Make It a Cheese Melt")!], qty: 1 },
    { menuItemId: item("Classic Fries").id, variantId: item("Classic Fries").variants.get("Large"), qty: 2 },
  ],
});
const counts = async (orderId: string) => ({
  orders: await prisma.order.count({ where: { id: orderId } }),
  success: await prisma.payment.count({ where: { orderId, status: "SUCCESS" } }),
  kots: await prisma.kot.count({ where: { orderId } }),
  invoices: await prisma.taxInvoice.count({ where: { orderId } }),
});

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  await emu.start();
  Object.assign(process.env, { PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: emu.cfg.keyId, RAZORPAY_KEY_SECRET: emu.cfg.keySecret, RAZORPAY_WEBHOOK_SECRET: emu.cfg.webhookSecret, RAZORPAY_API_BASE: emu.url });
  cafe = await seedCodersCafe(prisma, { reset: true });
  table07 = cafe.tables.find((t) => t.code === "T07")!.token;
  await bindWebhook({ kind: "PAYMENT", provider: "razorpay", organizationId: cafe.organizationId, outletId: cafe.outletId, externalRef: ACCOUNT });
  for (const i of await prisma.menuItem.findMany({ where: { organizationId: cafe.organizationId }, include: { variants: true, modifierGroups: { include: { group: { include: { options: true } } } } } })) {
    items.set(i.name, { id: i.id, variants: new Map(i.variants.map((v) => [v.name, v.id])), options: new Map(i.modifierGroups.flatMap((g) => g.group.options.map((o) => [o.name, o.id] as const))) });
  }
  manager = await ctxFor("cafe.manager@demo.local");
  cashier = await ctxFor("cafe.cashier@demo.local");
  chef = await ctxFor("cafe.chef@demo.local");
  owner = await ctxFor("cafe.owner@demo.local");
});

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await emu.stop();
  await prisma.$disconnect();
});

describe("Coders' Cafe dataset", () => {
  it("is the board menu: every category, item, price and size, priced by the server", async () => {
    const menu = await guestMenu(table07);
    expect(menu.restaurant.name).toBe("Coders' Cafe");
    expect(menu.table.code).toBe("T07");
    expect(menu.menu).toHaveLength(menuItemCount());
    for (const cat of CODERS_CAFE_MENU) {
      for (const it of cat.items) {
        const m = menu.menu.find((x) => x.name === it.name)!;
        expect(m, it.name).toBeTruthy();
        expect(m.category?.name).toBe(cat.name);
        expect(m.price).toBe(it.price);
        expect(m.isVeg).toBe(it.isVeg);
        expect(m.variants.map((v) => [v.name, it.price + v.priceDelta]).sort()).toEqual((it.sizes ?? []).map((s) => [s.name, s.price]).sort());
      }
    }
    expect(menu.payment).toMatchObject({ online: true, testMode: false, mode: "MOCK" }); // emulated gateway, labelled as such
  });

  it("tables T01–T10 resolve to the cafe's own outlet; the seed is deterministic", async () => {
    for (const t of cafe.tables) expect(t.token).toBe(cafeTableToken(t.code));
    const t = await resolveTable(table07);
    expect(t.outlet.id).toBe(cafe.outletId);
    expect(t.ctx.organizationId).toBe(cafe.organizationId);
  });
});

describe("Razorpay through the guest QR flow", () => {
  it("success: one Razorpay order for the server's amount, verified capture, PAID, one KOT, kitchen, invoice, analytics", async () => {
    const placed = await placeGuestOrder(table07, investorCart(), key());
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    // (160 + 60) + 2 × 110 = 440, GST 5% = 22.00
    expect(view.bill).toMatchObject({ subtotal: "440.00", total: "462.00", balanceDue: "462.00" });
    expect(view.bill.lines.map((l) => l.name)).toEqual(["Classic Margherita Pizza (Medium)", "Classic Fries (Large)"]);

    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(start).toMatchObject({ provider: "razorpay", amount: "462.00", checkout: { provider: "razorpay", keyId: emu.cfg.keyId, amount: 46200, currency: "INR" } });
    const rzpOrder = emu.orders.get(String(start.checkout!.orderId))!;
    expect(rzpOrder.amount).toBe(46200);
    // A refresh mid-checkout resumes the same gateway order (with the public key to reopen it).
    const again = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(again.paymentId).toBe(start.paymentId);
    expect(again.checkout).toMatchObject({ orderId: rzpOrder.id, keyId: emu.cfg.keyId });
    expect(emu.calls.filter((c) => c.method === "POST" && c.path === "/orders")).toHaveLength(1);

    const { payment, response } = emu.attempt(rzpOrder.id, "captured");
    const confirmed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: response! });
    expect(confirmed).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID", pending: false });
    // Razorpay's own webhook for the same capture changes nothing.
    expect(await sendWebhook(emu.webhook("payment.captured", payment.id))).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(await sendWebhook(emu.webhook("payment.captured", payment.id))).toMatchObject({ status: "DUPLICATE" });
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });

    // The manager sees the same order; the kitchen gets the same items as a KOT.
    const kots = await listKOTs(prisma, chef, { outletId: cafe.outletId });
    const kot = kots.find((k) => k.orderId === placed.orderId)!;
    expect(kot.items.map((i) => [i.name, num(i.qty)])).toEqual([["Classic Margherita Pizza (Medium)", 1], ["Classic Fries (Large)", 2]]);
    for (const s of ["ACCEPTED", "PREPARING", "READY", "SERVED"] as const) await updateKOTStatus(chef, kot.id, s);
    await expect(updateKOTStatus(chef, kot.id, "PREPARING")).rejects.toThrow(); // invalid transition
    await expect(updateKOTStatus(cashier, kot.id, "SERVED")).rejects.toThrow();

    const bill = await getOrderBill(prisma, manager, placed.orderId);
    expect(bill).toMatchObject({ total: "462.00", paid: "462.00", balanceDue: "0.00", paymentStatus: "PAID", table: "T07" });
    expect(bill.payments).toEqual([expect.objectContaining({ method: "ONLINE", status: "SUCCESS", amount: "462.00" })]);
    const inv = await prisma.taxInvoice.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(num(inv.total)).toBe(462);
    expect(inv.number).toMatch(/^CC\//);

    const range = { outletId: cafe.outletId, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) };
    const byMethod = await paymentsByMethod(prisma, owner, range);
    expect(byMethod.find((r) => r.method === "ONLINE")?.amount).toBeGreaterThanOrEqual(462);
    expect((await salesSummary(prisma, owner, range)).orders).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: start.paymentId, action: "PAYMENT" } })).toBe(1);
  });

  it("decline, then a retry inside the same checkout is captured: the payment recovers, nothing doubles", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Loaded Chicken Nachos").id, qty: 1 }] }, key()); // 160 + 8 = 168
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const orderRef = String(start.checkout!.orderId);
    const declined = emu.attempt(orderRef, "failed");
    expect(await sendWebhook(emu.webhook("payment.failed", declined.payment.id))).toMatchObject({ status: "PROCESSED" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("FAILED");
    // Same Razorpay window, second attempt succeeds.
    const ok = emu.attempt(orderRef, "captured");
    const confirmed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: ok.response! });
    expect(confirmed).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID" });
    expect(await sendWebhook(emu.webhook("payment.captured", ok.payment.id))).toMatchObject({ ok: true });
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(1);
  });

  it("window closed before paying: the payment stays PENDING (not failed) and a late capture settles it via webhook", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Simply Veg").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const closed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId });
    expect(closed).toMatchObject({ paymentStatus: "PENDING", pending: true, status: "OPEN", canPay: true, pendingPaymentId: start.paymentId });
    expect(await prisma.notification.count({ where: { type: "PAYMENT_FAILED", body: { contains: placed.orderId.slice(-6).toUpperCase() } } })).toBe(0);
    // Paid later (e.g. the UPI app confirmed after the tab closed): only the webhook arrives.
    const late = emu.attempt(String(start.checkout!.orderId), "captured");
    expect(await sendWebhook(emu.webhook("payment.captured", late.payment.id))).toMatchObject({ status: "PROCESSED" });
    const v = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(v.status).toBe("PAID");
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });
  });

  it("authorized but not yet captured is pending; the capture webhook completes it", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Corn Special").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const auth = emu.attempt(String(start.checkout!.orderId), "authorized");
    expect(await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: auth.response! })).toMatchObject({ paymentStatus: "PENDING", pending: true });
    // A capture event that Razorpay's API does not show yet is retried, not applied.
    expect(await sendWebhook(emu.webhook("payment.captured", auth.payment.id))).toMatchObject({ status: "FAILED", httpStatus: 503 });
    emu.capture(auth.payment.id);
    expect(await sendWebhook(emu.webhook("payment.captured", auth.payment.id))).toMatchObject({ status: "PROCESSED" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("PAID");
  });

  it("forged, tampered and foreign webhooks change nothing", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Farmpizza").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const p = emu.attempt(String(start.checkout!.orderId), "captured");
    expect(await sendWebhook(emu.webhook("payment.captured", p.payment.id, { secret: "not-the-secret" }))).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    expect(await sendWebhook(emu.webhook("payment.captured", p.payment.id, { amount: 100 }))).toMatchObject({ status: "FAILED", reason: "Amount mismatch" });
    expect(await sendWebhook(emu.webhook("payment.captured", p.payment.id, { accountId: "acc_nobody" }))).toMatchObject({ status: "FAILED", reason: "Unknown integration account" });
    const malformed = await receiveWebhook({ kind: "PAYMENT", provider: "razorpay", rawBody: "{not json", signature: "x" });
    expect(malformed.ok).toBe(false);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("PENDING");
    // A forged checkout response (bad signature) is not a success.
    const forged = { ...p.response!, razorpay_signature: "0".repeat(64) };
    expect((await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: forged })).paymentStatus).toBe("FAILED");
    // ...and cannot point verification at another gateway order.
    await expect(confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, providerRef: "order_someone_else", gateway: p.response! })).rejects.toThrow(/does not match/);
    // The genuine capture still lands (recovery asks Razorpay, not the client).
    expect(await sendWebhook(emu.webhook("payment.captured", p.payment.id))).toMatchObject({ status: "PROCESSED" });
    expect(await counts(placed.orderId)).toMatchObject({ success: 1, kots: 1, invoices: 1 });
  });

  it("a capture for an order already paid in cash is surfaced for refund, never applied twice", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Chicken Nuggets").id, qty: 1 }] }, key()); // 150 + 7.50
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    await submitOrder(manager, placed.orderId);
    const cash = await createPayment(cashier, placed.orderId, { method: "CASH", amount: 157.5 });
    expect((await verifyPayment(cashier, cash.id)).orderSettled).toBe(true);
    const late = emu.attempt(String(start.checkout!.orderId), "captured");
    expect(await sendWebhook(emu.webhook("payment.captured", late.payment.id))).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).toMatchObject({ status: "FAILED" });
    expect(await prisma.payment.count({ where: { orderId: placed.orderId, status: "SUCCESS" } })).toBe(1);
    const anomaly = await prisma.anomaly.findFirstOrThrow({ where: { organizationId: cafe.organizationId, entityType: "Payment", entityId: start.paymentId } });
    expect(anomaly).toMatchObject({ type: "RECONCILIATION_MISMATCH", severity: "HIGH", status: "OPEN" });
    expect(anomaly.message).toMatch(/Refund the guest/);
    // Redelivery does not raise it twice.
    expect(await sendWebhook(emu.webhook("payment.captured", late.payment.id))).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.anomaly.count({ where: { entityType: "Payment", entityId: start.paymentId } })).toBe(1);
  });
});

describe("Coders' Cafe isolation and table QR control", () => {
  it("another restaurant's staff cannot read or settle the cafe's orders", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Classic Fries").id, qty: 1 }] }, key());
    const other = await prisma.organization.create({ data: { name: `Other ${RUN}` } });
    const otherOutlet = await prisma.outlet.create({ data: { organizationId: other.id, code: `OT${RUN}`, name: "Other" } });
    const intruder: AccessContext = { userId: `intr-${RUN}`, organizationId: other.id, outletIds: [otherOutlet.id], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
    await expect(getOrderBill(prisma, intruder, placed.orderId)).rejects.toThrow(/not found/i);
    await expect(createPayment(intruder, placed.orderId, { method: "CASH", amount: 89.25 })).rejects.toThrow(/not found/i);
    await expect(submitOrder(intruder, placed.orderId)).rejects.toThrow();
    await expect(getGuestOrder(placed.orderId, "wrong-key")).rejects.toThrow(/not found/i);
  });

  it("revoking a table's QR disables ordering there at once; other tables keep working", async () => {
    const t03 = cafe.tables.find((t) => t.code === "T03")!;
    await expect(revokeTableQr(cashier, t03.id)).rejects.toThrow(); // outlet.manage only
    await revokeTableQr(manager, t03.id);
    await expect(guestMenu(t03.token)).rejects.toThrow(/not valid/);
    await expect(placeGuestOrder(t03.token, { items: [{ menuItemId: item("Classic Fries").id, qty: 1 }] }, key())).rejects.toThrow(/not valid/);
    expect((await guestMenu(table07)).table.code).toBe("T07");
    expect(await prisma.auditLog.count({ where: { entityType: "RestaurantTable", entityId: t03.id, action: "UPDATE" } })).toBeGreaterThanOrEqual(1);
  });
});
