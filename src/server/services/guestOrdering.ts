/**
 * Guest (customer) QR ordering: scan a table's QR -> menu -> cart -> order ->
 * online payment -> live status -> digital receipt.
 *
 * Trust model — the browser is anonymous and untrusted:
 *  - Tenant context comes ONLY from the table's QR token, resolved here on the
 *    server (table -> outlet -> organization, all active). A browser never
 *    names an organization, outlet or table id.
 *  - Lines are priced by the menu (orders.placeOrder -> menu.priceMenuSelection);
 *    the guest item schema is strict, so a client price/total is rejected.
 *  - An order is reachable only with its access key: an HMAC of the order id
 *    under a server secret (stateless; no extra column). The key is returned
 *    once, when the order is placed, and travels in a request header.
 *  - Payments use the existing payment service: a PENDING payment for the
 *    server-computed outstanding balance, made SUCCESS only by gateway
 *    verification (payment.verifyPayment, with its balance/concurrency rules).
 *  - Guest orders arrive OPEN: staff accept them at the POS (submitOrder ->
 *    KOT), or a verified prepayment sends them to the kitchen.
 *
 * Services run with a system context scoped to the resolved outlet (the same
 * pattern as webhooks); every input that reaches them is fixed here.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { DEV_AUTH_SECRET_PLACEHOLDER } from "@/server/config/env";
import { writeAudit } from "@/server/audit/log";
import { createNotificationTx } from "@/server/services/notifications";
import { listMenu } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { buildBill, billOrderInclude, loadBillVenue, orderRef, type Bill } from "@/server/services/bill";
import { getOrderInvoices } from "@/server/services/invoicing";
import { getPaymentProvider } from "@/integrations/payment";
import { D, money, num } from "@/domain/money";
import { FULFILMENT_LABEL } from "@/domain/orderProgress";

// ---------------- access keys ----------------

let hmacKey: Buffer | null = null;
function accessHmacKey(): Buffer {
  if (hmacKey) return hmacKey;
  const material = process.env.AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : DEV_AUTH_SECRET_PLACEHOLDER);
  if (!material) throw new Error("AUTH_SECRET is required for guest order access keys");
  hmacKey = Buffer.from(hkdfSync("sha256", material, "aharos", "guest-order-access/v1", 32));
  return hmacKey;
}

/** The capability that lets a guest read / pay one order. */
export function guestOrderKey(orderId: string): string {
  return createHmac("sha256", accessHmacKey()).update(`order:${orderId}`).digest("base64url");
}

function keyMatches(orderId: string, key: string | null | undefined): boolean {
  if (!key || key.length > 128) return false;
  const expected = Buffer.from(guestOrderKey(orderId));
  const given = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------- table resolution ----------------

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
// One message for every failure: no oracle for which tables/outlets exist.
const BAD_QR = "This table QR code is not valid. Please ask the staff for help.";

export type GuestTable = {
  ctx: AccessContext;
  table: { id: string; code: string };
  outlet: { id: string; organizationId: string; name: string; address: string | null; phone: string | null; currency: string; timezone: string };
  restaurantName: string;
};

export async function resolveTable(token: string, db: PrismaClient = prisma): Promise<GuestTable> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new NotFoundError(BAD_QR);
  const table = await db.restaurantTable.findUnique({ where: { qrToken: token }, select: { id: true, code: true, organizationId: true, outletId: true } });
  if (!table) throw new NotFoundError(BAD_QR);
  const outlet = await db.outlet.findUnique({
    where: { id: table.outletId },
    select: { id: true, organizationId: true, name: true, address: true, phone: true, currency: true, timezone: true, active: true, organization: { select: { name: true, legalName: true, active: true } } },
  });
  if (!outlet || !outlet.active || !outlet.organization.active || outlet.organizationId !== table.organizationId) throw new NotFoundError(BAD_QR);
  const { active: _a, organization, ...o } = outlet;
  void _a;
  return { ctx: systemContext(outlet.organizationId, [outlet.id]), table: { id: table.id, code: table.code }, outlet: o, restaurantName: organization.legalName || organization.name };
}

// ---------------- payment availability ----------------

export type GuestPaymentOptions = { online: boolean; testMode: boolean };

/** Online payment is offered only when a gateway is configured and usable. */
export async function guestPaymentOptions(): Promise<GuestPaymentOptions> {
  try {
    const gw = getPaymentProvider();
    return (await gw.healthCheck()) ? { online: true, testMode: gw.name === "mock" } : { online: false, testMode: false };
  } catch {
    return { online: false, testMode: false };
  }
}

// ---------------- menu ----------------

