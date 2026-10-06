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
import { listMenu, priceMenuSelection } from "@/server/services/menu";
import { calculateOrderTotals, placeOrder } from "@/server/services/orders";
import { upsertCustomerByPhone } from "@/server/services/crm";
import type { Tx } from "@/server/services/_workflow";
import { formatClock, formatHours, hasHours, isOpenAt } from "@/domain/openingHours";
import { guestTracker, type GuestTracker } from "@/domain/orderProgress";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { buildBill, billOrderInclude, loadBillVenue, orderRef, type Bill } from "@/server/services/bill";
import { getOrderInvoices } from "@/server/services/invoicing";
import { getPaymentProvider, type IntegrationMode } from "@/integrations/payment";
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
  outlet: { id: string; organizationId: string; name: string; address: string | null; phone: string | null; currency: string; timezone: string; openTime: string | null; closeTime: string | null };
  restaurantName: string;
};

export async function resolveTable(token: string, db: PrismaClient = prisma): Promise<GuestTable> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new NotFoundError(BAD_QR);
  const table = await db.restaurantTable.findUnique({ where: { qrToken: token }, select: { id: true, code: true, organizationId: true, outletId: true } });
  if (!table) throw new NotFoundError(BAD_QR);
  const outlet = await db.outlet.findUnique({
    where: { id: table.outletId },
    select: { id: true, organizationId: true, name: true, address: true, phone: true, currency: true, timezone: true, openTime: true, closeTime: true, active: true, organization: { select: { name: true, legalName: true, active: true } } },
  });
  if (!outlet || !outlet.active || !outlet.organization.active || outlet.organizationId !== table.organizationId) throw new NotFoundError(BAD_QR);
  const { active: _a, organization, ...o } = outlet;
  void _a;
  return { ctx: systemContext(outlet.organizationId, [outlet.id]), table: { id: table.id, code: table.code }, outlet: o, restaurantName: organization.legalName || organization.name };
}

// ---------------- payment availability ----------------

/**
 * online: a gateway is configured and reachable. testMode: the in-process
 * development gateway (MOCK — no gateway at all). mode: what the gateway is —
 * SANDBOX = Razorpay test mode (no real money), LIVE = real money.
 */
export type GuestPaymentOptions = { online: boolean; testMode: boolean; mode: IntegrationMode | null };

const OFFLINE: GuestPaymentOptions = { online: false, testMode: false, mode: null };
/** A real gateway's health check is a network call: every menu load and order poll would otherwise make one. */
const HEALTH_TTL_MS = 30_000;
let health: { key: string; at: number; ok: boolean } | null = null;

/**
 * Online payment is offered only when a gateway is configured and usable.
 * Menu loads and order polls use a recent health result; starting a payment
 * (`fresh`) always asks the gateway, so a payment is never begun while it is down.
 */
export async function guestPaymentOptions(opts: { fresh?: boolean } = {}): Promise<GuestPaymentOptions> {
  let gw: ReturnType<typeof getPaymentProvider>;
  try {
    gw = getPaymentProvider();
  } catch {
    return OFFLINE;
  }
  const key = `${gw.name}:${gw.mode}`;
  let ok: boolean;
  if (!opts.fresh && gw.name !== "mock" && health?.key === key && Date.now() - health.at < HEALTH_TTL_MS) ok = health.ok;
  else {
    ok = await gw.healthCheck().catch(() => false);
    if (gw.name !== "mock") health = { key, at: Date.now(), ok };
  }
  return ok ? { online: true, testMode: gw.name === "mock", mode: gw.mode } : OFFLINE;
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
    restaurant: {
      name: t.restaurantName,
      outletName: t.outlet.name,
      address: t.outlet.address,
      phone: t.outlet.phone,
      currency: t.outlet.currency,
      // Only what the restaurant has entered in RESTORA (Admin → Outlets); null = not configured.
      hours: hasHours(t.outlet) ? { open: t.outlet.openTime, close: t.outlet.closeTime, label: formatHours(t.outlet) } : null,
    },
    table: { code: t.table.code },
    ordering: orderingStatus(t),
    menu,
    payment: await guestPaymentOptions(),
  };
}

// ---------------- ordering availability ----------------

export type OrderingStatus = { open: boolean; message: string | null };

/** Orders are accepted inside the outlet's opening hours; an outlet without hours is always open. */
export function orderingStatus(t: Pick<GuestTable, "outlet">, now: Date = new Date()): OrderingStatus {
  if (isOpenAt(t.outlet, now)) return { open: true, message: null };
  const opens = formatClock(t.outlet.openTime);
  return { open: false, message: `We're closed right now${opens ? ` — ordering opens at ${opens}` : ""}. You can still browse the menu.` };
}