/** The guest menu: what the table's outlet offers, at its prices — no admin fields. */
export async function guestMenu(token: string, db: PrismaClient = prisma) {
  const t = await resolveTable(token, db);
  // With an outletId, listMenu returns the outlet's effective price / sold-out per item.
  type Effective = { effectivePrice: number; effectiveSoldOut: boolean };
  const items = (await listMenu(db, t.ctx, { outletId: t.outlet.id, activeOnly: true })) as Array<Awaited<ReturnType<typeof listMenu>>[number] & Effective>;
  const menu = items.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    isVeg: i.isVeg,
    categoryId: i.categoryId,
    category: i.category,
    price: i.effectivePrice,
    effectivePrice: i.effectivePrice,
    taxPct: num(i.taxPct),
    station: i.station,
    active: true,
    offered: true,
    soldOut: i.effectiveSoldOut,
    effectiveSoldOut: i.effectiveSoldOut,
    variants: i.variants.map((v) => ({ id: v.id, name: v.name, priceDelta: num(v.priceDelta), active: v.active })),
    modifierGroups: i.modifierGroups
      .filter((l) => l.group.active)
      .map((l) => ({ group: { id: l.group.id, name: l.group.name, minSelect: l.group.minSelect, maxSelect: l.group.maxSelect, active: true, options: l.group.options.map((o) => ({ id: o.id, name: o.name, priceDelta: num(o.priceDelta), active: o.active })) } })),
  }));
  return {
    restaurant: { name: t.restaurantName, outletName: t.outlet.name, address: t.outlet.address, currency: t.outlet.currency },
    table: { code: t.table.code },
    menu,
    payment: await guestPaymentOptions(),
  };
}

// ---------------- placing an order ----------------

const guestItem = z
  .object({
    menuItemId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).optional(),
    modifierOptionIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    qty: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(50, "At most 50 of one item"),
    notes: z.string().trim().max(200).optional(),
  })
  .strict(); // a client price, tax or total is refused, not ignored

const guestOrderSchema = z.object({ items: z.array(guestItem).min(1, "Your cart is empty").max(30), notes: z.string().trim().max(300).optional() }).strict();
const idemKey = z.string().trim().min(8).max(64).regex(/^[\w.:-]+$/, "Invalid idempotency key");

/** Unaccepted guest orders a table may have waiting at once (a QR is a public link). */
export const MAX_WAITING_GUEST_ORDERS = 3;

export type ClientMeta = { ip?: string; userAgent?: string };

export async function placeGuestOrder(token: string, input: unknown, idempotencyKey: unknown, meta: ClientMeta = {}, db: PrismaClient = prisma) {
  const key = idemKey.parse(idempotencyKey);
  const data = guestOrderSchema.parse(input);
  const t = await resolveTable(token, db);
  // Namespaced per table: a key can only ever replay an order of this table.
  const scopedKey = `qr:${t.table.id}:${key}`;
  const existing = await db.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: t.ctx.organizationId, idempotencyKey: scopedKey } }, select: { id: true } });
  if (!existing) {
    const waiting = await db.order.count({ where: { organizationId: t.ctx.organizationId, tableId: t.table.id, source: "QR", status: "OPEN" } });
    if (waiting >= MAX_WAITING_GUEST_ORDERS) throw new ValidationError("Several orders from this table are waiting for the restaurant to accept them. Please wait, or ask the staff.");
  }
  const order = await placeOrder(t.ctx, {
    outletId: t.outlet.id,
    channel: "QR",
    source: "QR",
    tableId: t.table.id,
    covers: 1,
    notes: data.notes || undefined,
    idempotencyKey: scopedKey,
    items: data.items.map((i) => ({ menuItemId: i.menuItemId, variantId: i.variantId, modifierOptionIds: i.modifierOptionIds?.length ? i.modifierOptionIds : undefined, qty: i.qty, notes: i.notes || undefined })),
    submit: false,
  }, db);
  if (!order.replayed) {
    await db.$transaction(async (tx) => {
      await writeAudit(tx, t.ctx, { action: "CREATE", entityType: "Order", entityId: order.id, outletId: t.outlet.id, after: { via: "guest-qr", table: t.table.code, total: money(order.total).toString() }, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 200) });
      // Staff (POS / captain alert centre) learn about the waiting order in-app.
      await createNotificationTx(tx, t.ctx, { outletId: t.outlet.id, type: "NEW_ORDER", title: `New QR order · table ${t.table.code}`, body: `${orderRef(order.id)} · ₹${money(order.total).toFixed(2)} — waiting to be accepted` });
    });
  }
  return { orderId: order.id, ref: orderRef(order.id), accessKey: guestOrderKey(order.id), replayed: Boolean(order.replayed) };
}

// ---------------- the guest's view of an order ----------------

async function loadGuestOrder(orderId: string, key: string | null | undefined, db: PrismaClient) {
  if (typeof orderId !== "string" || orderId.length > 64 || !keyMatches(orderId, key)) throw new NotFoundError("Order not found");
  const order = await db.order.findUnique({ where: { id: orderId }, include: billOrderInclude });
  if (!order || order.source !== "QR") throw new NotFoundError("Order not found");
  return order;
}

export type GuestOrderView = {
  orderId: string;
  ref: string;
  status: string;
  fulfilment: Bill["fulfilment"];
  fulfilmentLabel: string;
  bill: Bill;
  canPay: boolean;
  payment: GuestPaymentOptions;
  pendingPaymentId: string | null;
};

async function viewOf(order: Awaited<ReturnType<typeof loadGuestOrder>>, db: PrismaClient): Promise<GuestOrderView> {
  const bill = buildBill(order, await loadBillVenue(db, order.organizationId, order.outletId), await getOrderInvoices(db, order.id));
  const payment = await guestPaymentOptions();
  const pending = order.payments.filter((p) => p.status === "PENDING" && p.method === "ONLINE" && !p.actorId).at(-1);
  return {
    orderId: order.id,
    ref: orderRef(order.id),
    status: order.status,
    fulfilment: bill.fulfilment,
    fulfilmentLabel: FULFILMENT_LABEL[bill.fulfilment],
    bill,
    canPay: payment.online && !["PAID", "CANCELLED", "REFUNDED"].includes(order.status) && D(bill.balanceDue).gt(0),
    payment,
    pendingPaymentId: pending?.id ?? null,
  };
}

export async function getGuestOrder(orderId: string, key: string | null | undefined, db: PrismaClient = prisma): Promise<GuestOrderView> {
  return viewOf(await loadGuestOrder(orderId, key, db), db);
}

// ---------------- paying ----------------

/**
 * Start an online payment for the outstanding balance (computed here). A
 * refresh during checkout resumes the guest's open PENDING payment for the same
 * amount instead of creating another; a new attempt after a decline is a new
 * payment. Retries with the same Idempotency-Key return the same payment.
 */
export async function startGuestPayment(orderId: string, key: string | null | undefined, idempotencyKey: unknown, db: PrismaClient = prisma) {
  const idem = idemKey.parse(idempotencyKey);
  const order = await loadGuestOrder(orderId, key, db);
  if (["PAID", "CANCELLED", "REFUNDED"].includes(order.status)) throw new ValidationError(`This order is already ${order.status.toLowerCase()}`);
  const options = await guestPaymentOptions();
  if (!options.online) throw new ValidationError("Online payment is not available here. Please pay at the counter.");
  const gateway = getPaymentProvider();
  const collected = order.payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL").reduce((a, p) => a.plus(D(p.amount)), D(0));
  const outstanding = money(D(order.total).minus(collected));
  if (outstanding.lte(0)) throw new ValidationError("Nothing is due on this order");

  const ctx = systemContext(order.organizationId, [order.outletId]);
  const resumable = order.payments.find((p) => p.status === "PENDING" && p.method === "ONLINE" && p.provider === gateway.name && !p.actorId && D(p.amount).eq(outstanding));
  const payment = resumable ?? (await createPayment(ctx, order.id, { method: "ONLINE", amount: num(outstanding), provider: gateway.name, idempotencyKey: `qrpay:${order.id.slice(-12)}:${idem}` }, db));
  // Gateway-side checkout for the SERVER's amount (the Payment row), created outside any DB
  // transaction. A failure leaves the payment PENDING without a reference; the next attempt
  // resumes it. A payment that already has its checkout keeps it (no second gateway order).
  let checkout: Record<string, string | number> | undefined;
  if (gateway.createCheckout) {
    let providerRef = payment.providerRef;
    if (!providerRef) {
      const session = await gateway.createCheckout({ paymentId: payment.id, orderId: order.id, amount: num(payment.amount), currency: "INR" });
      const claimed = await db.payment.updateMany({ where: { id: payment.id, status: "PENDING", providerRef: null }, data: { providerRef: session.providerRef } });
      providerRef = claimed.count === 1 ? session.providerRef : (await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).providerRef;
      checkout = providerRef === session.providerRef ? session.checkout : undefined;
    }
    checkout ??= { provider: gateway.name, mode: gateway.mode, orderId: providerRef ?? "", amount: Math.round(num(payment.amount) * 100), currency: "INR" };
  }
  return { paymentId: payment.id, amount: money(payment.amount).toFixed(2), provider: gateway.name, mode: gateway.mode, testMode: options.testMode, checkout };
}

const confirmSchema = z
  .object({
    paymentId: z.string().min(1).max(64),
    /** The gateway's payment reference from its checkout (verified with the gateway, not trusted). */
    providerRef: z.string().trim().min(1).max(100).optional(),
    /** The gateway checkout's response, handed to the provider adapter for server-side verification. */
    gateway: z.record(z.string().max(512)).refine((r) => Object.keys(r).length <= 10, "Too many fields").optional(),
  })
  .strict();

/** Confirm a payment with the gateway. Outcome is decided by the provider + payment service, never by this request. */
export async function confirmGuestPayment(orderId: string, key: string | null | undefined, input: unknown, db: PrismaClient = prisma): Promise<GuestOrderView & { paymentStatus: string }> {
  const data = confirmSchema.parse(input);
  const order = await loadGuestOrder(orderId, key, db);
  const payment = order.payments.find((p) => p.id === data.paymentId);
  if (!payment || payment.method !== "ONLINE" || payment.actorId) throw new NotFoundError("Payment not found");
  const ctx = systemContext(order.organizationId, [order.outletId]);
  const res = await verifyPayment(ctx, payment.id, { providerRef: data.providerRef, payload: data.gateway }, db);
  return { ...(await getGuestOrder(orderId, key, db)), paymentStatus: res.payment.status };
}