// ---------------- server pricing of a cart ----------------

const NOT_ON_MENU = "This item is no longer on the menu";

type GuestLineInput = { menuItemId: string; variantId?: string; modifierOptionIds?: string[]; qty: number };
export type GuestPricedLine =
  | { index: number; ok: true; menuItemId: string; name: string; unitPrice: string; modifiers: Array<{ name: string; priceDelta: string }>; modifiersPerUnit: string; taxPct: string; qty: number; lineTotal: string }
  | { index: number; ok: false; menuItemId: string; reason: string; notFound?: true };

/**
 * Price every line exactly as order placement will (menu.priceMenuSelection:
 * outlet price override, variant, modifier rules, sold-out / not offered) —
 * read-only. A line that cannot be ordered carries the reason instead of a price.
 */
async function priceGuestLines(db: PrismaClient, t: GuestTable, items: GuestLineInput[]): Promise<GuestPricedLine[]> {
  const out: GuestPricedLine[] = [];
  for (const [index, it] of items.entries()) {
    try {
      // Reads only (menu item, variants, groups, outlet override): no transaction needed.
      const p = await priceMenuSelection(db as unknown as Tx, t.ctx, { menuItemId: it.menuItemId, variantId: it.variantId, modifierOptionIds: it.modifierOptionIds?.length ? it.modifierOptionIds : undefined, outletId: t.outlet.id });
      const modsPerUnit = p.modifiers.reduce((a, m) => a.plus(m.priceDelta), D(0));
      const line = calculateOrderTotals([{ qty: it.qty, unitPrice: p.unitPrice, modifiersPerUnit: modsPerUnit, taxPct: p.taxPct }]);
      out.push({
        index,
        ok: true,
        menuItemId: p.menuItemId,
        name: p.name,
        unitPrice: money(p.unitPrice).toFixed(2),
        modifiers: p.modifiers.map((m) => ({ name: m.name, priceDelta: money(m.priceDelta).toFixed(2) })),
        modifiersPerUnit: money(modsPerUnit).toFixed(2),
        taxPct: D(p.taxPct).toString(),
        qty: it.qty,
        lineTotal: line.subtotal.toFixed(2),
      });
    } catch (e) {
      if (e instanceof NotFoundError) out.push({ index, ok: false, menuItemId: it.menuItemId, reason: NOT_ON_MENU, notFound: true });
      else if (e instanceof ValidationError) out.push({ index, ok: false, menuItemId: it.menuItemId, reason: e.message });
      else throw e;
    }
  }
  return out;
}

const quoteSchema = z.object({ items: z.array(z.lazy(() => guestItem)).min(1, "Your cart is empty").max(30) }).strict();

export type GuestQuote = {
  lines: GuestPricedLine[];
  /** Totals of the lines that can be ordered, by the same function that prices orders and invoices. */
  subtotal: string;
  tax: string;
  taxes: Array<{ ratePct: string; amount: string }>;
  total: string;
  allAvailable: boolean;
  ordering: OrderingStatus;
};

/**
 * The cart as the server would price it right now. Nothing is created; the
 * order total is still computed again when the order is placed.
 */
export async function quoteGuestCart(token: string, input: unknown, db: PrismaClient = prisma): Promise<GuestQuote> {
  const data = quoteSchema.parse(input);
  const t = await resolveTable(token, db);
  const lines = await priceGuestLines(db, t, data.items);
  const okLines = lines.filter((l): l is Extract<GuestPricedLine, { ok: true }> => l.ok);
  const totals = calculateOrderTotals(okLines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct })));
  return {
    // `notFound` is internal (placement keeps answering 404 for a dish that is not this restaurant's).
    lines: lines.map((l) => (l.ok ? l : { index: l.index, ok: false as const, menuItemId: l.menuItemId, reason: l.reason })),
    subtotal: totals.subtotal.toFixed(2),
    tax: totals.tax.toFixed(2),
    taxes: totals.byRate.map((r) => ({ ratePct: r.ratePct.toString(), amount: r.tax.toFixed(2) })),
    total: totals.total.toFixed(2),
    allAvailable: okLines.length === lines.length,
    ordering: orderingStatus(t),
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

/** Indian mobile numbers as typed ("98765 43210", "+91-98765-43210") → "9876543210"; other countries keep their digits (+ prefix). */
export function normalizeGuestPhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, "");
  const india = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(compact);
  return india ? india[1] : compact;
}

const guestCustomer = z
  .object({
    /** Shown to the staff with the order (and kept on the CRM record when a phone is given). */
    name: z.string().trim().max(60, "Name is too long").optional(),
    /** Optional. With a phone the order is linked to the restaurant's customer record (find-or-create; an existing record is never overwritten). */
    phone: z
      .string()
      .trim()
      .max(20)
      .transform(normalizeGuestPhone)
      .refine((p) => /^\+?\d{10,15}$/.test(p), "Enter a valid mobile number")
      .optional(),
  })
  .strict();

const guestOrderSchema = z
  .object({
    items: z.array(guestItem).min(1, "Your cart is empty").max(30),
    notes: z.string().trim().max(300).optional(),
    customer: guestCustomer.optional(),
    /** How the guest says they will pay. Informational for the staff; payment itself is verified separately. */
    paymentMethod: z.enum(["CASH", "ONLINE"]).optional(),
  })
  .strict();
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
    const ordering = orderingStatus(t);
    if (!ordering.open) throw new ValidationError(ordering.message!);
    // Every line is checked (and priced) before anything is created, so a sold-out
    // item never leaves a half-made order or a stray customer record behind.
    const bad = (await priceGuestLines(db, t, data.items)).find((l) => !l.ok);
    if (bad && !bad.ok) {
      // Unknown / another restaurant's dish: the same 404 as before (no oracle); unavailable: 422 with the reason.
      if (bad.notFound) throw new NotFoundError("Menu item not found");
      throw new ValidationError(`Item ${bad.index + 1}: ${bad.reason}. Please update your cart.`);
    }
  }
  const guestName = data.customer?.name || undefined;
  // A phone links the order to the restaurant's CRM (find-or-create; a known customer's
  // name is never changed). The guest's response never reveals whether the number was known.
  const customerId = data.customer?.phone ? (await upsertCustomerByPhone(t.ctx, { name: guestName ?? "Guest", phone: data.customer.phone }, db)).id : undefined;
  const order = await placeOrder(t.ctx, {
    outletId: t.outlet.id,
    channel: "QR",
    source: "QR",
    tableId: t.table.id,
    customerId,
    covers: 1,
    notes: data.notes || undefined,
    idempotencyKey: scopedKey,
    items: data.items.map((i) => ({ menuItemId: i.menuItemId, variantId: i.variantId, modifierOptionIds: i.modifierOptionIds?.length ? i.modifierOptionIds : undefined, qty: i.qty, notes: i.notes || undefined })),
    submit: false,
  }, db);
  if (!order.replayed) {
    const pays = data.paymentMethod === "ONLINE" ? "paying online" : data.paymentMethod === "CASH" ? "pays at the counter" : null;
    await db.$transaction(async (tx) => {
      await writeAudit(tx, t.ctx, { action: "CREATE", entityType: "Order", entityId: order.id, outletId: t.outlet.id, after: { via: "guest-qr", table: t.table.code, total: money(order.total).toString(), ...(guestName ? { guestName } : {}), ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}) }, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 200) });
      // Staff (POS / captain alert centre) learn about the waiting order in-app.
      await createNotificationTx(tx, t.ctx, { outletId: t.outlet.id, type: "NEW_ORDER", title: `New QR order · table ${t.table.code}`, body: [`${orderRef(order.id)} · ₹${money(order.total).toFixed(2)} — waiting to be accepted`, guestName, pays].filter(Boolean).join(" · ") });
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
  /** Customer tracker (received → kitchen accepted → preparing → ready → served), from the KOTs. */
  tracker: GuestTracker;
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
    tracker: guestTracker(order),
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
  const options = await guestPaymentOptions({ fresh: true });
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
    // Resuming (refresh mid-payment): reopen the same gateway checkout, never a second gateway order.
    if (!checkout && providerRef) checkout = gateway.resumeCheckout?.({ providerRef, amount: num(payment.amount), currency: "INR" });
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

/**
 * Confirm a payment with the gateway. Outcome is decided by the provider +
 * payment service, never by this request. Without a checkout response this is
 * a status check ("I closed the window — did it go through?"): an undecided
 * payment stays PENDING (`pending`), it is not failed.
 */
export async function confirmGuestPayment(orderId: string, key: string | null | undefined, input: unknown, db: PrismaClient = prisma): Promise<GuestOrderView & { paymentStatus: string; pending: boolean }> {
  const data = confirmSchema.parse(input);
  const order = await loadGuestOrder(orderId, key, db);
  const payment = order.payments.find((p) => p.id === data.paymentId);
  if (!payment || payment.method !== "ONLINE" || payment.actorId) throw new NotFoundError("Payment not found");
  const ctx = systemContext(order.organizationId, [order.outletId]);
  const res = await verifyPayment(ctx, payment.id, { providerRef: data.providerRef, payload: data.gateway }, db);
  return { ...(await getGuestOrder(orderId, key, db)), paymentStatus: res.payment.status, pending: Boolean(res.pending) };
}
